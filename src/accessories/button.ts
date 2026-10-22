import type { Service } from 'homebridge';

import { CtrlPiAccessory } from './base.js';
import type { WebhookEvent } from '../types.js';

/** A release later than this is a long press. */
const LONG_PRESS_DELAY = 1500;
/** The window a press is decided in, measured from its 1. */
const PRESS_WINDOW = 3000;

/**
 * A momentary button on a GPIO input, as a StatelessProgrammableSwitch.
 *
 * The agents send at most one webhook per pin every 200 ms, so a quick tap's release
 * may go unreported. A press is decided from its 1, within 3 s:
 * - a second 1 is a double press
 * - a 0 after 1.5 s is a long press
 * - otherwise (a 0 before 1.5 s, or no 0 at all) a single press, at 3 s
 */
export class ButtonAccessory extends CtrlPiAccessory {
  private pressedAt?: number;
  private released = false;
  private windowTimer?: NodeJS.Timeout;

  protected createService(): Service {
    const { Service: S, Characteristic: C } = this.platform;
    const service = this.accessory.getService(S.StatelessProgrammableSwitch)
      ?? this.accessory.addService(S.StatelessProgrammableSwitch, this.device.name);
    // A stateless switch has no readable state, so there is no onGet to wire.
    service.getCharacteristic(C.ProgrammableSwitchEvent);
    return service;
  }

  watchedPins(): number[] {
    return this.device.gpio === undefined ? [] : [this.device.gpio];
  }

  async configureAgent(): Promise<void> {
    if (this.device.gpio === undefined) {
      throw new Error(`Button '${this.device.name}' has no gpio.`);
    }
    await this.agent.configurePin(this.device.gpio, {
      name: this.device.name,
      type: 'input',
      pullup: this.device.pullup ?? 'up',
      reversed: this.device.reversed ?? false,
      watched: true,
    });
  }

  onEvent(event: WebhookEvent): void {
    this.edge(event.value === 1);
  }

  private edge(pressed: boolean): void {
    const { Characteristic: C } = this.platform;
    if (pressed) {
      if (this.pressedAt !== undefined) {
        this.done(C.ProgrammableSwitchEvent.DOUBLE_PRESS, 'double press');
        return;
      }
      this.pressedAt = Date.now();
      this.released = false;
      this.windowTimer = setTimeout(
        () => this.done(C.ProgrammableSwitchEvent.SINGLE_PRESS, 'single press'), PRESS_WINDOW);
      this.windowTimer.unref();
      return;
    }

    if (this.pressedAt === undefined || this.released) {
      return;   // no press open, or its release already seen
    }
    if (Date.now() - this.pressedAt < LONG_PRESS_DELAY) {
      this.released = true;   // short: the window timer fires the single press
      return;
    }
    this.done(C.ProgrammableSwitchEvent.LONG_PRESS, 'long press');
  }

  private done(event: number, label: string): void {
    clearTimeout(this.windowTimer);
    this.windowTimer = undefined;
    this.pressedAt = undefined;
    this.log.info(`${this.tag} ${this.where} - ${label}`);
    this.service.updateCharacteristic(this.platform.Characteristic.ProgrammableSwitchEvent, event);
  }
}
