import type { CharacteristicValue, Service } from 'homebridge';

import { CtrlPiAccessory } from './base.js';
import type { WebhookEvent } from '../types.js';

const DOOR_STATE: Record<number, string> = {
  0: 'open', 1: 'closed', 2: 'opening', 3: 'closing', 4: 'stopped',
};

/**
 * A garage door driven by one relay pulse, with optional open and close sensors.
 *
 * The opener has no notion of "open" or "close": every pulse means "next action",
 * which is stop while the door is moving. So a press while the door is in motion
 * sends one pulse and shows the door stopped.
 */
export class GarageDoorAccessory extends CtrlPiAccessory {
  // HAP's CurrentDoorState.CLOSED and TargetDoorState.CLOSED, both 1, spelled as literals
  // because class fields are initialised AFTER super() returns: createService() runs inside
  // super(), so anything it assigned here would be overwritten by the field definition and
  // these would read `undefined`. `this.platform` is not reachable at field-init time either.
  private current = 1;
  private target = 1;
  private obstruction = false;
  private travelTimer?: NodeJS.Timeout;

  protected createService(): Service {
    const { Service: S, Characteristic: C } = this.platform;
    const service = this.accessory.getService(S.GarageDoorOpener)
      ?? this.accessory.addService(S.GarageDoorOpener, this.device.name);

    service.getCharacteristic(C.CurrentDoorState).onGet(() => this.current);
    service.getCharacteristic(C.TargetDoorState)
      .onGet(() => this.target)
      .onSet(this.setTarget.bind(this));
    service.getCharacteristic(C.ObstructionDetected).onGet(() => this.obstruction);
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
      throw new Error(`Garage door '${this.device.name}' has no relay gpio.`);
    }
    const pulseMs = (this.device.duration ?? 2) * 1000;
    await this.agent.configurePin(this.device.gpio, {
      name: this.device.name,
      type: 'output',
      reversed: this.device.reversed ?? false,
      // The agent times the pulse and caps it, so a plugin crash mid-pulse cannot
      // leave the relay energised and the opener running.
      max: pulseMs / 1000,
      watched: false,
    });

    if (this.device.closeSensor !== undefined) {
      await this.agent.configurePin(this.device.closeSensor, {
        name: `${this.device.name} closed`,
        type: 'input',
        pullup: this.device.pullup ?? 'up',
        reversed: this.device.closeSensorReversed ?? false,
        watched: true,
      });
    }
    if (this.device.openSensor !== undefined) {
      await this.agent.configurePin(this.device.openSensor, {
        name: `${this.device.name} open`,
        type: 'input',
        pullup: this.device.pullup ?? 'up',
        reversed: this.device.openSensorReversed ?? false,
        watched: true,
      });
    }

    // Believe the sensors over any remembered state.
    const closed = await this.readSensor(this.device.closeSensor);
    const open = await this.readSensor(this.device.openSensor);
    if (closed && open) {
      this.log.warn(`${this.tag} ${this.where} - both sensors report triggered, which cannot be true, check the wiring`);
    } else if (open) {
      this.setState(C.CurrentDoorState.OPEN, C.TargetDoorState.OPEN);
    } else if (closed) {
      this.setState(C.CurrentDoorState.CLOSED, C.TargetDoorState.CLOSED);
    } else {
      // Nothing is triggered, so the state is inferred rather than read. A close sensor
      // that is not triggered is positive evidence the door is not shut, so believe it -
      // that covers a close sensor on its own and the both-sensors case where the door is
      // part way. With only an open sensor, or no sensors at all, there is no such
      // evidence, and closed is the safer assumption to show for a door.
      const assumeOpen = this.device.closeSensor !== undefined;
      this.setState(assumeOpen ? C.CurrentDoorState.OPEN : C.CurrentDoorState.CLOSED,
        assumeOpen ? C.TargetDoorState.OPEN : C.TargetDoorState.CLOSED);
    }
  }

  private async readSensor(gpio?: number): Promise<boolean> {
    if (gpio === undefined) {
      return false;
    }
    try {
      return (await this.agent.readPin(gpio)).value === 1;
    } catch (e) {
      this.log.warn(`${this.tag} ${this.where} - could not read sensor on gpio ${gpio}:`, e);
      return false;
    }
  }

  private async setTarget(value: CharacteristicValue): Promise<void> {
    await this.wrap(async () => {
      const { Characteristic: C } = this.platform;
      const wantOpen = value === C.TargetDoorState.OPEN;
      this.target = value as number;

      const moving = this.current === C.CurrentDoorState.OPENING || this.current === C.CurrentDoorState.CLOSING;
      if (moving) {
        // A pulse while moving stops the door; send exactly one.
        this.log.info(`${this.tag} ${this.where} - pressed while moving, sending one pulse to stop`);
        await this.pulse();
        clearTimeout(this.travelTimer);
        this.setState(C.CurrentDoorState.STOPPED, this.target);
        return;
      }

      await this.pulse();
      this.setState(
        wantOpen ? C.CurrentDoorState.OPENING : C.CurrentDoorState.CLOSING,
        this.target,
      );
      this.startTravelTimer(wantOpen);
    });
  }

  private async pulse(): Promise<void> {
    const pulseMs = (this.device.duration ?? 2) * 1000;
    await this.agent.writePin(this.device.gpio!, 1, pulseMs);
    this.log.debug(`'${this.device.name}': pulsed gpio ${this.device.gpio} for ${pulseMs}ms`);
  }

  /**
   * When a position sensor exists it decides when travel is over; the timer is only
   * the backstop that flags an obstruction. With no sensor the timer IS the state.
   */
  private startTravelTimer(opening: boolean): void {
    const { Characteristic: C } = this.platform;
    const hasSensor = opening ? this.device.openSensor !== undefined : this.device.closeSensor !== undefined;
    const travel = opening ? ((this.device.timeToOpen ?? 18) * 1000) : ((this.device.timeToClose ?? 18) * 1000);
    const buffer = 5000; // 5 seconds hardcoded grace period

    clearTimeout(this.travelTimer);
    this.travelTimer = setTimeout(() => {
      const settled = opening ? C.CurrentDoorState.OPEN : C.CurrentDoorState.CLOSED;
      if (this.current !== (opening ? C.CurrentDoorState.OPENING : C.CurrentDoorState.CLOSING)) {
        return;
      }
      if (hasSensor) {
        this.log.warn(`${this.tag} ${this.where} - sensor never confirmed ${opening ? 'open' : 'closed'}, flagging obstruction`);
        this.setObstruction(true);
        this.setState(C.CurrentDoorState.STOPPED, this.target);
      } else {
        this.setState(settled, this.target);
      }
    }, hasSensor ? travel + buffer : travel);
    this.travelTimer.unref();
  }

  onEvent(event: WebhookEvent): void {
    const { Characteristic: C } = this.platform;
    const triggered = event.value === 1;

    if (event.gpio === this.device.closeSensor) {
      if (triggered) {
        clearTimeout(this.travelTimer);
        this.setObstruction(false);
        this.setState(C.CurrentDoorState.CLOSED, C.TargetDoorState.CLOSED);
      } else if (this.current === C.CurrentDoorState.CLOSED) {
        // Left the closed position without us asking: someone used the wall button.
        this.setState(C.CurrentDoorState.OPENING, C.TargetDoorState.OPEN);
        this.startTravelTimer(true);
      }
      return;
    }

    if (event.gpio === this.device.openSensor) {
      if (triggered) {
        clearTimeout(this.travelTimer);
        this.setObstruction(false);
        this.setState(C.CurrentDoorState.OPEN, C.TargetDoorState.OPEN);
      } else if (this.current === C.CurrentDoorState.OPEN) {
        this.setState(C.CurrentDoorState.CLOSING, C.TargetDoorState.CLOSED);
        this.startTravelTimer(false);
      }
    }
  }

  private setState(current: number, target: number): void {
    const { Characteristic: C } = this.platform;
    this.current = current;
    this.target = target;
    this.service.updateCharacteristic(C.CurrentDoorState, current);
    this.service.updateCharacteristic(C.TargetDoorState, target);
    this.log.info(`${this.tag} ${this.where} - ${DOOR_STATE[current] ?? current}`);
  }

  private setObstruction(value: boolean): void {
    this.obstruction = value;
    this.service.updateCharacteristic(this.platform.Characteristic.ObstructionDetected, value);
  }
}
