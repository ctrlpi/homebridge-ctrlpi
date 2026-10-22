// Minimal stand-ins for the bits of the Homebridge API the plugin touches.
// This exercises the compiled plugin; it never starts Homebridge.
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Stands in for Homebridge's storage folder, so no test ever writes the real agent list.
// Each makeApi() gets its own folder inside it, so one test's saved agents never leak
// into the next platform's startup.
export const STORAGE = mkdtempSync(join(tmpdir(), 'ctrlpi-hb-test-'));
process.on('exit', () => rmSync(STORAGE, { recursive: true, force: true }));
// A shared agent list that does not exist: the real /home/pi/.ctrlpi one names real
// agents, and a test platform would push its own callback into them.
export const NO_SHARED = join(STORAGE, 'no-shared-agents-config.json');

export const CDS = { OPEN: 0, CLOSED: 1, OPENING: 2, CLOSING: 3, STOPPED: 4 };
export const TDS = { OPEN: 0, CLOSED: 1 };

class Char {
  constructor(name) {
    this.name = name; this.value = null; this.handlers = {};
  }
  onGet(fn) {
    this.handlers.get = fn; return this;
  }
  onSet(fn) {
    this.handlers.set = fn; return this;
  }
  updateValue(v) {
    this.value = v; return this;
  }
}
class Svc {
  constructor(type, displayName, subtype) {
    this.type = type; this.displayName = displayName; this.subtype = subtype; this.chars = new Map();
  }
  getCharacteristic(c) {
    const key = typeof c === 'string' ? c : c.__name;
    if (!this.chars.has(key)) {
      this.chars.set(key, new Char(key));
    }
    return this.chars.get(key);
  }
  setCharacteristic(c, v) {
    this.getCharacteristic(c).updateValue(v); return this;
  }
  updateCharacteristic(c, v) {
    this.getCharacteristic(c).updateValue(v); return this;
  }
  addLinkedService() {
    return this;
  }
}
const named = (n) => {
  const f = function () {}; f.__name = n; return f;
};

const SERVICE_NAMES = ['AccessoryInformation','Switch','Fan','Lightbulb','Outlet','Valve',
  'GarageDoorOpener','ContactSensor','MotionSensor','OccupancySensor','SmokeSensor',
  'CarbonMonoxideSensor','CarbonDioxideSensor','LeakSensor','StatelessProgrammableSwitch',
  'TemperatureSensor','HumiditySensor','LightSensor','LockMechanism','WindowCovering','IrrigationSystem'];
const CHAR_NAMES = [
  'SetDuration',
  'RemainingDuration','Manufacturer','Model','SerialNumber','FirmwareRevision','Name','On','OutletInUse',
  'Active','InUse','ValveType','SetDuration','RemainingDuration','CurrentDoorState','TargetDoorState',
  'ObstructionDetected','ContactSensorState','MotionDetected','OccupancyDetected','SmokeDetected',
  'CarbonMonoxideDetected','CarbonDioxideDetected','LeakDetected','ProgrammableSwitchEvent',
  'CurrentTemperature','CurrentRelativeHumidity','CurrentAmbientLightLevel','LockCurrentState','LockTargetState',
  'CurrentPosition','TargetPosition','PositionState','ProgramMode'];

export const Service = {};
SERVICE_NAMES.forEach(n => Service[n] = named(n));
export const Characteristic = {}; CHAR_NAMES.forEach(n => {
  Characteristic[n] = named(n); Characteristic[n].ACTIVE = 1; Characteristic[n].INACTIVE = 0; Characteristic[n].IN_USE = 1; Characteristic[n].NOT_IN_USE = 0;
});
Characteristic.PositionState = Object.assign(named('PositionState'), { DECREASING: 0, INCREASING: 1, STOPPED: 2 });
Characteristic.CurrentDoorState = Object.assign(named('CurrentDoorState'), CDS);
Characteristic.TargetDoorState = Object.assign(named('TargetDoorState'), TDS);
Characteristic.LockCurrentState = Object.assign(named('LockCurrentState'), { UNSECURED: 0, SECURED: 1, JAMMED: 2, UNKNOWN: 3 });
Characteristic.LockTargetState = Object.assign(named('LockTargetState'), { UNSECURED: 0, SECURED: 1 });
Characteristic.ProgrammableSwitchEvent = Object.assign(named('ProgrammableSwitchEvent'),
  { SINGLE_PRESS: 0, DOUBLE_PRESS: 1, LONG_PRESS: 2 });

export class FakeAccessory {
  constructor(displayName, UUID) {
    this.displayName = displayName; this.UUID = UUID; this.context = {}; this.services = [];
    this.addService(Service.AccessoryInformation, displayName);
  }
  getService(t) {
    const k = typeof t === 'string' ? t : t.__name; return this.services.find(s => s.type === k);
  }
  getServiceById(t, sub) {
    const k = typeof t === 'string' ? t : t.__name; return this.services.find(s => s.type === k && s.subtype === sub);
  }
  addService(t, name, sub) {
    const s = new Svc(typeof t === 'string' ? t : t.__name, name, sub); this.services.push(s); return s;
  }
}

export function makeApi() {
  const api = new EventEmitter();
  api.hap = {
    Service, Characteristic,
    uuid: { generate: (s) => createHash('md5').update(s).digest('hex') },
    HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
    HapStatusError: class HapStatusError extends Error {
      constructor(status) {
        super(`HAP status ${status}`); this.hapStatus = status;
      }
    },
  };
  const storage = mkdtempSync(join(STORAGE, 'api-'));
  api.user = { storagePath: () => storage };
  api.platformAccessory = FakeAccessory;
  api.registerPlatformAccessories = () => {};
  api.updatePlatformAccessories = () => {};
  api.unregisterPlatformAccessories = () => {};
  api.on = EventEmitter.prototype.on.bind(api);
  return api;
}

export function makeLog(quiet = true) {
  const lines = [];
  const rec = (level) => (...a) => {
    lines.push(`[${level}] ${a.join(' ')}`); if (!quiet) {
      console.log(`[${level}]`, ...a);
    }
  };
  const log = rec('info');
  log.info = rec('info'); log.warn = rec('warn'); log.error = rec('error'); log.debug = rec('debug');
  log.lines = lines;
  return log;
}
