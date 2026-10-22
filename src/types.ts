/**
 * Config shapes, mirroring config.schema.json.
 */

export type PullResistor = 'up' | 'down' | 'none';

export interface AgentConfig {
  name: string;
  ip?: string;
  port?: number;
  api_key?: string;
  updated_at?: string;
}

export interface AgentFilter {
  mode?: 'none' | 'whitelist' | 'blacklist';
  list?: string;
}

/** Every accessory type this plugin can expose. */
export type DeviceType =
  // GPIO outputs
  | 'switch' | 'fan' | 'lightbulb' | 'outlet'
  // GPIO momentary input
  | 'button' | 'indicator'
  // GPIO binary inputs
  | 'contact' | 'motion' | 'occupancy' | 'smoke' | 'monoxide' | 'dioxide' | 'leak'
  // compound GPIO devices
  | 'garagedoor' | 'valve' | 'lock' | 'shades' | 'irrigation'
  // agent named sensors, polled
  | 'temperature' | 'humidity' | 'lux';

export interface DeviceConfig {
  agent: string;
  name: string;
  accessory: DeviceType;

  /** GPIO number driving this device. Absent for sensor-backed types. */
  gpio?: number;
  /**
   * The script the agent should run for this sensor: "<file> [args...]", a bare
   * filename in the agent's scripts/ folder. The plugin configures the sensor from
   * this, so nothing has to exist on the agent first. The sensor is named after the
   * device, so there is no separate name to keep in step.
   */
  script?: string;
  /** Pick one field out of a multi-field reading. Omit when the script returns a value. */
  field?: string;
  /** Poll interval in seconds for sensor-backed devices. Default 900 (15 minutes), 0 reads once at start. */
  interval?: number;

  reversed?: boolean;
  /** Agent-side pull resistor. The agent takes "up" | "down" | "none", not a boolean. */
  pullup?: PullResistor;

  /** Momentary output: the agent drives the pin then reverts it after `duration` seconds. */
  pulse?: boolean;
  duration?: number;

  /** Warn when an output has been on this many minutes. 0 or absent disables. */
  tooLong?: number;

  // valve
  valveType?: 0 | 1 | 2;
  displayType?: 0 | 1 | 2 | 3;
  closeGpio?: number;
  closeReversed?: boolean;
  valveDuration?: number;
  inUseGpio?: number;
  inUseReversed?: boolean;

  // garage door
  closeSensor?: number;
  closeSensorReversed?: boolean;
  openSensor?: number;
  openSensorReversed?: boolean;
  timeToOpen?: number;
  timeToClose?: number;

  // lock
  lockType?: 0 | 1 | 2;
  lockedSensor?: number;
  lockedSensorReversed?: boolean;
  doorSensor?: number;
  doorSensorReversed?: boolean;

  // irrigation
  zones?: IrrigationZone[];
}

export interface IrrigationZone {
  name: string;
  gpio: number;
  duration?: number;
  reversed?: boolean;
}

export interface CtrlPiPlatformConfig {
  platform: string;
  name?: string;
  localConfigPath?: string;
  sharedConfigPath?: string;
  agents?: AgentFilter;
  devices?: DeviceConfig[];
  webhookPort?: number;
  rescan?: number;
}

/** One pin record as `/gpio/read` returns it. */
export interface PinInfo {
  gpio: number;
  value: 0 | 1;
  level?: 0 | 1;
  type: 'input' | 'output' | 'vcc' | 'gnd';
  name?: string;
  reversed?: boolean;
  watched?: boolean;
}

/** Body an agent POSTs to a bridge callback on a watched change. */
export interface WebhookEvent extends PinInfo {
  agent: string;
}
