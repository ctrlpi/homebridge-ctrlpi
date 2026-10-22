import type { CharacteristicValue, Service } from 'homebridge';

import { CtrlPiAccessory } from './base.js';
import type { WebhookEvent } from '../types.js';

/**
 * A valve, in three wirings:
 *
 *   0  normally closed, one relay - energised means open
 *   1  normally open,   one relay - energised means closed
 *   2  latching / pulsed, two relays - a pulse on one relay opens, on the other closes
 *
 * Type 2 is a latching valve: it holds its position with no power, so both relays
 * are pulsed rather than held, and the pin state afterwards says nothing about
 * where the valve actually is. That is why an `inUseGpio` position sensor is the
 * only reliable feedback for it.
 */
export class ValveAccessory extends CtrlPiAccessory {
  private active = false;
  private inUse = false;
  private closeTimer?: NodeJS.Timeout;
  private remainingUntil = 0;

  private get wiring(): 0 | 1 | 2 {
    return this.device.valveType ?? 0;
  }

  protected createService(): Service {
    const { Service: S, Characteristic: C } = this.platform;
    const service = this.accessory.getService(S.Valve) ?? this.accessory.addService(S.Valve, this.device.name);

    service.getCharacteristic(C.Active)
      .onGet(() => (this.active ? 1 : 0))
      .onSet(this.setActive.bind(this));
    service.getCharacteristic(C.InUse).onGet(() => (this.inUse ? 1 : 0));
    service.getCharacteristic(C.ValveType).onGet(() => this.device.displayType ?? 0);
    service.updateCharacteristic(C.ValveType, this.device.displayType ?? 0);

    // Config provides valveDuration in minutes. Convert to seconds for internal/HomeKit use.
    if (this.device.valveDuration !== undefined) {
      this.device.valveDuration = this.device.valveDuration * 60;
    } else {
      this.device.valveDuration = 1200; // 20 mins default in seconds
    }
    service.getCharacteristic(C.SetDuration)
      .onGet(() => this.device.valveDuration ?? 1200)
      .onSet((v) => {
        this.device.valveDuration = v as number;
      });
    service.getCharacteristic(C.RemainingDuration).onGet(() => this.remaining());
    return service;
  }

  private remaining(): number {
    if (!this.remainingUntil) {
      return 0;
    }
    return Math.max(0, Math.round((this.remainingUntil - Date.now()) / 1000));
  }

  watchedPins(): number[] {
    const pins: number[] = [];
    if (this.wiring !== 2 && this.device.gpio !== undefined) {
      pins.push(this.device.gpio);
    }
    if (this.device.inUseGpio !== undefined) {
      pins.push(this.device.inUseGpio);
    }
    return pins;
  }

  async configureAgent(): Promise<void> {
    if (this.device.gpio === undefined) {
      throw new Error(`Valve '${this.device.name}' has no gpio.`);
    }
    const pulseMs = ((this.device.duration ?? 23) * 1000);
    await this.agent.configurePin(this.device.gpio, {
      name: this.wiring === 2 ? `${this.device.name} open` : this.device.name,
      type: 'output',
      reversed: this.device.reversed ?? false,
      watched: this.wiring !== 2,
      max: this.wiring === 2 ? (pulseMs / 1000) : 0,
    });
    if (this.wiring === 2) {
      if (this.device.closeGpio === undefined) {
        throw new Error(`Valve '${this.device.name}' is a latching valve (type 2) but has no closeGpio.`);
      }
      await this.agent.configurePin(this.device.closeGpio, {
        name: `${this.device.name} close`,
        type: 'output',
        reversed: this.device.closeReversed ?? this.device.reversed ?? false,
        max: pulseMs / 1000,
        watched: false,
      });
    }
    if (this.device.inUseGpio !== undefined) {
      await this.agent.configurePin(this.device.inUseGpio, {
        name: `${this.device.name} position`,
        type: 'input',
        reversed: this.device.inUseReversed ?? false,
        pullup: this.device.pullup ?? 'up',
        watched: true,
      });
      this.inUse = (await this.agent.readPin(this.device.inUseGpio)).value === 1;
    }

    if (this.wiring !== 2) {
      const pin = await this.agent.readPin(this.device.gpio);
      this.active = this.energisedMeansOpen(pin.value === 1);
      if (this.device.inUseGpio === undefined) {
        this.inUse = this.active;
      }
      this.push();
    }
  }

  /** Wiring 1 is normally open, so an energised relay means the valve is shut. */
  private energisedMeansOpen(energised: boolean): boolean {
    return this.wiring === 1 ? !energised : energised;
  }

  private async setActive(value: CharacteristicValue): Promise<void> {
    const open = value === 1;
    this.log.info(`${this.tag} ${this.where} - setting to ${open ? 'open' : 'closed'}`);
    await this.wrap(async () => {
      if (this.wiring === 2) {
        // Latching: pulse the relay for the direction we want.
        const gpio = open ? this.device.gpio! : this.device.closeGpio!;
        await this.agent.writePin(gpio, 1, (this.device.duration ?? 23) * 1000);
      } else {
        // Normally-open wiring energises the relay to SHUT the valve, so the pin
        // level for "open" is the inverse of what normally-closed wiring wants.
        const level = this.wiring === 1 ? (open ? 0 : 1) : (open ? 1 : 0);
        await this.agent.writePin(this.device.gpio!, level);
      }
    });
    this.active = open;
    if (this.device.inUseGpio === undefined) {
      this.inUse = open;
    }
    this.push();
    this.scheduleAutoClose(open);
  }

  /** HomeKit's SetDuration: run for N seconds, then shut the valve. */
  private scheduleAutoClose(open: boolean): void {
    clearTimeout(this.closeTimer);
    const seconds = this.device.valveDuration ?? 0;
    if (!open || !seconds) {
      this.remainingUntil = 0;
      return;
    }
    this.remainingUntil = Date.now() + seconds * 1000;
    this.service.updateCharacteristic(this.platform.Characteristic.RemainingDuration, seconds);
    this.closeTimer = setTimeout(() => {
      this.log.info(`${this.tag} ${this.where} - ${seconds}s duration elapsed, closing`);
      this.setActive(0).catch(e => this.log.error(`${this.tag} ${this.where} - could not close:`, e));
    }, seconds * 1000);
    this.closeTimer.unref();
  }

  onEvent(event: WebhookEvent): void {
    if (event.gpio === this.device.inUseGpio) {
      this.inUse = event.value === 1;
      this.log.info(`${this.tag} ${this.where} - in use changed to ${this.inUse}`);
      this.push();
      return;
    }
    if (this.wiring !== 2 && event.gpio === this.device.gpio) {
      this.active = this.energisedMeansOpen(event.value === 1);
      this.log.info(`${this.tag} ${this.where} - changed to ${this.active ? 'open' : 'closed'}`);
      if (this.device.inUseGpio === undefined) {
        this.inUse = this.active;
      }
      this.push();
    }
  }

  private push(): void {
    const { Characteristic: C } = this.platform;
    this.service.updateCharacteristic(C.Active, this.active ? 1 : 0);
    this.service.updateCharacteristic(C.InUse, this.inUse ? 1 : 0);
  }
}
