import type { CharacteristicValue, Service } from 'homebridge';

import { CtrlPiAccessory } from './base.js';

/**
 * A reading from one of the agent's named sensors: temperature, humidity or light.
 *
 * These are the only polled accessories. A sensor is a script the agent runs on
 * demand, not a pin it can watch, so there is nothing to push a callback and the
 * plugin has to ask on an interval.
 */
export class MeasuredAccessory extends CtrlPiAccessory {
  // HomeKit's light level starts at 0.0001 lux, so 0 is out of range for a Light Sensor.
  private value = this.device.accessory === 'lux' ? 0.0001 : 0;
  private timer?: NodeJS.Timeout;

  protected createService(): Service {
    const { Service: S, Characteristic: C } = this.platform;
    const name = this.device.name;

    switch (this.device.accessory) {
    case 'humidity': {
      const service = this.accessory.getService(S.HumiditySensor) ?? this.accessory.addService(S.HumiditySensor, name);
      service.getCharacteristic(C.CurrentRelativeHumidity).onGet(this.read.bind(this));
      return service;
    }
    case 'lux': {
      const service = this.accessory.getService(S.LightSensor) ?? this.accessory.addService(S.LightSensor, name);
      service.getCharacteristic(C.CurrentAmbientLightLevel).onGet(this.read.bind(this));
      return service;
    }
    default: {
      const service = this.accessory.getService(S.TemperatureSensor) ?? this.accessory.addService(S.TemperatureSensor, name);
      service.getCharacteristic(C.CurrentTemperature).onGet(this.read.bind(this));
      return service;
    }
    }
  }

  /**
   * Derived, not cached: createService() runs from the base constructor, and a
   * subclass field is defined after super() returns, which would wipe it.
   */
  private get characteristic() {
    const C = this.platform.Characteristic;
    switch (this.device.accessory) {
    case 'humidity': return C.CurrentRelativeHumidity;
    case 'lux': return C.CurrentAmbientLightLevel;
    default: return C.CurrentTemperature;
    }
  }

  /** Sensor-backed, so no pin events. */
  watchedPins(): number[] {
    return [];
  }

  /**
   * The sensor's name on the agent, derived from the device name rather than configured.
   * One name, decided in one place: the config says what to run, not what to call it.
   */
  private get sensorName(): string {
    return this.device.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  async configureAgent(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    if (!this.device.script) {
      throw new Error(`'${this.device.name}' is type '${this.device.accessory}' but names no script.`);
    }
    // Configure it first: the sensor need not exist on the agent beforehand, and a
    // changed script is pushed on every start, so the config here stays the truth.
    await this.agent.configureSensor(this.sensorName, this.device.script);
    this.log.info(`${this.tag} ${this.where} - runs ${this.device.script}`);

    await this.poll();
    // Seconds between readings, default 15 minutes: each one runs a script on the agent.
    // 0 reads once at start only.
    const seconds = this.device.interval ?? 900;
    if (seconds === 0) {
      return;
    }
    this.timer = setInterval(() => {
      this.poll().catch(e => this.log.debug(`Poll failed for '${this.device.name}':`, e));
    }, seconds * 1000);
    // Never let the poll timer be the reason Homebridge cannot shut down.
    this.timer.unref();
  }

  private async poll(): Promise<void> {
    const next = await this.fetchValue();
    if (next !== undefined && next !== this.value) {
      this.log.info(`${this.tag} ${this.where} - changed to ${next}`);
      this.value = next;
      this.service.updateCharacteristic(this.characteristic, next);
    }
  }

  /**
   * Read the sensor and pull one number out of the answer. The agent nests a reading
   * under the sensor's own name; a script returning several fields keeps them all, so
   * `field` picks one.
   */
  private async fetchValue(): Promise<number | undefined> {
    const sensorName = this.sensorName;
    const field = this.device.field;
    let body: unknown;
    try {
      body = await this.agent.readSensor(sensorName);
    } catch (e) {
      this.log.debug(`Could not read sensor '${sensorName}' ${this.where}:`, e);
      return undefined;
    }
    let reading = (body as Record<string, unknown>)?.[sensorName] ?? body;
    if (field && reading !== null && typeof reading === 'object') {
      reading = (reading as Record<string, unknown>)[field];
    }
    let num = Number(reading);
    if (!Number.isFinite(num)) {
      this.log.warn(`${this.tag} ${this.where} - gave a non-numeric reading:`, reading);
      return undefined;
    }
    if (this.device.accessory === 'lux') {
      num = Math.max(0.0001, num);
    }
    return num;
  }

  private async read(): Promise<CharacteristicValue> {
    return this.value;
  }

  onEvent(): void {
    // Sensor-backed accessories get no pin events.
  }
}
