import type { Logging } from 'homebridge';

import type { AgentLocator } from './discovery.js';
import type { AgentConfig, PinInfo } from './types.js';
import { CALLBACK_FIELD, CALLBACK_KEY_FIELD, DEFAULT_AGENT_KEY, DEFAULT_AGENT_PORT } from './settings.js';

const REQUEST_TIMEOUT = 8000;

export class AgentError extends Error {}

/**
 * True when a pin's stored config already says what `want` asks for. Compared the way
 * the agents store it: `watched` only ever as true, `max` only when nonzero, `pullup`
 * and `reversed` with their defaults, so an unchanged pin is recognised as unchanged.
 */
function pinMatches(stored: Record<string, unknown> | undefined, want: Record<string, unknown>): boolean {
  if (!stored) {
    return false;
  }
  return Object.entries(want).every(([key, value]) => {
    const have = stored[key];
    switch (key) {
    case 'watched': return (have === true) === (value === true);
    case 'reversed': return (have === true) === (value === true);
    case 'max': return Number(have || 0) === Number(value || 0);
    case 'pullup': return want.type !== 'input' || (have ?? 'up') === value;
    default: return have === value;
    }
  });
}

/**
 * REST client for one ctrlPi agent (a pi-gpio-api Pi, a pico-gpio-api Pico W or an
 * esp32-gpio-api ESP32).
 *
 * This plugin holds no GPIO logic: every read and write below is an HTTP call to
 * the agent that owns the pin, carrying that agent's own Api-Key.
 */
export class Agent {
  readonly name: string;
  private apiKey: string;
  private port: number;

  /**
   * The agent's stored pin configs (`/config/read` -> `gpios`), read once per setup pass
   * so configurePin() can leave an unchanged pin alone. Reconfiguring an output makes the
   * agent re-claim the pin, which can glitch a relay, so a Homebridge restart must not
   * touch pins whose config is already right.
   */
  private storedPins?: Record<string, Record<string, unknown>>;

  /**
   * Where this agent is. Fixed when the config gives an `ip`; otherwise found by
   * name on the local network, and cleared again the moment the agent stops
   * answering so the next call goes looking. See AgentLocator for the retry policy.
   */
  private address?: string;
  private readonly discoverable: boolean;

  /** The search in progress, shared so concurrent callers never start a second one. */
  private resolving?: Promise<string | undefined>;

  /**
   * True once this agent has echoed back both our callback URL and key. Until then
   * we are not registered for its events, so the first one that arrives triggers a
   * re-push rather than being trusted.
   */
  configured = false;

  constructor(
    cfg: AgentConfig,
    private readonly log: Logging,
    private readonly locator?: AgentLocator,
  ) {
    this.name = cfg.name;
    this.port = cfg.port ?? DEFAULT_AGENT_PORT;
    // Blank means the agent has never been re-keyed, so the shipped key is what it
    // wants. `||`, not `??`: an empty or whitespace field is what the settings form
    // leaves behind, and it has to fall back exactly as a missing one does.
    this.apiKey = cfg.api_key?.trim() || DEFAULT_AGENT_KEY;
    this.address = cfg.ip?.trim() || undefined;

    // An agent named with an IPv4 address uses it as its address.
    if (!this.address && this.name && /^(\d{1,3}\.){3}\d{1,3}$/.test(this.name.trim())) {
      this.address = this.name.trim();
    }
    // A configured address is taken at its word and never searched for: it is the way
    // to reach an agent a subnet scan cannot see.
    this.discoverable = !this.address;
  }

  /**
   * Take a newer entry from the agent lists, or an address the background sweep found,
   * without replacing this object: the accessories hold it.
   */
  update(cfg: AgentConfig): void {
    this.port = cfg.port ?? DEFAULT_AGENT_PORT;
    this.apiKey = cfg.api_key?.trim() || DEFAULT_AGENT_KEY;
    const ip = cfg.ip?.trim();
    if (ip) {
      this.relocate(ip);
    }
  }

  /** The agent answers at `ip` now: a new DHCP lease, found by the background sweep. */
  relocate(ip: string): void {
    if (ip === this.address) {
      return;
    }
    if (this.address) {
      this.log.info(`Agent '${this.name}' moved from ${this.address} to ${ip}.`);
    }
    this.address = ip;
  }

  /** `http://host:port`, or undefined while an unaddressed agent has not been found. */
  get base(): string | undefined {
    return this.address ? `http://${this.address}:${this.port}` : undefined;
  }

  /**
   * Resolve this agent's address, searching for it by name if it has none.
   *
   * `wait: false` starts the search but does not block on it. HomeKit reads use that:
   * a sweep takes seconds, and Homebridge rightly complains about a read handler that
   * slow, so a read fails fast and reports its last known state while the search runs.
   */
  private async ensureAddress(wait: boolean): Promise<string> {
    if (this.address) {
      return this.address;
    }
    if (!this.discoverable || !this.locator) {
      throw new AgentError(`Agent '${this.name}' has no address.`);
    }
    if (!this.resolving) {
      this.resolving = this.locator.locate(this.name, this.port)
        .then(found => {
          if (found) {
            this.address = found;
            this.log.info(`Agent '${this.name}' found at ${found}.`);
          }
          return found;
        })
        .finally(() => {
          this.resolving = undefined;
        });
    }
    if (!wait) {
      throw new AgentError(`Agent '${this.name}' is still being located.`);
    }
    if (!await this.resolving) {
      throw new AgentError(`Agent '${this.name}' was not found on the network.`);
    }
    return this.address!;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, wait = true): Promise<T> {
    const host = await this.ensureAddress(wait);
    const base = `http://${host}:${this.port}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
      const res = await fetch(base + path, {
        method,
        headers: {
          'Api-Key': this.apiKey,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new AgentError(`${method} ${path} on '${this.name}' returned ${res.status}: ${text.slice(0, 200)}`);
      }
      return (text ? JSON.parse(text) : {}) as T;
    } catch (e) {
      if (e instanceof AgentError) {
        throw e;
      }
      // The agent stopped answering. If we found it by name, drop the address so the
      // next call searches again - it may simply have taken a new DHCP lease.
      if (this.discoverable) {
        this.address = undefined;
        this.configured = false;
      }
      const reason = e instanceof Error && e.name === 'AbortError' ? `timed out after ${REQUEST_TIMEOUT}ms` : String(e);
      throw new AgentError(`${method} ${path} on '${this.name}' failed: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Unauthenticated liveness probe. */
  async hello(): Promise<{ name?: string; version?: string }> {
    return this.request('GET', '/hello');
  }

  /**
   * Configure a pin. `watched: true` makes the agent POST to our callback whenever
   * the pin changes.
   */
  async configurePin(gpio: number, cfg: Record<string, unknown>): Promise<unknown> {
    if (!this.storedPins) {
      const config = await this.readConfig();
      this.storedPins = (config.gpios ?? {}) as Record<string, Record<string, unknown>>;
    }
    if (pinMatches(this.storedPins[String(gpio)], cfg)) {
      return this.storedPins[String(gpio)];
    }
    const result = await this.request<Record<string, unknown>>('POST', `/gpio/config/${gpio}`, cfg);
    this.storedPins[String(gpio)] = { ...cfg, ...result };
    return result;
  }

  async readPin(gpio: number): Promise<PinInfo> {
    return this.request('GET', `/gpio/read/${gpio}`, undefined, false);
  }

  /**
   * Write a pin. `durationMs` asks the AGENT to revert the pin itself after that
   * long, so a momentary pulse survives this plugin restarting mid-pulse. The agent
   * takes seconds; callers convert second-based configuration to milliseconds.
   */
  async writePin(gpio: number, value: 0 | 1 | 'toggle', durationMs?: number): Promise<PinInfo> {
    const body: Record<string, unknown> = { value };
    if (durationMs && durationMs > 0) {
      body.duration = durationMs / 1000;
    }
    return this.request('POST', `/gpio/write/${gpio}`, body);
  }

  /**
   * Create or update a named sensor. `script` is "<file> [args...]" naming a bare
   * filename in the agent's scripts/ folder; the agent validates it at config time
   * and again on every read, and will only ever run it from that folder.
   */
  async configureSensor(name: string, script: string): Promise<unknown> {
    return this.request('POST', `/sensor/config/${encodeURIComponent(name)}`, { script });
  }

  /** Read one named sensor. Returns the agent's reading object, keyed by sensor name. */
  async readSensor(name: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/sensor/read/${encodeURIComponent(name)}`, undefined, false);
  }

  async readConfig(): Promise<Record<string, unknown>> {
    return this.request('GET', '/config/read');
  }

  /**
   * Point the agent's `bridges.homebridge` callback at us and give it the key it must
   * present. Verified by reading back: a push that silently failed would leave us
   * believing we were subscribed to events that never come.
   */
  async pushCallback(url: string, key: string): Promise<boolean> {
    await this.request('POST', '/config/update', {
      bridges: { [CALLBACK_FIELD]: url, [CALLBACK_KEY_FIELD]: key },
    });
    const cfg = await this.readConfig();
    this.storedPins = (cfg.gpios ?? {}) as Record<string, Record<string, unknown>>;
    const bridges = (cfg.bridges ?? {}) as Record<string, string>;
    this.configured = bridges[CALLBACK_FIELD] === url && bridges[CALLBACK_KEY_FIELD] === key;
    if (!this.configured) {
      this.log.error(
        `Agent '${this.name}' did not store the callback. Its bridges.homebridge field needs `
        + 'pi-gpio-api / pico-gpio-api / esp32-gpio-api 0.9.21 or newer.',
      );
    }
    return this.configured;
  }
}
