import type { Logging } from 'homebridge';

import type { DeviceConfig, DeviceType, IrrigationZone } from './types.js';

const ACCESSORIES: readonly DeviceType[] = [
  'switch', 'fan', 'lightbulb', 'outlet', 'button', 'indicator',
  'contact', 'motion', 'occupancy', 'smoke', 'monoxide', 'dioxide', 'leak',
  'garagedoor', 'valve', 'lock', 'shades', 'irrigation',
  'temperature', 'humidity', 'lux',
];
const MEASURED: readonly DeviceType[] = ['temperature', 'humidity', 'lux'];
const PINS = ['gpio', 'closeGpio', 'inUseGpio', 'closeSensor', 'openSensor', 'lockedSensor', 'doorSensor'] as const;

/** Longest timer Node accepts, in seconds, and the same in minutes. */
const MAX_SECONDS = 2147478;
const MAX_POLL_SECONDS = 2147483;
const MAX_MINUTES = 35791;
const DEFAULT_RESCAN = 60;

type Raw = Record<string, unknown>;

const blank = (value: unknown): boolean => value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const isWhole = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const isSeconds = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0.001 && value <= MAX_SECONDS;

/**
 * A pin script is what the agents take on a pin: "[on:|off:]<file> [args]", a bare filename from the
 * agent's scripts/ folder. `on:` runs it only when the pin goes to 1, `off:` only when it goes to 0
 * (no value is passed), and with no prefix it runs on both and gets 1 or 0 as its last argument.
 * A space after the prefix is accepted; the stored form has none.
 */
function splitPinScript(script: unknown): { mode: string; parts: string[] } {
  let text = String(script ?? '').trim();
  let mode = '';
  const prefix = /^(on|off)\s*:\s*/i.exec(text);
  if (prefix) {
    mode = prefix[1].toLowerCase();
    text = text.slice(prefix[0].length);
  }
  return { mode, parts: text.split(/\s+/).filter(Boolean) };
}

/** The reason a pin script is not usable, or undefined (an empty one is fine: no script). */
export function pinScriptError(script: unknown): string | undefined {
  const { parts } = splitPinScript(script);
  if (parts.length === 0) {
    return String(script ?? '').trim() === '' ? undefined : 'script needs a filename after on: or off:';
  }
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(parts[0])) {
    return 'script must be a bare filename in the agent\'s scripts folder';
  }
  if (parts[0].length > 32) {
    return 'script name is over 32 characters';
  }
  if (parts.slice(1).some(arg => !/^[A-Za-z0-9]+$/.test(arg))) {
    return 'script arguments must be letters and digits only';
  }
  return undefined;
}

/** The form the agents store (no space after the prefix, single spaces), or '' for no script. */
export function canonicalPinScript(script: unknown): string {
  const { mode, parts } = splitPinScript(script);
  return parts.length === 0 ? '' : (mode ? `${mode}:` : '') + parts.join(' ');
}

/** A pin as a number from a non-negative integer or a digit string, or undefined when it is not one. */
function toPin(value: unknown): number | undefined {
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value);
  }
  return isWhole(value, 0, Number.MAX_SAFE_INTEGER) ? value : undefined;
}

/** The first rule a device breaks, or undefined. Pins are converted to numbers in place. */
function problem(device: Raw): string | undefined {
  const accessory = device.accessory as DeviceType;
  if (!ACCESSORIES.includes(accessory)) {
    return `unknown accessory '${String(device.accessory)}'`;
  }

  for (const key of PINS) {
    if (blank(device[key])) {
      delete device[key];
      continue;
    }
    const pin = toPin(device[key]);
    if (pin === undefined) {
      return `${key} must be a whole number of 0 or more`;
    }
    device[key] = pin;
  }

  const measured = MEASURED.includes(accessory);
  if (device.gpio === undefined && accessory !== 'irrigation' && !measured) {
    return 'gpio is required';
  }
  const needsClose = (accessory === 'shades' && device.pulse !== true)
    || (accessory === 'valve' && device.valveType === 2)
    || (accessory === 'lock' && device.lockType === 2);
  if (needsClose && device.closeGpio === undefined) {
    return 'closeGpio is required';
  }

  if (measured) {
    if (!isText(device.script)) {
      return 'script is required';
    }
    if (device.interval !== undefined && !isWhole(device.interval, 0, MAX_POLL_SECONDS)) {
      return 'interval must be whole seconds, 0 to poll once at start only';
    }
  }

  for (const key of ['duration', 'timeToOpen', 'timeToClose']) {
    if (device[key] !== undefined && !isSeconds(device[key])) {
      return `${key} must be seconds from 0.001 to ${MAX_SECONDS}`;
    }
  }
  if (device.valveDuration !== undefined && !isWhole(device.valveDuration, 0, 60)) {
    return 'valveDuration must be whole minutes from 0 to 60';
  }
  if (device.tooLong !== undefined && !isWhole(device.tooLong, 0, MAX_MINUTES)) {
    return `tooLong must be whole minutes from 0 to ${MAX_MINUTES}`;
  }
  for (const [key, max] of [['valveType', 2], ['lockType', 2], ['displayType', 3]] as const) {
    if (device[key] !== undefined && !isWhole(device[key], 0, max)) {
      return `${key} must be 0 to ${max}`;
    }
  }
  if (device.pullup !== undefined && !['up', 'down', 'none'].includes(device.pullup as string)) {
    return 'pullup must be \'up\', \'down\' or \'none\'';
  }
  // On a device with a GPIO, `script` is a pin script for that GPIO (on a measured device it is the
  // sensor script, checked above). A device with no gpio of its own (irrigation) ignores it.
  if (!measured && device.script !== undefined) {
    if (typeof device.script !== 'string' && typeof device.script !== 'number') {
      return 'script must be text';
    }
    const error = pinScriptError(device.script);
    if (error) {
      return error;
    }
    const canonical = canonicalPinScript(device.script);
    if (canonical && device.gpio !== undefined) {
      device.script = canonical;
    } else {
      delete device.script;
    }
  }
  return undefined;
}

/** The usable zones of an irrigation device. A zone without a name is called "GPIO <pin>". */
function cleanZones(device: Raw, label: string, log: Logging): IrrigationZone[] {
  const zones: IrrigationZone[] = [];
  for (const raw of Array.isArray(device.zones) ? device.zones as Raw[] : []) {
    const named = isText(raw?.name);
    if (!named && blank(raw?.gpio)) {
      continue;
    }
    const gpio = toPin(raw.gpio);
    if (gpio === undefined) {
      log.error(`${label}: zone '${named ? raw.name : ''}' skipped, gpio must be a whole number of 0 or more`);
    } else if (raw.duration !== undefined && !isWhole(raw.duration, 1, 60)) {
      log.error(`${label}: zone on GPIO ${gpio} skipped, duration must be whole minutes from 1 to 60`);
    } else if (zones.some(zone => zone.gpio === gpio)) {
      log.error(`${label}: zone on GPIO ${gpio} skipped, the GPIO is already a zone`);
    } else {
      zones.push({ ...raw, name: named ? raw.name as string : `GPIO ${gpio}`, gpio });
    }
  }
  return zones;
}

/** The devices that pass their rules. A device that breaks one is logged and left out. */
export function validateConfiguration(config: unknown, log: Logging): DeviceConfig[] {
  const list = (config as { devices?: unknown } | null)?.devices;
  if (list !== undefined && !Array.isArray(list)) {
    log.error('Invalid ctrlPi configuration: devices must be a list, no devices loaded');
    return [];
  }

  const devices: DeviceConfig[] = [];
  const seen = new Set<string>();
  for (const [index, input] of (list ?? []).entries()) {
    if (!input || typeof input !== 'object') {
      log.error(`Device ${index + 1} skipped: not an object`);
      continue;
    }
    const device = structuredClone(input) as Raw;
    const label = `'${isText(device.name) ? device.name : `device ${index + 1}`}'${isText(device.agent) ? ` (agent ${device.agent})` : ''}`;
    if (blank(device.accessory)) {
      device.accessory = 'switch';
    }
    const reason = !isText(device.name) ? 'name is required'
      : !isText(device.agent) ? 'agent is required'
        : seen.has(`${device.agent}:${device.name}`) ? 'name is already used on this agent'
          : problem(device);
    if (reason) {
      log.error(`${label} skipped: ${reason}`);
      continue;
    }
    seen.add(`${device.agent}:${device.name}`);
    if (device.accessory === 'irrigation') {
      device.zones = cleanZones(device, label, log);
    }
    devices.push(device as unknown as DeviceConfig);
  }
  return devices;
}

/** The discovery interval in minutes: `rescan` when valid, else the default. */
export function validateRescan(value: unknown, log: Logging): number {
  if (value === undefined) {
    return DEFAULT_RESCAN;
  }
  if (!isWhole(value, 0, MAX_MINUTES)) {
    log.warn(`rescan must be whole minutes from 0 to ${MAX_MINUTES}, using ${DEFAULT_RESCAN}`);
    return DEFAULT_RESCAN;
  }
  return value;
}
