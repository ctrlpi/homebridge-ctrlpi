import type { CharacteristicValue, Service } from 'homebridge';

import { CtrlPiAccessory } from './base.js';
import type { WebhookEvent } from '../types.js';

/**
 * A GPIO output shown as a Switch, Fan, Lightbulb or Outlet.
 *
 * The pin is configured `watched`, so the agent POSTs a callback whenever it changes,
 * including changes this plugin did not cause.
 */
export class SwitchLikeAccessory extends CtrlPiAccessory {
  private on = false;
  private inUse = true;
  private onSince = 0;
  private tooLongTimer?: NodeJS.Timeout;

  protected createService(): Service {
    const { Service: S, Characteristic: C } = this.platform;
    const name = this.device.name;

    let service: Service;
    switch (this.device.accessory) {
    case 'fan':
      service = this.accessory.getService(S.Fan) ?? this.accessory.addService(S.Fan, name);
      break;
    case 'lightbulb':
      service = this.accessory.getService(S.Lightbulb) ?? this.accessory.addService(S.Lightbulb, name);
      break;
    case 'outlet':
      service = this.accessory.getService(S.Outlet) ?? this.accessory.addService(S.Outlet, name);
      service.getCharacteristic(C.OutletInUse).onGet(() => this.inUse);
      break;
    default:
      service = this.accessory.getService(S.Switch) ?? this.accessory.addService(S.Switch, name);
      break;
    }

    service.getCharacteristic(C.On)
      .onGet(this.getOn.bind(this))
      .onSet(this.setOn.bind(this));
    return service;
  }

  watchedPins(): number[] {
    const pins: number[] = [];
    if (this.device.gpio !== undefined) {
      pins.push(this.device.gpio);
    }
    if (this.device.inUseGpio !== undefined) {
      pins.push(this.device.inUseGpio);
    }
    return pins;
  }

  async configureAgent(): Promise<void> {
    if (this.device.gpio === undefined) {
      throw new Error(`'${this.device.name}' is type '${this.device.accessory}' but has no gpio.`);
    }
    await this.configureOwnPin({
      name: this.device.name,
      type: 'output',
      reversed: this.device.reversed ?? false,
      watched: true,
      // A pulse is timed by the AGENT: `max` caps how long the pin may stay driven,
      // so a plugin restart mid-pulse cannot leave the pin latched on.
      max: this.device.pulse ? (this.device.duration ?? 2) : 0,
    });
    if (this.device.inUseGpio !== undefined) {
      await this.agent.configurePin(this.device.inUseGpio, {
        name: `${this.device.name} in use`,
        type: 'input',
        reversed: this.device.inUseReversed ?? false,
        pullup: this.device.pullup ?? 'up',
        watched: true,
      });
    }
    const pin = await this.agent.readPin(this.device.gpio);
    this.on = pin.value === 1;
    this.service.updateCharacteristic(this.platform.Characteristic.On, this.on);
  }

  private async getOn(): Promise<CharacteristicValue> {
    try {
      const pin = await this.agent.readPin(this.device.gpio!);
      this.on = pin.value === 1;
    } catch (e) {
      this.log.debug(`Read failed for '${this.device.name}', reporting last known state:`, e);
    }
    return this.on;
  }

  private async setOn(value: CharacteristicValue): Promise<void> {
    await this.wrap(async () => {
      const want = value === true;
      const durationMs = this.device.pulse ? ((this.device.duration ?? 2) * 1000) : undefined;
      this.log.info(`${this.tag} ${this.where} - setting to ${want ? 'on' : 'off'}`);
      await this.agent.writePin(this.device.gpio!, want ? 1 : 0, want ? durationMs : undefined);
      this.on = want;
      this.trackTooLong(want);
    });
  }

  onEvent(event: WebhookEvent): void {
    const { Characteristic: C } = this.platform;
    if (event.gpio === this.device.inUseGpio) {
      this.inUse = event.value === 1;
      if (this.device.accessory === 'outlet') {
        this.service.updateCharacteristic(C.OutletInUse, this.inUse);
      }
      return;
    }
    const value = event.value === 1;
    if (value !== this.on) {
      this.log.info(`${this.tag} ${this.where} - changed to ${value ? 'on' : 'off'}`);
      this.on = value;
      this.service.updateCharacteristic(C.On, value);
      this.trackTooLong(value);
    }
  }

  /** Warn when an output has been left on longer than `tooLong` minutes. */
  private trackTooLong(on: boolean): void {
    clearTimeout(this.tooLongTimer);
    if (!on || !this.device.tooLong) {
      this.onSince = 0;
      return;
    }
    this.onSince = Date.now();
    this.tooLongTimer = setTimeout(() => {
      this.log.warn(`${this.tag} ${this.where} - has been on for ${this.device.tooLong} minutes`);
    }, this.device.tooLong * 60_000);
    this.tooLongTimer.unref();
  }
}
