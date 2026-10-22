import { join } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';

import type {
  API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service,
} from 'homebridge';

import { Agent, AgentError } from './agent-api.js';
import { AgentLocator } from './discovery.js';
import {
  saveAgent, saveAgentList, loadReconciledAgents, DEFAULT_SHARED_PATH, LOCAL_FILE,
} from './shared-config.js';
import { validateConfiguration, validateRescan } from './validation.js';
import type { CtrlPiAccessory } from './accessories/base.js';
import { buildAccessory } from './accessories/factory.js';
import { DEFAULT_AGENT_PORT, DEFAULT_WEBHOOK_PORT, PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import type { AgentConfig, DeviceConfig, WebhookEvent } from './types.js';

/** How often an agent that could not be set up (offline at startup, say) is tried again. */
const SETUP_RETRY_INTERVAL = 2 * 60_000;

/** First non-internal IPv4 address, which is what an agent has to POST back to. */
function localAddress(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const s = createSocket('udp4');
    const close = () => {
      try {
        s.close();
      } catch {
        // already closed
      }
    };
    const fallback = () => {
      for (const addresses of Object.values(networkInterfaces())) {
        for (const address of addresses ?? []) {
          if (address.family === 'IPv4' && !address.internal && address.address && !address.address.startsWith('127.')) {
            return resolve(address.address);
          }
        }
      }
      resolve(undefined);
    };
    const timer = setTimeout(() => {
      close();
      fallback();
    }, 500);
    s.once('error', () => {
      clearTimeout(timer);
      close();
      fallback();
    });
    try {
      // A UDP "connect" sends nothing; it only picks the interface that routes outward.
      s.connect(80, '8.8.8.8', () => {
        clearTimeout(timer);
        let ip: string | undefined;
        try {
          ip = s.address().address;
        } catch {
          ip = undefined;
        }
        close();
        if (ip && ip !== '0.0.0.0' && !ip.startsWith('127.')) {
          return resolve(ip);
        }
        fallback();
      });
    } catch {
      clearTimeout(timer);
      close();
      fallback();
    }
  });
}

export class CtrlPiPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly version: string;

  /** Cached accessories restored by Homebridge, by UUID. */
  public readonly accessories: Map<string, PlatformAccessory> = new Map();

  /**
   * The agents in use, by name. A rescan updates these objects in place rather than
   * replacing them, because every accessory holds the Agent it was built with.
   */
  private agents: Map<string, Agent> = new Map();
  private readonly handlers: CtrlPiAccessory[] = [];
  private readonly devices: DeviceConfig[];

  /** `${agent}:${gpio}` -> the accessories wanting that pin's events. */
  private readonly routes: Map<string, CtrlPiAccessory[]> = new Map();

  /** Per-agent callback key. Regenerated on every setup, so a stale key stops working. */
  private readonly callbackKeys: Map<string, string> = new Map();

  /** Agents that answered the callback push, so their pins are configured. */
  private readonly setUp: Set<string> = new Set();
  /** Agents with a setup in flight, so an event and the retry timer never run one twice. */
  private readonly settingUp: Set<string> = new Set();
  /** Agents whose last setup attempt failed, so a retry only logs the first failure. */
  private readonly unreachable: Set<string> = new Set();
  /** True once the startup setup pass has run. */
  private started = false;
  /** True once the accessories have been built. That happens once per run. */
  private built = false;

  private listener?: Server;
  private readonly webhookPort: number;
  private readonly localPath: string;
  private readonly sharedPath: string;
  private readonly rescanMinutes: number;

  /** Shared by every agent configured without an address: one sweep serves them all. */
  private readonly locator: AgentLocator;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.devices = validateConfiguration(config, log);
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.version = '0.9.78';
    // Not in config.schema.json on purpose: the defaults are right for everyone, and
    // anyone who really needs to move them can still set them in the JSON by hand.
    this.webhookPort = (this.config.webhookPort as number) ?? DEFAULT_WEBHOOK_PORT;
    // Homebridge's own storage folder (/var/lib/homebridge on a standard Pi image), so the
    // plugin never writes outside it, on any host.
    this.localPath = (this.config.localConfigPath as string)
      ?? join(api.user?.storagePath?.() ?? '/var/lib/homebridge', LOCAL_FILE);
    this.sharedPath = (this.config.sharedConfigPath as string) ?? DEFAULT_SHARED_PATH;
    this.rescanMinutes = validateRescan(this.config.rescan, log);
    this.locator = new AgentLocator(log, this.rescanMinutes, agent => {
      saveAgent(this.localPath, agent, this.sharedPath);
    });

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices(true).catch(e => this.log.error('Startup failed:', e));
      if (this.rescanMinutes > 0) {
        setInterval(() => {
          this.discoverDevices(false).catch(e => this.log.error('Background rescan failed:', e));
          for (const agent of this.agents.values()) {
            agent.hello().catch(() => undefined);
          }
        }, this.rescanMinutes * 60 * 1000).unref();
      }
      setInterval(() => this.retrySetup(), SETUP_RETRY_INTERVAL).unref();
    });
    this.api.on('shutdown', () => this.listener?.close());
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  /**
   * Stable UUID seed: the agent plus the device's own name. Moving a device to another
   * pin keeps the accessory; renaming it makes a new one. For a sensor-backed device the
   * name is also what the sensor on the agent is called, so a rename is a different
   * sensor too. Changing this seed renames every accessory in everyone's Home app.
   */
  private deviceId(device: DeviceConfig): string {
    return `${device.agent}:${device.name}`;
  }

  private async discoverDevices(isStartup = false): Promise<void> {
    // 1. Load agents from the local list and reconcile the shared one (read-only).
    const allAgents: AgentConfig[] = loadReconciledAgents(this.localPath, this.sharedPath);
    this.log.info(`Loaded ${allAgents.length} agents (local: ${this.localPath}, shared: ${this.sharedPath})`);

    // Discovery records addresses only. Admission to the active map always goes
    // through the filter below; a late sweep must not bypass it.
    if (this.rescanMinutes > 0) {
      this.locator.sweep(DEFAULT_AGENT_PORT)
        .then(found => this.adoptSweep(found, allAgents))
        .catch(e => this.log.error(`Network sweep failed: ${(e as Error).message}`));
    }

    // 2. Every agent a device names is needed, known to the lists or not.
    for (const device of this.devices) {
      if (device.agent && !allAgents.some(a => a.name === device.agent)) {
        allAgents.push({ name: device.agent });
      }
    }

    // 3. Filter all agents by whitelist/blacklist.
    let active: AgentConfig[];
    const filter = this.config.agents;
    if (Array.isArray(filter)) {
      // An `agents` array in hand-written JSON: merged over the lists.
      for (const f of filter as AgentConfig[]) {
        const match = allAgents.find(a => a.name === f.name);
        if (match) {
          Object.assign(match, f);
        } else {
          allAgents.push(f);
        }
      }
      active = allAgents;
    } else {
      const names = (v?: unknown) => {
        if (Array.isArray(v)) {
          return v.map(String);
        }
        if (typeof v === 'string') {
          return v.split(',').map(s => s.trim()).filter(Boolean);
        }
        return [];
      };
      const mode = filter?.mode ?? 'none';
      const list = names(filter?.list);

      active = allAgents;
      if (mode === 'whitelist') {
        active = allAgents.filter(a => list.includes(a.name));
        const missing = list.filter((n: string) => !allAgents.some(a => a.name === n));
        if (missing.length) {
          this.log.warn(`Whitelisted agent(s) not found: ${missing.join(', ')}`);
        }
      } else if (mode === 'blacklist' && list.length) {
        active = allAgents.filter(a => !list.includes(a.name));
      }
    }

    if (!active.length) {
      this.log.warn('No agents configured or discovered. Add at least one device in settings to auto-adopt its agent.');
    }

    const next = new Map<string, Agent>();
    for (const cfg of active) {
      // If the locator found the agent at one address, that is where it is now.
      const hits = this.locator.found.get(cfg.name) ?? [];
      if (hits.length === 1 && cfg.ip !== hits[0]) {
        cfg.ip = hits[0];
      }
      const existing = this.agents.get(cfg.name);
      if (existing) {
        existing.update(cfg);
        next.set(cfg.name, existing);
      } else {
        next.set(cfg.name, new Agent(cfg, this.log, this.locator));
      }
    }
    this.agents = next;

    // 4. Save the list strictly to the local file, never to the shared one.
    try {
      saveAgentList(this.localPath, allAgents, active);
    } catch (e: unknown) {
      this.log.error(`Could not write to local config ${this.localPath}: ${(e as Error).message}`);
    }

    if (!this.built) {
      this.built = true;
      this.buildAccessories();
      this.startListener();
    }

    if (isStartup) {
      await this.configureAgents();
    }
  }

  /**
   * Apply a finished sweep: save each agent that answered from exactly one address when
   * that address is new, and move a running agent there. Saving only on a change keeps
   * `updated_at` meaning "when this agent last changed".
   */
  private adoptSweep(found: Map<string, string[]>, known: AgentConfig[]): void {
    for (const [name, ips] of found) {
      if (ips.length !== 1) {
        continue;
      }
      if (known.find(a => a.name === name)?.ip !== ips[0]) {
        try {
          saveAgent(this.localPath, { name, ip: ips[0] }, this.sharedPath);
        } catch (e: unknown) {
          this.log.error(`Could not write to local config ${this.localPath}: ${(e as Error).message}`);
        }
      }
      this.agents.get(name)?.relocate(ips[0]);
    }
  }

  private buildAccessories(): void {
    const seen = new Set<string>();
    for (const device of this.devices) {
      const agent = this.agents.get(device.agent);
      if (!agent) {
        this.log.error(`Device '${device.name}' names agent '${device.agent}', which is not configured. Skipping.`);
        continue;
      }
      const uuid = this.api.hap.uuid.generate(this.deviceId(device));
      if (seen.has(uuid)) {
        this.log.error(`Device '${device.name}' duplicates ${this.deviceId(device)}, which is already in use. Skipping.`);
        continue;
      }
      seen.add(uuid);

      let existing = this.accessories.get(uuid);
      const was = existing?.context.device as DeviceConfig | undefined;
      // Home keeps a valve's icon from when it first saw it, so a new one needs a new accessory.
      const change = !was?.accessory ? undefined
        : was.accessory !== device.accessory ? `changed type from '${was.accessory}' to '${device.accessory}'`
          : device.accessory === 'valve' && (was.displayType ?? 0) !== (device.displayType ?? 0)
            ? 'changed how Home shows it' : undefined;
      if (existing && change) {
        this.log.info(`Device '${device.name}' ${change}. Recreating.`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existing]);
        this.accessories.delete(uuid);
        existing = undefined;
      }
      const accessory = existing ?? new this.api.platformAccessory(device.name, uuid);
      accessory.context.device = device;

      const handler = buildAccessory(this, accessory, agent, device);
      if (!handler) {
        this.log.error(`Device '${device.name}' has unknown type '${device.accessory}'. Skipping.`);
        seen.delete(uuid);
        continue;
      }
      this.handlers.push(handler);
      for (const pin of handler.watchedPins()) {
        const key = `${device.agent}:${pin}`;
        const list = this.routes.get(key) ?? [];
        list.push(handler);
        this.routes.set(key, list);
      }

      if (existing) {
        this.log.info('Restoring accessory:', device.name, `(${device.agent})`);
        this.api.updatePlatformAccessories([accessory]);
      } else {
        this.log.info('Adding accessory:', device.name, `(${device.agent})`);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }

    // Drop cached accessories whose device is no longer in the config.
    for (const [uuid, accessory] of this.accessories) {
      if (!seen.has(uuid)) {
        this.log.info('Removing accessory no longer in config:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(uuid);
      }
    }
  }

  /** Set every agent up at startup, in parallel, so an offline one never holds up the rest. */
  private async configureAgents(): Promise<void> {
    await Promise.all([...this.agents.values()].map(agent => this.setUpAgent(agent)));
    this.started = true;
  }

  /** Try again for every agent that has not been set up yet. */
  private retrySetup(): void {
    if (!this.started) {
      return;
    }
    for (const agent of this.agents.values()) {
      if (!this.setUp.has(agent.name)) {
        this.setUpAgent(agent).catch(e => this.log.error(`Could not set up agent '${agent.name}':`, e));
      }
    }
  }

  /**
   * Push our callback URL and a fresh key to one agent, then configure the pins of
   * every accessory on it. An agent that cannot be reached is left for the retry timer,
   * or for its first event, whichever comes first.
   */
  private async setUpAgent(agent: Agent): Promise<void> {
    if (this.settingUp.has(agent.name)) {
      return;
    }
    this.settingUp.add(agent.name);
    try {
      const host = await localAddress();
      if (!host) {
        this.log.error('Could not determine this host\'s LAN address; agents will have nowhere to send events.');
        return;
      }
      const key = randomBytes(9).toString('base64url').slice(0, 12);
      this.callbackKeys.set(agent.name, key);
      const url = `http://${host}:${this.webhookPort}/webhook?agent=${encodeURIComponent(agent.name)}`;
      try {
        await agent.pushCallback(url, key);
      } catch (e) {
        const message = `Could not reach agent '${agent.name}' to register for events: `
          + `${e instanceof Error ? e.message : String(e)}. Retrying every ${SETUP_RETRY_INTERVAL / 60_000} minutes.`;
        if (this.unreachable.has(agent.name)) {
          this.log.debug(message);
        } else {
          this.unreachable.add(agent.name);
          this.log.warn(message);
        }
        return;
      }
      this.unreachable.delete(agent.name);
      this.setUp.add(agent.name);
      if (agent.configured) {
        this.log.info(`Agent '${agent.name}' will send pin events to ${url}`);
      }
      for (const handler of this.handlers.filter(h => h.agentName === agent.name)) {
        try {
          await handler.configureAgent();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (e instanceof AgentError) {
            this.log.error(`Could not configure '${handler.name}' on agent '${handler.agentName}': ${msg}`);
          } else {
            this.log.error(`Could not configure '${handler.name}':`, e);
          }
        }
      }
    } finally {
      this.settingUp.delete(agent.name);
    }
  }

  /**
   * Listener for the agents' watched-pin callbacks. Every event must carry the key
   * we pushed to that agent: a keyless or stale-key POST is refused, so an event is
   * never acted on just because it arrived on the right port.
   */
  private startListener(): void {
    this.listener = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 8192) {
          req.destroy();
        }
      });
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const named = url.searchParams.get('agent') ?? '';
        const expected = this.callbackKeys.get(named);
        const presented = req.headers['api-key'];

        if (!expected || presented !== expected) {
          const agent = this.agents.get(named);
          if (agent && !agent.configured) {
            // One of ours that never took our URL and key (offline at startup, say), still
            // posting with an old key. Refuse the event and set it up now: the agent
            // retries the delivery, and by then it has the new key.
            this.log.warn(`Event from agent '${named}', which is not set up yet: setting it up now; its retry will land.`);
            this.setUpAgent(agent).catch(e => this.log.error(`Could not set up agent '${named}':`, e));
          } else {
            this.log.error(`[SECURITY] Cyber attack: rejected a callback for '${named || 'unknown agent'}' from `
              + `${req.socket.remoteAddress}: ${presented ? 'wrong' : 'no'} Api-Key.`);
          }
          res.writeHead(401).end();
          return;
        }
        res.writeHead(200).end();

        let event: WebhookEvent;
        try {
          event = JSON.parse(body);
        } catch {
          this.log.warn(`Ignoring an unparseable callback from '${named}'.`);
          return;
        }
        this.dispatch(named, event);
      });
    });
    this.listener.on('error', (e) => this.log.error(`Webhook listener on port ${this.webhookPort} failed:`, e));
    this.listener.listen(this.webhookPort, () => {
      this.log.info(`Listening for agent pin events on port ${this.webhookPort}`);
    });
  }

  private dispatch(agentName: string, event: WebhookEvent): void {
    const targets = this.routes.get(`${agentName}:${event.gpio}`);
    if (!targets?.length) {
      this.log.debug(`No accessory wants ${agentName} gpio ${event.gpio}; ignoring.`);
      return;
    }
    for (const target of targets) {
      try {
        target.onEvent(event);
      } catch (e) {
        this.log.error('Error handling pin event:', e);
      }
    }
  }
}
