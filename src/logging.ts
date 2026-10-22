import type { DeviceType } from './types.js';

/** ANSI colors for the Homebridge log (terminal and UI log viewer). */
export const GREEN = '32';
export const RED = '31';
export const ORANGE = '38;5;208';
export const BLUE = '38;5;33';

export const paint = (color: string, text: string): string => `\x1b[${color}m${text}\x1b[0m`;

/** How a device type is named in the log. */
export const DEVICE_LABEL: Record<DeviceType, string> = {
  switch: 'Switch',
  fan: 'Fan',
  lightbulb: 'Light bulb',
  outlet: 'Outlet',
  button: 'Button',
  indicator: 'Indicator',
  contact: 'Contact sensor',
  motion: 'Motion sensor',
  occupancy: 'Occupancy sensor',
  smoke: 'Smoke sensor',
  monoxide: 'Carbon monoxide sensor',
  dioxide: 'Carbon dioxide sensor',
  leak: 'Leak sensor',
  garagedoor: 'Garage door',
  valve: 'Valve',
  lock: 'Lock',
  shades: 'Shades',
  irrigation: 'Irrigation system',
  temperature: 'Temperature sensor',
  humidity: 'Humidity sensor',
  lux: 'Light sensor',
};
