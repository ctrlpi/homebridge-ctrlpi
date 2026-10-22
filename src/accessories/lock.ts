import type { CharacteristicValue, Service } from 'homebridge';

import { CtrlPiAccessory } from './base.js';
import type { WebhookEvent } from '../types.js';

/**
 * A door lock, in three electrical wiring modes:
 *
 *   0  Fail-secure strike/solenoid: pulse to unlock, snaps locked when power is lost.
 *   1  Fail-safe maglock: continuous power to lock, cut power to unlock.
 *   2  Motorized (Latching): pulse one relay to lock, pulse another to unlock.
 */
export class LockAccessory extends CtrlPiAccessory {
  private lockCurrentState = 1; // SECURED when no feedback is available
  private doorClosed = true; // assume closed until sensor says otherwise
  private lockTimer?: NodeJS.Timeout;

  private get wiring(): 0 | 1 | 2 {
    return this.device.lockType ?? 0;
  }

  createService(): Service {
    const { Service: S, Characteristic: C } = this.platform;
    const service = this.accessory.getService(S.LockMechanism) ?? this.accessory.addService(S.LockMechanism, this.device.name);

    // Shown as locked until a sensor or a command says otherwise.
    this.lockCurrentState = C.LockCurrentState.SECURED;

    service.getCharacteristic(C.LockCurrentState)
      .onGet(() => this.lockCurrentState);

    service.getCharacteristic(C.LockTargetState)
      .onGet(() => {
        return this.lockCurrentState === C.LockCurrentState.UNSECURED
          ? C.LockTargetState.UNSECURED
          : C.LockTargetState.SECURED;
      })
      .onSet((value) => this.setTargetState(value));

    return service;
  }

  watchedPins(): number[] {
    const pins: number[] = [];
    if (this.device.lockedSensor !== undefined) {
      pins.push(this.device.lockedSensor);
    }
    if (this.device.doorSensor !== undefined) {
      pins.push(this.device.doorSensor);
    }
    return pins;
  }

  async configureAgent(): Promise<void> {
    const { Characteristic: C } = this.platform;
    // With a door sensor installed, the locking relay waits for its first reading.
    this.doorClosed = this.device.doorSensor === undefined;

    if (this.wiring === 2) {
      if (this.device.closeGpio === undefined) {
        throw new Error(`Lock '${this.device.name}' is motorized (type 2) but has no closeGpio (lock pin).`);
      }
      await this.agent.configurePin(this.device.closeGpio, {
        name: `${this.device.name} lock`,
        type: 'output',
        reversed: this.device.closeReversed ?? this.device.reversed ?? false,
      });
    }

    if (this.device.gpio !== undefined) {
      await this.agent.configurePin(this.device.gpio, {
        name: this.wiring === 2 ? `${this.device.name} unlock` : this.device.name,
        type: 'output',
        reversed: this.device.reversed ?? false,
        // Type 0 is pulse-to-unlock (momentary), type 2 pulsed, type 1 hold-to-lock.
        // For the pulsed types the agent caps the pin at the pulse length; type 1 has no cap.
        max: this.wiring === 1 ? 0 : (this.device.duration ?? 3),
      });
    }

    if (this.device.doorSensor !== undefined) {
      await this.agent.configurePin(this.device.doorSensor, {
        name: `${this.device.name} door`,
        type: 'input',
        reversed: this.device.doorSensorReversed ?? false,
        pullup: this.device.pullup ?? 'up',
        watched: true,
      });
      try {
        this.doorClosed = (await this.agent.readPin(this.device.doorSensor)).value === 1;
      } catch (e) {
        this.log.warn(`${this.tag} ${this.where} - could not read door sensor, locking is blocked until feedback arrives:`, e);
      }
    }

    if (this.device.lockedSensor !== undefined) {
      await this.agent.configurePin(this.device.lockedSensor, {
        name: `${this.device.name} locked sensor`,
        type: 'input',
        reversed: this.device.lockedSensorReversed ?? false,
        pullup: this.device.pullup ?? 'up',
        watched: true,
      });
      try {
        const pin = await this.agent.readPin(this.device.lockedSensor);
        this.onEvent({ ...pin, agent: this.agent.name });
      } catch (e) {
        this.lockCurrentState = C.LockCurrentState.SECURED;
        this.service.updateCharacteristic(C.LockCurrentState, this.lockCurrentState);
        this.log.warn(`${this.tag} ${this.where} - could not read lock sensor, assuming locked:`, e);
      }
    } else {
      // If no locked sensor, we must assume it is locked at startup
      this.lockCurrentState = C.LockCurrentState.SECURED;
      this.service.updateCharacteristic(C.LockCurrentState, this.lockCurrentState);
    }
  }

  private async setTargetState(value: CharacteristicValue): Promise<void> {
    const { Characteristic: C } = this.platform;
    const target = value as number;

    if (target === C.LockTargetState.SECURED) {
      // Trying to lock.
      if (this.device.doorSensor !== undefined && !this.doorClosed) {
        this.platform.log.warn(`${this.tag} ${this.where} - cannot lock, the door is open`);
        setTimeout(() => {
          this.service.updateCharacteristic(C.LockTargetState, C.LockTargetState.UNSECURED);
          this.service.updateCharacteristic(C.LockCurrentState, C.LockCurrentState.UNSECURED);
        }, 100);
        return;
      }

      try {
        if (this.wiring === 1) {
          // Fail-safe: turn ON to lock
          await this.agent.writePin(this.device.gpio!, 1);
        } else if (this.wiring === 2) {
          // Motorized: pulse lock relay
          await this.agent.writePin(this.device.closeGpio!, 1, (this.device.duration ?? 3) * 1000);
        } else {
          // Fail-secure: relocks by itself when the unlock pulse ends, so there is nothing to drive.
        }

        if (this.device.lockedSensor === undefined) {
          this.lockCurrentState = C.LockCurrentState.SECURED;
          this.service.updateCharacteristic(C.LockCurrentState, this.lockCurrentState);
        }
      } catch (err) {
        this.platform.log.error(`${this.tag} ${this.where} - failed to lock:`, err);
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
    } else {
      // Trying to unlock.
      try {
        if (this.wiring === 1) {
          // Fail-safe: turn OFF to unlock
          await this.agent.writePin(this.device.gpio!, 0);
        } else if (this.wiring === 2) {
          // Motorized: pulse unlock relay
          await this.agent.writePin(this.device.gpio!, 1, (this.device.duration ?? 3) * 1000);
        } else {
          // Fail-secure: pulse unlock relay
          await this.agent.writePin(this.device.gpio!, 1, (this.device.duration ?? 3) * 1000);

          // Auto-relock timer for fail-secure (because it physically re-locks when pulse ends)
          if (this.lockTimer) {
            clearTimeout(this.lockTimer);
          }
          this.lockTimer = setTimeout(() => {
            if (this.device.lockedSensor === undefined) {
              this.lockCurrentState = C.LockCurrentState.SECURED;
              this.service.updateCharacteristic(C.LockCurrentState, this.lockCurrentState);
              this.service.updateCharacteristic(C.LockTargetState, C.LockTargetState.SECURED);
            }
          }, ((this.device.duration ?? 3) * 1000) + 500);
        }

        if (this.device.lockedSensor === undefined) {
          this.lockCurrentState = C.LockCurrentState.UNSECURED;
          this.service.updateCharacteristic(C.LockCurrentState, this.lockCurrentState);
        }
      } catch (err) {
        this.platform.log.error(`${this.tag} ${this.where} - failed to unlock:`, err);
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
    }
  }

  onEvent(event: WebhookEvent): void {
    const { Characteristic: C } = this.platform;

    if (event.gpio === this.device.doorSensor) {
      // 1 = door closed (`doorSensorReversed` flips it).
      this.doorClosed = event.value === 1;
      return;
    }

    if (event.gpio === this.device.lockedSensor) {
      // 1 = bolt thrown (`lockedSensorReversed` flips it).
      const isSecured = event.value === 1;
      this.lockCurrentState = isSecured ? C.LockCurrentState.SECURED : C.LockCurrentState.UNSECURED;
      this.service.updateCharacteristic(C.LockCurrentState, this.lockCurrentState);

      // Follow the bolt, including when it was moved by hand.
      this.service.updateCharacteristic(C.LockTargetState,
        isSecured ? C.LockTargetState.SECURED : C.LockTargetState.UNSECURED,
      );
    }
  }
}
