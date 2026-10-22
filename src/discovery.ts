import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';

import type { Logging } from 'homebridge';
import type { AgentConfig } from './types.js';
import { DEFAULT_AGENT_KEY, DEFAULT_AGENT_PORT } from './settings.js';

function randomKey() {
  return randomBytes(16).toString('hex').slice(0, 12);
}

async function agentAcceptsKey(ip: string, port: number, key: string): Promise<boolean> {
  try {
    const res = await fetch(`http://${ip}:${port}/config/read`, {
      headers: { 'Api-Key': key },
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function renameAgent(ip: string, port: number, key: string, newName: string): Promise<void> {
  const res = await fetch(`http://${ip}:${port}/config/update`, {
    method: 'POST',
    headers: { 'Api-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: newName }),
  });
  if (!res.ok) {
    throw new Error(`/config/update returned ${res.status}`);
  }
}

async function setAgentKey(ip: string, port: number, currentKey: string, newKey: string): Promise<void> {
  const res = await fetch(`http://${ip}:${port}/config/update`, {
    method: 'POST',
    headers: { 'Api-Key': currentKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: newKey }),
  });
  if (!res.ok) {
    throw new Error(`/config/update returned ${res.status}`);
  }
  if (!(await agentAcceptsKey(ip, port, newKey))) {
    throw new Error('new key was not accepted afterwards');
  }
}

/** Per-probe timeout. A Zero 2 W or a Pico misses anything much shorter. */
const PROBE_TIMEOUT = 1500;

/** Concurrent probes in flight. Bounded: a Pico serves one connection at a time. */
const BATCH = 48;

/** A found agent must not be searched for again more often than this. */
export const MIN_SEARCH_INTERVAL = 2 * 60_000;

/** After this many fruitless searches in a row, back off to LONG_SEARCH_INTERVAL. */
export const FAILURES_BEFORE_BACKOFF = 3;

/** The slow retry, once an agent looks genuinely absent rather than briefly busy. */
export const LONG_SEARCH_INTERVAL = 30 * 60_000;

/** The /24 of the interface that routes outward, found without sending anything. */
function primaryPrefix(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const s = createSocket('udp4');
    const close = () => {
      try {
        s.close();
      } catch {
        // already closed
      }
    };
    const timer = setTimeout(() => {
      close();
      resolve(undefined);
    }, 500);
    s.once('error', () => {
      clearTimeout(timer);
      close();
      resolve(undefined);
    });
    try {
      s.connect(80, '8.8.8.8', () => {
        clearTimeout(timer);
        let ip: string | undefined;
        try {
          ip = s.address().address;
        } catch {
          ip = undefined;
        }
        close();
        resolve(ip && ip !== '0.0.0.0' && !ip.startsWith('127.') ? ip.split('.').slice(0, 3).join('.') + '.' : undefined);
      });
    } catch {
      clearTimeout(timer);
      close();
      resolve(undefined);
    }
  });
}

/** Every /24 this host sits on, as `a.b.c.` prefixes, the routing one first. */
async function localSubnets(): Promise<string[]> {
  const prefixes = new Set<string>();
  const primary = await primaryPrefix();
  if (primary) {
    prefixes.add(primary);
  }
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal && address.address && !address.address.startsWith('127.')) {
        prefixes.add(address.address.split('.').slice(0, 3).join('.') + '.');
      }
    }
  }
  return [...prefixes];
}

/** `GET /hello` is unauthenticated on both agents, so a scan needs no key. */
async function probe(host: string, port: number): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT);
  try {
    const res = await fetch(`http://${host}:${port}/hello`, { signal: controller.signal });
    if (!res.ok) {
      return undefined;
    }
    const body = await res.json() as { name?: string };
    return typeof body?.name === 'string' ? body.name : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Finds an agent by name on the local network, for agents configured without an
 * address. One sweep serves every agent that is looking, so a config with five
 * unaddressed agents still costs one pass over the subnet.
 *
 * The retry policy is deliberately slow. A sweep is hundreds of requests, and an
 * agent that is switched off should not cost that every few seconds: a repeat is
 * refused inside MIN_SEARCH_INTERVAL, and after FAILURES_BEFORE_BACKOFF fruitless
 * sweeps in a row the wait becomes LONG_SEARCH_INTERVAL until one succeeds.
 */
export class AgentLocator {
  private lastSweep = 0;
  private failures = 0;
  private inFlight?: Promise<Map<string, string[]>>;

  /** name -> addresses answering to it, from the most recent sweep. */
  public found: Map<string, string[]> = new Map();

  constructor(
    private readonly log: Logging,
    private readonly rescan: number = 60,
    private readonly persistAgent?: (agent: AgentConfig) => void,
  ) {}

  /** True when a sweep is allowed to run now under the backoff rules. */
  private due(): boolean {
    const wait = this.failures >= FAILURES_BEFORE_BACKOFF ? LONG_SEARCH_INTERVAL : MIN_SEARCH_INTERVAL;
    return Date.now() - this.lastSweep >= wait;
  }

  /**
   * The address for `name`, or undefined. Sweeps at most once per interval; callers
   * that arrive during a sweep wait for it rather than starting a second one.
   *
   * `force` only bypasses the "have I swept recently" check for the very first
   * lookup, never the backoff itself.
   */
  async locate(name: string, port = DEFAULT_AGENT_PORT): Promise<string | undefined> {
    if (this.rescan === 0) {
      // rescan is 0: subnet sweep is disabled, but direct hostname resolution (e.g. name or name.local) can still be tried
      const directIp = await this.resolveHostname(name, port);
      if (directIp) {
        return directIp;
      }
      this.log.error(`[DISCOVERY] Agent '${name}' has no IP and network sweep is disabled (rescan is 0).`);
      return undefined;
    }
    if (this.due() || this.lastSweep === 0 || this.inFlight) {
      await this.sweep(port);
    }

    const hits = this.found.get(name) ?? [];
    if (hits.length === 1) {
      return hits[0];
    }
    if (hits.length === 0) {
      // Not on any swept subnet: try the name as a hostname (DNS, or name.local over mDNS).
      const directIp = await this.resolveHostname(name, port);
      if (directIp) {
        return directIp;
      }
    }
    if (hits.length > 1) {
      this.log.error(`[SECURITY] '${name}' is claimed by ${hits.length} addresses (${hits.join(', ')}) - possible cyber attack.`);

      if (!this.persistAgent) {
        this.log.error('Cannot resolve duplicate names without a writable agent list.');
        return undefined;
      }

      // Rename and re-key every board after the first that still accepts the default key,
      // so each name is unique again. A board with its own key is left alone.
      for (const ip of hits.slice(1)) {
        if (!(await agentAcceptsKey(ip, port, DEFAULT_AGENT_KEY))) {
          this.log.error(`  ${ip} does not accept the default key - cannot rename it, leaving it as '${name}'.`);
          continue;
        }
        const newName = `${name}-${ip.split('.').pop()}`;
        try {
          // Save the new identity before touching the board. A failed save must not
          // leave a renamed or re-keyed agent without local credentials.
          this.persistAgent({ name: newName, ip, port, api_key: DEFAULT_AGENT_KEY });
          await renameAgent(ip, port, DEFAULT_AGENT_KEY, newName);
          this.log.error(`  Renamed ${ip} to '${newName}'.`);
          this.found.set(newName, [ip]);
          this.found.set(name, (this.found.get(name) ?? []).filter(address => address !== ip));

          const key = randomKey();
          try {
            this.persistAgent({ name: newName, ip, port, api_key: key });
            await setAgentKey(ip, port, DEFAULT_AGENT_KEY, key);
            this.log.error(`  Rotated the key on ${ip}.`);
          } catch (e: unknown) {
            // A lost response can mean the rotation succeeded. Only restore the
            // default in storage if the board still accepts that key.
            if (await agentAcceptsKey(ip, port, DEFAULT_AGENT_KEY)) {
              this.persistAgent({ name: newName, ip, port, api_key: DEFAULT_AGENT_KEY });
            }
            this.log.error(`  Could not rotate the key on ${ip} (${(e as Error).message}).`);
          }
        } catch (e: unknown) {
          this.log.error(`  Could not rename ${ip} (${(e as Error).message}).`);
        }
      }
      // The name stays unresolved until the next sweep confirms a single address.
      return undefined;
    }
    return undefined;
  }

  /**
   * Try resolving the agent name directly as a hostname (e.g. `owl` and `owl.local`).
   * If an address resolves and answers `/hello` with the expected agent name,
   * verify against collisions, register in `this.found`, and persist the discovered IP.
   */
  private async resolveHostname(name: string, port: number): Promise<string | undefined> {
    const candidates = [name];
    if (!name.endsWith('.local')) {
      candidates.push(`${name}.local`);
    }

    for (const host of candidates) {
      try {
        const res = await lookup(host, { family: 4 });
        const ip = res.address;
        if (!ip) {
          continue;
        }

        // Probe the resolved address to verify it is running ctrlPi agent and verify its identity
        const answeredName = await probe(ip, port);
        if (answeredName === name) {
          const existing = this.found.get(name) ?? [];
          if (!existing.includes(ip)) {
            this.found.set(name, [...existing, ip]);
          }

          if (this.persistAgent) {
            this.persistAgent({ name, ip, port });
          }
          this.log.info(`[DISCOVERY] Agent '${name}' resolved via hostname '${host}' at ${ip}.`);
          return ip;
        }
      } catch {
        // Hostname does not resolve or probe failed; try next candidate
      }
    }
    return undefined;
  }

  public sweep(port: number): Promise<Map<string, string[]>> {
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = this.doSweep(port).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async doSweep(port: number): Promise<Map<string, string[]>> {
    const subnets = await localSubnets();
    if (!subnets.length) {
      this.log.warn('No LAN interface found, so agents cannot be discovered by name.');
      return this.found;
    }

    const hosts: string[] = [];
    for (const prefix of subnets) {
      for (let i = 1; i < 255; i++) {
        hosts.push(prefix + i);
      }
    }

    this.log.info(`Looking for ctrlPi agents on ${subnets.map(s => s + '0/24').join(', ')}...`);
    const started = Date.now();
    const found = new Map<string, string[]>();
    for (let i = 0; i < hosts.length; i += BATCH) {
      const batch = hosts.slice(i, i + BATCH);
      const names = await Promise.all(batch.map(h => probe(h, port)));
      names.forEach((name, n) => {
        if (name) {
          found.set(name, [...(found.get(name) ?? []), batch[n]]);
        }
      });
    }

    this.lastSweep = Date.now();
    this.found = found;
    const total = [...found.values()].reduce((n, list) => n + list.length, 0);
    if (total) {
      this.failures = 0;
      this.log.info(`Found ${total} agent(s) in ${((Date.now() - started) / 1000).toFixed(1)}s: `
        + [...found.entries()].map(([n, ips]) => `${n} (${ips.join(', ')})`).join(', '));
    } else {
      this.failures++;
      const next = this.failures >= FAILURES_BEFORE_BACKOFF ? LONG_SEARCH_INTERVAL : MIN_SEARCH_INTERVAL;
      this.log.warn(`No ctrlPi agents answered. Next search in ${Math.round(next / 60_000)} minutes.`);
    }
    return found;
  }
}
