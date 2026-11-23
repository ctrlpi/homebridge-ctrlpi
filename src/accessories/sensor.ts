import type { CharacteristicValue, Service } from 'homebridge';

import { BLUE, ORANGE, RED, paint } from '../logging.js';
import { CtrlPiAccessory } from './base.js';
import type { WebhookEvent } from '../types.js';

/** HomeKit's wording for a high pin and a low pin, per sensor type. */
const SENSOR_STATE: Record<string, [string, string]> = {
  indicator: ['On', 'Off'],
  contact: ['Open', 'Closed'],
  motion: ['Motion detected', 'No motion'],
  occupancy: ['Occupancy detected', 'No occupancy'],
  smoke: ['Smoke detected', 'No smoke'],
  monoxide: ['Carbon monoxide detected', 'No carbon monoxide'],
  dioxide: ['Carbon dioxide detected', 'No carbon dioxide'],
  leak: ['Leak detected', 'No leak'],
};

/**
 * A GPIO input shown as one of HomeKit's binary sensors. The pin is configured
 * `watched`, so the agent pushes each change as a callback.
 */
export class SensorAccessory extends CtrlPiAccessory {
  private detected = false;

  protected createService(): Service {
    const { Service: S, Characteristic: C } = this.platform;
    const name = this.device.name;
    let service: Service;
    let characteristic;

    switch (this.device.accessory) {
    case 'motion':
      service = this.accessory.getService(S.MotionSensor) ?? this.accessory.addService(S.MotionSensor, name);
      characteristic = C.MotionDetected;
      break;
    case 'indicator':
      service = this.accessory.getService(S.Lightbulb) ?? this.accessory.addService(S.Lightbulb, name);
      characteristic = C.On;
      break;
    case 'occupancy':
      service = this.accessory.getService(S.OccupancySensor) ?? this.accessory.addService(S.OccupancySensor, name);
      characteristic = C.OccupancyDetected;
      break;
    case 'smoke':
      service = this.accessory.getService(S.SmokeSensor) ?? this.accessory.addService(S.SmokeSensor, name);
      characteristic = C.SmokeDetected;
      break;
    case 'monoxide':
      service = this.accessory.getService(S.CarbonMonoxideSensor) ?? this.accessory.addService(S.CarbonMonoxideSensor, name);
      characteristic = C.CarbonMonoxideDetected;
      break;
    case 'dioxide':
      service = this.accessory.getService(S.CarbonDioxideSensor) ?? this.accessory.addService(S.CarbonDioxideSensor, name);
      characteristic = C.CarbonDioxideDetected;
      break;
    case 'leak':
      service = this.accessory.getService(S.LeakSensor) ?? this.accessory.addService(S.LeakSensor, name);
      characteristic = C.LeakDetected;
      break;
    default:
      service = this.accessory.getService(S.ContactSensor) ?? this.accessory.addService(S.ContactSensor, name);
      characteristic = C.ContactSensorState;
      break;
    }

    const handler = service.getCharacteristic(characteristic).onGet(this.getState.bind(this));
    if (this.device.accessory === 'indicator') {
      // Read-only: HomeKit has no such lightbulb, so accept the write and put the real state back.
      handler.onSet(this.ignoreWrite.bind(this));
    }
    return service;
  }

  /**
   * Which characteristic carries this sensor's state. Derived on each use rather
   * than cached in a field: createService() runs from the BASE constructor, and a
   * subclass field declaration is defined after super() returns, so anything it
   * assigned there would be overwritten with undefined.
   */
  private get characteristic() {
    const C = this.platform.Characteristic;
    switch (this.device.accessory) {
    case 'motion': return C.MotionDetected;
    case 'indicator': return C.On;
    case 'occupancy': return C.OccupancyDetected;
    case 'smoke': return C.SmokeDetected;
    case 'monoxide': return C.CarbonMonoxideDetected;
    case 'dioxide': return C.CarbonDioxideDetected;
    case 'leak': return C.LeakDetected;
    default: return C.ContactSensorState;
    }
  }

  watchedPins(): number[] {
    return this.device.gpio === undefined ? [] : [this.device.gpio];
  }

  async configureAgent(): Promise<void> {
    if (this.device.gpio === undefined) {
      throw new Error(`'${this.device.name}' is type '${this.device.accessory}' but has no gpio.`);
    }
    await this.configureOwnPin({
      name: this.device.name,
      type: 'input',
      pullup: this.device.pullup ?? 'up',
      reversed: this.device.reversed ?? false,
      watched: true,
    });
    const pin = await this.agent.readPin(this.device.gpio);
    this.detected = pin.value === 1;
    this.service.updateCharacteristic(this.characteristic, this.encode(this.detected));
  }

  private ignoreWrite(value: CharacteristicValue): void {
    this.log.info(`${this.tag} ${this.where} - read-only, ignoring ${value ? 'on' : 'off'}`);
    setTimeout(() => this.service.updateCharacteristic(this.characteristic, this.encode(this.detected)), 100).unref();
  }

  private async getState(): Promise<CharacteristicValue> {
    try {
      const pin = await this.agent.readPin(this.device.gpio!);
      this.detected = pin.value === 1;
    } catch (e) {
      this.log.debug(`Read failed for '${this.device.name}', reporting last known state:`, e);
    }
    return this.encode(this.detected);
  }

  /**
   * HomeKit's binary sensors are numeric, not boolean, and they do not agree on
   * which way round: a ContactSensor reports 1 when the contact is *open*, while
   * MotionDetected is a plain boolean.
   */
  private encode(detected: boolean): CharacteristicValue {
    return this.device.accessory === 'motion' || this.device.accessory === 'indicator' ? detected : (detected ? 1 : 0);
  }

  /** The log line: device type and name, pin level and HomeKit's wording for it. */
  private describe(detected: boolean): string {
    const [high, low] = SENSOR_STATE[this.device.accessory] ?? SENSOR_STATE.contact;
    const level = detected ? paint(ORANGE, 'high') : paint(BLUE, 'low');
    const reversed = this.device.reversed ? ` ${paint(RED, '(reversed)')}` : '';
    return `${this.tag} ${this.where} - is now ${level}${reversed} - ${detected ? high : low}`;
  }

  onEvent(event: WebhookEvent): void {
    const detected = event.value === 1;
    if (detected === this.detected) {
      return;
    }
    this.detected = detected;
    this.log.info(this.describe(detected));
    this.service.updateCharacteristic(this.characteristic, this.encode(detected));
  }
}
