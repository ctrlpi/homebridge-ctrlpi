import type { CharacteristicValue, Service } from 'homebridge';

import { CtrlPiAccessory } from './base.js';
import type { WebhookEvent } from '../types.js';

/**
 * A window covering on two relays: `gpio` opens, `closeGpio` closes. A momentary
 * (`pulse`) controller may have a single input: with no `closeGpio`, `gpio` drives
 * every move and stop. Position is timed
 * from `timeToOpen` / `timeToClose`, and optional limit sensors correct it at either end.
 */
export class ShadesAccessory extends CtrlPiAccessory {
  private currentPosition = 0; // 0 (closed) to 100 (open)
  private targetPosition = 0;
  private positionState = 2; // STOPPED
  private travelTimer?: NodeJS.Timeout;
  private travelStartMs = 0;
  private startPosition = 0;

  protected createService(): Service {
    const { Service: S, Characteristic: C } = this.platform;
    const service = this.accessory.getService(S.WindowCovering)
      ?? this.accessory.addService(S.WindowCovering, this.device.name);

    service.getCharacteristic(C.CurrentPosition).onGet(() => this.currentPosition);
    service.getCharacteristic(C.TargetPosition)
      .onGet(() => this.targetPosition)
      .onSet(this.setTarget.bind(this));
    service.getCharacteristic(C.PositionState).onGet(() => this.positionState);

    return service;
  }

  watchedPins(): number[] {
    const pins: number[] = [];
    if (this.device.closeSensor !== undefined) {
      pins.push(this.device.closeSensor);
    }
    if (this.device.openSensor !== undefined) {
      pins.push(this.device.openSensor);
    }
    return pins;
  }

  async configureAgent(): Promise<void> {
    const { Characteristic: C } = this.platform;
    if (this.device.gpio === undefined) {
      throw new Error(`Shades '${this.device.name}' has no gpio (Up relay).`);
    }
    if (this.device.closeGpio === undefined && this.device.pulse === false) {
      throw new Error(`Shades '${this.device.name}' has no closeGpio (Down relay).`);
    }

    // Continuous relays must be allowed to run for a full traversal. Pulse
    // controllers only energise their input for the configured pulse length.
    const upMax = this.device.pulse === false ? (this.device.timeToOpen ?? 18) : (this.device.duration ?? 2);
    const downMax = this.device.pulse === false ? (this.device.timeToClose ?? 18) : (this.device.duration ?? 2);

    await this.configureOwnPin({
      name: `${this.device.name} up`,
      type: 'output',
      reversed: this.device.reversed ?? false,
      max: upMax,
      watched: false,
    });

    if (this.device.closeGpio !== undefined) {
      await this.agent.configurePin(this.device.closeGpio, {
        name: `${this.device.name} down`,
        type: 'output',
        reversed: this.device.closeReversed ?? this.device.reversed ?? false,
        max: downMax,
        watched: false,
      });
    }

    if (this.device.closeSensor !== undefined) {
      await this.agent.configurePin(this.device.closeSensor, {
        name: `${this.device.name} closed limit`,
        type: 'input',
        pullup: this.device.pullup ?? 'up',
        reversed: this.device.closeSensorReversed ?? false,
        watched: true,
      });
    }
    if (this.device.openSensor !== undefined) {
      await this.agent.configurePin(this.device.openSensor, {
        name: `${this.device.name} open limit`,
        type: 'input',
        pullup: this.device.pullup ?? 'up',
        reversed: this.device.openSensorReversed ?? false,
        watched: true,
      });
    }

    const closed = await this.readSensor(this.device.closeSensor);
    const open = await this.readSensor(this.device.openSensor);
    if (closed && open) {
      this.log.warn(`${this.tag} ${this.where} - both limit sensors triggered, check wiring`);
    } else if (open) {
      this.setPosition(100, 100, C.PositionState.STOPPED);
    } else if (closed) {
      this.setPosition(0, 0, C.PositionState.STOPPED);
    } else {
      const assumeOpen = this.device.closeSensor !== undefined;
      const initialPos = assumeOpen ? 100 : 0;
      this.setPosition(initialPos, initialPos, C.PositionState.STOPPED);
    }
  }

  private async readSensor(gpio?: number): Promise<boolean> {
    if (gpio === undefined) {
      return false;
    }
    try {
      return (await this.agent.readPin(gpio)).value === 1;
    } catch (e) {
      return false;
    }
  }

  private async setTarget(value: CharacteristicValue): Promise<void> {
    await this.wrap(async () => {
      const { Characteristic: C } = this.platform;
      const wantPosition = value as number;

      // If we are currently moving, estimate our actual current position
      if (this.positionState !== C.PositionState.STOPPED) {
        const elapsedMs = Date.now() - this.travelStartMs;
        const wasOpening = this.positionState === C.PositionState.INCREASING;
        const totalTime = wasOpening ? ((this.device.timeToOpen ?? 18) * 1000) : ((this.device.timeToClose ?? 18) * 1000);
        const percentMoved = Math.floor((elapsedMs / totalTime) * 100);

        this.currentPosition = wasOpening
          ? Math.min(100, this.startPosition + percentMoved)
          : Math.max(0, this.startPosition - percentMoved);

        clearTimeout(this.travelTimer);
        this.travelTimer = undefined;

        await this.stopMovement(wasOpening);
        if (this.device.pulse !== false) {
          // Allow the stop pulse to release before starting a new movement.
          await new Promise(r => setTimeout(r, (this.device.duration ?? 2) * 1000 + 100));
        }
      }

      if (wantPosition === this.currentPosition) {
        this.setPosition(this.currentPosition, wantPosition, C.PositionState.STOPPED);
        return;
      }

      const isOpening = wantPosition > this.currentPosition;
      this.targetPosition = wantPosition;
      const diff = Math.abs(wantPosition - this.currentPosition);

      const timeToOpen = (this.device.timeToOpen ?? 18) * 1000;
      const timeToClose = (this.device.timeToClose ?? 18) * 1000;
      const totalTime = isOpening ? timeToOpen : timeToClose;

      // Duration needed to move this %
      const runTime = Math.floor((diff / 100) * totalTime);

      this.startPosition = this.currentPosition;
      this.travelStartMs = Date.now();

      const pulseConfigMs = (this.device.duration ?? 2) * 1000;
      const pulseToUse = this.device.pulse !== false ? pulseConfigMs : runTime;

      const relayPin = isOpening ? this.device.gpio! : (this.device.closeGpio ?? this.device.gpio!);

      await this.agent.writePin(relayPin, 1, pulseToUse);

      this.setPosition(this.currentPosition, wantPosition, isOpening ? C.PositionState.INCREASING : C.PositionState.DECREASING);
      this.startTravelTimer(isOpening, runTime);
    });
  }

  private async stopMovement(opening: boolean): Promise<void> {
    const pin = opening ? this.device.gpio! : (this.device.closeGpio ?? this.device.gpio!);
    if (this.device.pulse === false) {
      await this.agent.writePin(pin, 0);
    } else {
      // Release an unfinished start pulse so the stop command produces a new edge.
      await this.agent.writePin(pin, 0);
      // Supported pulse controllers stop on a second pulse of the active input.
      await this.agent.writePin(pin, 1, (this.device.duration ?? 2) * 1000);
    }
  }

  private startTravelTimer(isOpening: boolean, runTime: number): void {
    const { Characteristic: C } = this.platform;
    clearTimeout(this.travelTimer);
    const target = this.targetPosition;
    const timer = setTimeout(() => {
      // Full travel in pulse mode ends at the controller's own limit. Sending a
      // pulse there could start it again; intermediate positions require a stop.
      const stop = this.device.pulse === false || (target > 0 && target < 100)
        ? this.stopMovement(isOpening) : Promise.resolve();
      stop.then(() => {
        if (this.travelTimer === timer) {
          this.setPosition(target, target, C.PositionState.STOPPED);
        }
      }).catch(e => this.log.error(`${this.tag} ${this.where} - could not stop:`, e));
    }, runTime);
    this.travelTimer = timer;
    timer.unref();
  }

  onEvent(event: WebhookEvent): void {
    const { Characteristic: C } = this.platform;
    const triggered = event.value === 1;
    const moving = this.positionState !== C.PositionState.STOPPED;
    const opening = this.positionState === C.PositionState.INCREASING;
    const atLimit = triggered && (event.gpio === this.device.closeSensor || event.gpio === this.device.openSensor);
    if (atLimit && moving && this.device.pulse === false) {
      this.stopMovement(opening).catch(e => this.log.error(`${this.tag} ${this.where} - could not stop at its limit:`, e));
    }

    if (event.gpio === this.device.closeSensor && triggered) {
      clearTimeout(this.travelTimer);
      this.travelTimer = undefined;
      this.setPosition(0, 0, C.PositionState.STOPPED);
    } else if (event.gpio === this.device.openSensor && triggered) {
      clearTimeout(this.travelTimer);
      this.travelTimer = undefined;
      this.setPosition(100, 100, C.PositionState.STOPPED);
    }
  }

  private setPosition(current: number, target: number, state: number): void {
    const { Characteristic: C } = this.platform;
    this.currentPosition = current;
    this.targetPosition = target;
    this.positionState = state;

    this.service.updateCharacteristic(C.CurrentPosition, current);
    this.service.updateCharacteristic(C.TargetPosition, target);
    this.service.updateCharacteristic(C.PositionState, state);

    const stateStr = state === C.PositionState.STOPPED ? 'STOPPED' : (state === C.PositionState.INCREASING ? 'INCREASING' : 'DECREASING');
    this.log.info(`${this.tag} ${this.where} - ${current}% (target ${target}%, ${stateStr})`);
  }
}
