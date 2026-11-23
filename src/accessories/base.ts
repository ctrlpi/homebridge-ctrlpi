import type { PlatformAccessory, Service } from 'homebridge';

import type { Agent } from '../agent-api.js';
import type { CtrlPiPlatform } from '../platform.js';
import { DEVICE_LABEL, GREEN, RED, paint } from '../logging.js';
import type { DeviceConfig, WebhookEvent } from '../types.js';

/**
 * Shared behaviour for every ctrlPi accessory: the information service, the agent
 * handle, and the hook the platform calls when a watched pin changes.
 */
export abstract class CtrlPiAccessory {
  protected readonly service: Service;
  protected readonly log;

  constructor(
    protected readonly platform: CtrlPiPlatform,
    protected readonly accessory: PlatformAccessory,
    protected readonly agent: Agent,
    protected readonly device: DeviceConfig,
  ) {
    this.log = platform.log;

    // The agent's name is carried on every accessory, so an accessory in the Home
    // app always says which Pi or Pico actually owns the pin behind it.
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'ctrlPi')
      .setCharacteristic(this.platform.Characteristic.Model, `${device.accessory} via ${agent.name}`)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.serial())
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision, this.platform.version);

    this.service = this.createService();
    this.service.setCharacteristic(this.platform.Characteristic.Name, device.name);

    // Clean up any stale services left over from previous config
    const active = [
      this.accessory.getService(this.platform.Service.AccessoryInformation)!,
      this.service,
      ...this.getActiveServices(),
    ];
    for (const svc of this.accessory.services) {
      if (!active.includes(svc)) {
        this.log.info(`Removing stale service ${svc.UUID} (${svc.displayName}) from ${this.device.name}`);
        this.accessory.removeService(svc);
      }
    }
  }

  protected async wrap<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      this.log.error(`${this.tag} ${this.where} - ${paint(RED, `communication failed: ${message}`)}`);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /** Device type and name for log lines, in green: Contact sensor 'Right'. */
  protected get tag(): string {
    return paint(GREEN, `${DEVICE_LABEL[this.device.accessory] ?? this.device.accessory} '${this.device.name}'`);
  }

  /** Where the device lives for log lines: on pi16 GPIO 5 (no GPIO for sensor-backed devices). */
  protected get where(): string {
    const gpio = this.device.gpio === undefined ? '' : ` GPIO ${this.device.gpio}`;
    return `on ${this.agent.name}${gpio}`;
  }

  /** The configured device name */
  get name(): string {
    return this.device.name;
  }

  /** The name of the agent this accessory belongs to */
  get agentName(): string {
    return this.agent.name;
  }

  /**
   * The SerialNumber Home shows: agent name plus the pin, or the name for a sensor-backed
   * device. Display only: the accessory's identity is the platform's deviceId().
   */
  protected serial(): string {
    const bound = this.device.gpio !== undefined ? `gpio${this.device.gpio}` : this.device.name;
    return `${this.agent.name}:${bound}`;
  }

  /** Build (or restore) this accessory's primary service and wire its handlers. */
  protected abstract createService(): Service;
  protected getActiveServices(): Service[] {
    return []; 
  }

  /**
   * Configure the device's own GPIO. It also carries the device's pin script; a device without one
   * clears a script the agent still has on that pin. Other pins of the device never get one.
   */
  protected configureOwnPin(cfg: Record<string, unknown>): Promise<unknown> {
    if (this.device.gpio === undefined) {
      throw new Error(`Device '${this.device.name}' has no gpio.`);
    }
    return this.agent.configurePin(this.device.gpio, { ...cfg, script: this.device.script ?? null });
  }

  /** Which GPIOs this accessory wants webhook events for. */
  abstract watchedPins(): number[];

  /** Configure the agent's pins for this accessory. Runs at startup and on reconnect. */
  abstract configureAgent(): Promise<void>;

  /** Called when a watched pin this accessory owns changes on the agent. */
  abstract onEvent(event: WebhookEvent): void;
}
