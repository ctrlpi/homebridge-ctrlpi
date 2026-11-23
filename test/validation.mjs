import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateConfiguration, validateRescan } from '../dist/validation.js';
import { CtrlPiPlatform } from '../dist/platform.js';
import { makeApi, makeLog } from './harness.mjs';

const device = overrides => ({ name: 'Test', agent: 'pi', accessory: 'switch', gpio: 0, ...overrides });
const GOOD = device({ name: 'Good', gpio: 5 });
let checks = 0;
import { pinScriptError, canonicalPinScript } from '../dist/validation.js';

/** Runs the device next to a good one: the good one must always survive. */
function run(bad) {
  const log = makeLog();
  const devices = validateConfiguration({ devices: [GOOD, ...[].concat(bad)] }, log);
  assert.equal(devices[0].name, 'Good', 'a good device is never dropped');
  return { devices: devices.slice(1), errors: log.lines.filter(l => l.startsWith('[error]')) };
}
function valid(bad, label) {
  const { devices, errors } = run(bad);
  assert.equal(devices.length, [].concat(bad).length, `${label}: ${errors.join('; ')}`);
  checks++;
  return devices;
}
function invalid(bad, label, pattern) {
  const { devices, errors } = run(bad);
  assert.equal(devices.length, 0, `${label}: should be skipped`);
  assert.equal(errors.length, 1, `${label}: one error line, got ${errors}`);
  if (pattern) {
    assert.match(errors[0], pattern, label);
  }
  checks++;
}

for (const accessory of ['switch', 'lightbulb', 'fan', 'outlet', 'button', 'indicator', 'contact', 'motion', 'occupancy',
  'smoke', 'monoxide', 'dioxide', 'leak', 'garagedoor', 'valve', 'lock', 'shades']) {
  for (const gpio of [undefined, '', ' ', null]) {
    invalid(device({ accessory, gpio, closeGpio: '2' }), `${accessory} missing GPIO ${gpio}`, /gpio is required/);
  }
  for (const gpio of [-1, 1.5, '4oops', true]) {
    invalid(device({ accessory, gpio, closeGpio: '2' }), `${accessory} invalid GPIO ${gpio}`, /gpio must be/);
  }
  for (const gpio of [0, '0', 4, '04']) {
    valid(device({ accessory, gpio, closeGpio: '2' }), `${accessory} accepts ${gpio}`);
  }
}
for (const field of ['name', 'agent']) {
  for (const value of [undefined, '', ' \t ', 5]) {
    invalid(device({ [field]: value }), `blank ${field}`, new RegExp(`${field} is required`));
  }
}
assert.equal(valid(device({ accessory: undefined }), 'missing accessory')[0].accessory, 'switch');
assert.equal(valid(device({ accessory: '' }), 'empty accessory')[0].accessory, 'switch');
invalid(device({ accessory: 'toaster' }), 'unknown accessory', /unknown accessory/);
invalid(device({ name: 'Good' }), 'duplicate name on one agent', /already used/);
valid(device({ name: 'Good', agent: 'other' }), 'same name on another agent');

for (const accessory of ['temperature', 'humidity', 'lux']) {
  for (const script of [undefined, '', '   ']) {
    invalid(device({ accessory, gpio: undefined, script }), `${accessory} needs script`, /script is required/);
  }
  valid(device({ accessory, gpio: '', script: 'dht22.sh 4' }), 'measured sensor needs no GPIO');
}
for (const wiring of [{ accessory: 'shades' }, { accessory: 'valve', valveType: 2 }, { accessory: 'lock', lockType: 2 }]) {
  for (const closeGpio of [undefined, '', ' ']) {
    invalid(device({ ...wiring, closeGpio }), 'second relay required', /closeGpio is required/);
  }
}
for (const wiring of [{ accessory: 'valve' }, { accessory: 'valve', valveType: 1 }, { accessory: 'lock', lockType: 1 },
  { accessory: 'shades', pulse: true }]) {
  valid(device({ ...wiring, closeGpio: '', zones: [] }), 'hidden optional fields are not required');
}
for (const zones of [undefined, []]) {
  valid(device({ accessory: 'irrigation', gpio: undefined, zones }), 'irrigation can start without zones');
}

// Irrigation zones: an empty row is ignored, a zone needs a GPIO, and a missing name becomes "GPIO <pin>".
const zoned = zones => run(device({ accessory: 'irrigation', gpio: undefined, zones }));
for (const zones of [[{}], [{ name: '', gpio: '' }], [{ reversed: false }], [{ name: '  ', reversed: false }], [{ duration: 5 }]]) {
  const { devices, errors } = zoned(zones);
  assert.deepEqual(devices[0].zones, [], `unused zone row ${JSON.stringify(zones)}`);
  assert.equal(errors.length, 0);
  checks++;
}
for (const zones of [[{ name: 'Lawn', gpio: '' }], [{ name: 'Lawn' }], [{ name: 'Lawn', gpio: -1 }], [{ gpio: 'x' }]]) {
  const { devices, errors } = zoned(zones);
  assert.equal(devices.length, 1, 'the device survives a bad zone');
  assert.deepEqual(devices[0].zones, []);
  assert.equal(errors.length, 1, JSON.stringify(zones));
  checks++;
}
assert.deepEqual(zoned([{ gpio: '4' }, { name: ' ', gpio: 0 }, { name: 'Lawn', gpio: '7' }]).devices[0].zones.map(z => [z.name, z.gpio]),
  [['GPIO 4', 4], ['GPIO 0', 0], ['Lawn', 7]], 'zones: names default to GPIO nn, gpio becomes a number');
assert.equal(zoned([{ name: 'A', gpio: 3 }, { name: 'B', gpio: '3' }]).devices[0].zones.length, 1, 'duplicate zone GPIO dropped');
for (const duration of [0, 61, 1.5, '5']) {
  assert.equal(zoned([{ name: 'Lawn', gpio: 1, duration }]).devices[0].zones.length, 0, `zone duration ${duration}`);
}
for (const duration of [1, 20, 60]) {
  assert.equal(zoned([{ name: 'Lawn', gpio: 1, duration }]).devices[0].zones.length, 1, `zone duration ${duration}`);
}
checks += 7;

for (const field of ['duration', 'timeToOpen', 'timeToClose']) {
  for (const value of [0, -1, 0.0001, 2147479, Infinity, NaN, '2']) {
    invalid(device({ [field]: value }), `${field} bounds/type ${value}`, new RegExp(field));
  }
  for (const value of [0.001, 0.1, 2, 2147478]) {
    valid(device({ [field]: value }), `${field} allows decimal seconds ${value}`);
  }
}
// interval is whole seconds; 0 polls once at start only
for (const value of [-1, 0.5, 2147484, Infinity, NaN, '60']) {
  invalid(device({ accessory: 'temperature', script: 'temp.sh', interval: value }), `poll interval ${value}`, /interval/);
}
for (const value of [0, 1, 900, 3600, 7200, 2147483]) {
  valid(device({ accessory: 'temperature', script: 'temp.sh', interval: value }), `poll interval ${value}`);
}
for (const [field, min, max] of [['tooLong', 0, 35791], ['valveDuration', 0, 60]]) {
  for (const value of [min - 1, min, max, max + 1, 1.5, '5']) {
    const ok = Number.isInteger(value) && value >= min && value <= max;
    (ok ? valid : invalid)(device({ [field]: value }), `${field}: ${value}`);
  }
}
for (const [field, max] of [['valveType', 2], ['lockType', 2], ['displayType', 3]]) {
  valid(device({ [field]: max }), `${field} ${max}`);
  invalid(device({ [field]: max + 1 }), `${field} ${max + 1}`, new RegExp(field));
}
for (const pullup of ['up', 'down', 'none']) {
  valid(device({ pullup }), `pullup ${pullup}`);
}
invalid(device({ pullup: 'sideways' }), 'pullup', /pullup/);

// Several bad devices: each is reported by name, every good one loads.
{
  const log = makeLog();
  const devices = validateConfiguration({
    devices: [device({ name: 'A', gpio: 1 }), device({ name: 'B', gpio: undefined }), null, device({ name: 'C', gpio: 3 })],
  }, log);
  assert.deepEqual(devices.map(d => d.name), ['A', 'C']);
  assert.ok(log.lines.some(l => l.includes('\'B\' (agent pi) skipped: gpio is required')));
  checks += 2;
}
{
  const log = makeLog();
  assert.deepEqual(validateConfiguration({ devices: 'oops' }, log), []);
  assert.deepEqual(validateConfiguration({}, makeLog()), []);
  assert.equal(log.lines.length, 1);
  checks += 3;
}
for (const rescan of [undefined, 0, 1, 60, 35791]) {
  assert.equal(validateRescan(rescan, makeLog()), rescan ?? 60);
}
for (const rescan of [-1, 1.5, 35792, '10', null]) {
  const log = makeLog();
  assert.equal(validateRescan(rescan, log), 60, `rescan ${rescan} falls back`);
  assert.equal(log.lines.length, 1);
}
checks += 10;

// The settings form: Save must be blocked while the form is invalid, and no numeric field may
// fall back to a slider (an integer with a minimum and maximum does, starting at the midpoint).
const fullSchema = JSON.parse(readFileSync(new URL('../config.schema.json', import.meta.url)));
assert.equal(fullSchema.strictValidation, true, 'strictValidation blocks Save on an invalid form');
const layoutKeys = new Map();
(function walk(items) {
  for (const item of items ?? []) {
    if (typeof item === 'string') {
      layoutKeys.set(item, undefined);
    } else {
      if (item.key) {
        layoutKeys.set(item.key, item.type);
      }
      walk(item.items);
    }
  }
})(fullSchema.layout);
const deviceProps = fullSchema.schema.properties.devices.items.properties;
const numeric = [
  ...Object.entries(deviceProps).map(([k, v]) => [`devices[].${k}`, v]),
  ...Object.entries(deviceProps.zones.items.properties).map(([k, v]) => [`devices[].zones[].${k}`, v]),
  ['rescan', fullSchema.schema.properties.rescan],
].filter(([, v]) => v.type === 'integer' && v.maximum !== undefined && !v.oneOf);
// tooLong is JSON only: deliberately left out of the settings form.
assert.ok(!layoutKeys.has('devices[].tooLong'), 'tooLong is not in the settings form');
checks += 1;
for (const [key] of numeric.filter(([k]) => k !== 'devices[].tooLong')) {
  assert.ok(layoutKeys.has(key), `${key} is in the settings form`);
  assert.ok(['integer', 'number'].includes(layoutKeys.get(key)), `${key} renders as a number field, not a slider`);
  checks += 2;
}

const raw = { devices: [device({ gpio: '04', closeSensor: '', zones: [{ name: 'Lawn', gpio: '0' }] })] };
const normalized = validateConfiguration(raw, makeLog());
assert.equal(normalized[0].gpio, 4);
assert.equal(normalized[0].closeSensor, undefined);
assert.equal(raw.devices[0].gpio, '04', 'runtime normalization preserves original config');
validateConfiguration({ agents: [{ name: 'pi', ip: '127.0.0.1' }], devices: [device({})] }, makeLog());

// A bad device never stops the platform or schedules less than the good ones need.
const api = makeApi();
const plat = new CtrlPiPlatform(makeLog(), {
  platform: 'ctrlPi', devices: [GOOD, device({ name: 'Lock', accessory: 'lock', lockType: 2 })], rescan: 99999,
}, api);
assert.deepEqual(plat.devices.map(d => d.name), ['Good'], 'bad device skipped, good one kept');
assert.equal(api.listenerCount('didFinishLaunching'), 1, 'discovery still starts');
console.log(`${checks} validation cases passed, including per-device skipping and normalization.`);

// A pin script ([on:|off:]<file> [args]) on a device with a GPIO: stored the way the agents store it,
// refused when it is not a plain filename, ignored by a device with no pin of its own.
assert.equal(valid(device({ gpio: 5, script: 'On:   relay.sh   fast ' }), 'pin script')[0].script, 'on:relay.sh fast');
assert.equal(canonicalPinScript('OFF: relay.sh'), 'off:relay.sh');
assert.equal(canonicalPinScript('  '), '');
for (const bad of ['../x.sh', 'sub/x.sh', '.hidden', 'relay.sh a-b', 'on:', 'off: ', 'a'.repeat(33)]) {
  assert.ok(pinScriptError(bad), bad);
  invalid(device({ gpio: 5, script: bad }), `pin script ${bad}`);
}
assert.ok(!('script' in valid(device({ gpio: 5, script: '  ' }), 'empty pin script')[0]), 'an empty script means none');
assert.ok(
  !('script' in valid({ name: 'Lawn', agent: 'pi', accessory: 'irrigation', script: 'relay.sh', zones: [{ gpio: 4 }] }, 'irrigation')[0]),
  'a device with no gpio ignores script',
);
assert.equal(
  valid(device({ accessory: 'temperature', gpio: undefined, script: 'dht22.sh 4' }), 'sensor script')[0].script,
  'dht22.sh 4',
  'a measured device keeps its sensor script',
);
checks += 5;
