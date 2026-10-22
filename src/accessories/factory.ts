import type { PlatformAccessory } from 'homebridge';

import type { Agent } from '../agent-api.js';
import type { CtrlPiPlatform } from '../platform.js';
import type { DeviceConfig } from '../types.js';
import type { CtrlPiAccessory } from './base.js';
import { ButtonAccessory } from './button.js';
import { GarageDoorAccessory } from './garageDoor.js';
import { LockAccessory } from './lock.js';
import { MeasuredAccessory } from './measured.js';
import { SensorAccessory } from './sensor.js';
import { SwitchLikeAccessory } from './switchLike.js';
import { ValveAccessory } from './valve.js';
import { ShadesAccessory } from './shades.js';
import { IrrigationAccessory } from './irrigation.js';

/** Map a configured device type onto the class that implements it. */
export function buildAccessory(
  platform: CtrlPiPlatform,
  accessory: PlatformAccessory,
  agent: Agent,
  device: DeviceConfig,
): CtrlPiAccessory | undefined {
  switch (device.accessory) {
  case 'switch':
  case 'fan':
  case 'lightbulb':
  case 'outlet':
    return new SwitchLikeAccessory(platform, accessory, agent, device);

  case 'contact':
  case 'motion':
  case 'occupancy':
  case 'smoke':
  case 'monoxide':
  case 'dioxide':
  case 'leak':
  case 'indicator':
    return new SensorAccessory(platform, accessory, agent, device);

  case 'button':
    return new ButtonAccessory(platform, accessory, agent, device);

  case 'garagedoor':
    return new GarageDoorAccessory(platform, accessory, agent, device);

  case 'valve':
    return new ValveAccessory(platform, accessory, agent, device);

  case 'lock':
    return new LockAccessory(platform, accessory, agent, device);

  case 'shades':
    return new ShadesAccessory(platform, accessory, agent, device);

  case 'irrigation':
    return new IrrigationAccessory(platform, accessory, agent, device);

  case 'temperature':
  case 'humidity':
  case 'lux':
    return new MeasuredAccessory(platform, accessory, agent, device);

  default:
    return undefined;
  }
}
