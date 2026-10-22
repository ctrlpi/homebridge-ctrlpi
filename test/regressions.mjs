import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApi, makeLog, FakeAccessory } from './harness.mjs';
import { CtrlPiPlatform } from '../dist/platform.js';
import { LockAccessory } from '../dist/accessories/lock.js';
import { MeasuredAccessory } from '../dist/accessories/measured.js';
import { ShadesAccessory } from '../dist/accessories/shades.js';
import { SwitchLikeAccessory } from '../dist/accessories/switchLike.js';
import { ValveAccessory } from '../dist/accessories/valve.js';
import { GarageDoorAccessory } from '../dist/accessories/garageDoor.js';
import { AgentLocator } from '../dist/discovery.js';
import { DEFAULT_AGENT_KEY } from '../dist/settings.js';
import { saveAgent, loadReconciledAgents } from '../dist/shared-config.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Schema tests: pullup condition and Advanced fieldset
const rawSchema = JSON.parse(readFileSync(new URL('../config.schema.json', import.meta.url)));
const pullupCond = new Function('model', 'arrayIndices', rawSchema.schema.properties.devices.items.properties.pullup.condition.functionBody);

// Combined devices have pullup visible
for (const acc of ['lock', 'garagedoor', 'valve', 'shades', 'contact', 'button']) {
  assert.equal(pullupCond({ devices: [{ accessory: acc }] }, [0]), true, `pullup condition for ${acc}`);
}
// Outlet has pullup only when inUseGpio is provided
assert.equal(pullupCond({ devices: [{ accessory: 'outlet' }] }, [0]), false, 'outlet without inUseGpio has no pullup');
assert.equal(pullupCond({ devices: [{ accessory: 'outlet', inUseGpio: '' }] }, [0]), false, 'outlet with empty inUseGpio has no pullup');
assert.equal(pullupCond({ devices: [{ accessory: 'outlet', inUseGpio: 20 }] }, [0]), true, 'outlet with inUseGpio has pullup');

// Irrigation, switch, etc. have no pullup
assert.equal(pullupCond({ devices: [{ accessory: 'switch' }] }, [0]), false, 'switch has no pullup');
assert.equal(pullupCond({ devices: [{ accessory: 'irrigation' }] }, [0]), false, 'irrigation has no pullup');

// Advanced fieldset is hidden only for a device type with none of its fields. Its condition reads
// only the accessory type, so editing a field inside it never changes it (or collapses it).
const advancedFieldset = rawSchema.layout[0].items[0].items.find(item => item.title === 'Advanced');
assert.ok(advancedFieldset, 'Advanced fieldset exists in layout');
const deviceSchemaProps = rawSchema.schema.properties.devices.items.properties;
const advancedCond = new Function('model', 'arrayIndices', advancedFieldset.condition.functionBody);
const accessoryTypes = deviceSchemaProps.accessory.oneOf.map(o => o.enum[0]).filter(a => !a.startsWith('_'));
for (const acc of accessoryTypes) {
  const hasField = advancedFieldset.items.some(item => {
    const cond = deviceSchemaProps[(item.key ?? item).split('.').pop()].condition;
    // An outlet's in-use pin is always offered, so check it with one set.
    return new Function('model', 'arrayIndices', cond.functionBody)({ devices: [{ accessory: acc, inUseGpio: 20 }] }, [0]);
  });
  assert.equal(advancedCond({ devices: [{ accessory: acc }] }, [0]), hasField, `Advanced shown for ${acc} only if it has a field`);
}
const outletShown = inUseGpio => advancedCond({ devices: [{ accessory: 'outlet', inUseGpio }] }, [0]);
assert.equal(outletShown(undefined), outletShown(20), 'Advanced condition ignores field values');

const api = makeApi();
const log = makeLog();
const platform = { api, log, Service: api.hap.Service, Characteristic: api.hap.Characteristic, version: 'test' };
const calls = [];
const agent = {
  name: 'pi',
  configurePin: async (...args) => calls.push(['config', ...args]),
  readPin: async gpio => ({ gpio, value: 0 }),
  writePin: async (...args) => calls.push(['write', ...args]),
  configureSensor: async () => {},
  readSensor: async () => 21,
};
const lock = new LockAccessory(platform, new FakeAccessory('Lock', 'lock'), agent, {
  name: 'Lock', agent: 'pi', accessory: 'lock', gpio: 1, closeGpio: 2, lockType: 2, doorSensor: 3, lockedSensor: 4,
});
await lock.configureAgent();
assert.equal(lock.lockCurrentState, 0, 'startup reads unlocked sensor');
await lock.service.getCharacteristic('LockTargetState').handlers.set(1);
assert.equal(calls.some(c => c[0] === 'write'), false, 'open door prevents locking at startup');
assert.equal(calls.find(c => c[0] === 'config' && c[1] === 3)[2].pullup, 'up');
const noSensor = new LockAccessory(platform, new FakeAccessory('Lock2', 'lock2'), agent, {
  name: 'Lock2', agent: 'pi', accessory: 'lock', gpio: 5,
});
await noSensor.configureAgent();
assert.equal(noSensor.lockCurrentState, 1, 'without sensor assume locked');
const unavailable = new LockAccessory(platform, new FakeAccessory('Offline', 'offline'), {
  ...agent, readPin: async () => {
    throw new Error('offline'); 
  },
}, { name: 'Offline', agent: 'pi', accessory: 'lock', gpio: 5, lockedSensor: 4, doorSensor: 3 });
await unavailable.configureAgent();
assert.equal(unavailable.lockCurrentState, 1, 'unavailable lock sensor assumes locked');
assert.equal(unavailable.doorClosed, false, 'unavailable door sensor does not allow locking');

const measured = new MeasuredAccessory(platform, new FakeAccessory('Temp', 'temp'), agent, {
  name: 'Temp', agent: 'pi', accessory: 'temperature', script: 'temp.sh',
});
await measured.configureAgent();
const previousTimer = measured.timer;
await measured.configureAgent();
assert.equal(previousTimer._destroyed, true, 'reconfiguration clears old polling interval');
clearInterval(measured.timer);

// interval 0: read once at start, then never poll again
let reads = 0;
const once = new MeasuredAccessory(platform, new FakeAccessory('Once', 'once'), { ...agent, readSensor: async () => ++reads }, {
  name: 'Once', agent: 'pi', accessory: 'temperature', script: 'temp.sh', interval: 0,
});
await once.configureAgent();
assert.equal(once.timer, undefined, 'interval 0 sets no poll timer');
assert.equal(reads, 1, 'interval 0 still reads once at start');

calls.length = 0;
const shade = new ShadesAccessory(platform, new FakeAccessory('Shade', 'shade'), agent, {
  name: 'Shade', agent: 'pi', accessory: 'shades', gpio: 6, closeGpio: 7, pulse: false, timeToOpen: 0.1, timeToClose: 0.2,
});
await shade.configureAgent();
assert.equal(calls.find(c => c[0] === 'config' && c[1] === 6)[2].max, 0.1);
assert.equal(calls.find(c => c[0] === 'config' && c[1] === 7)[2].max, 0.2);
await shade.service.getCharacteristic('TargetPosition').handlers.set(50);
await sleep(90);
assert.equal(shade.currentPosition, 50);
assert.ok(calls.some(c => c[0] === 'write' && c[1] === 6 && c[2] === 0), 'continuous relay stops at target');
shade.device.openSensor = 10;
await shade.service.getCharacteristic('TargetPosition').handlers.set(100);
calls.length = 0;
shade.onEvent({ gpio: 10, value: 1, agent: 'pi' });
await sleep(0);
assert.ok(calls.some(c => c[0] === 'write' && c[1] === 6 && c[2] === 0), 'limit sensor releases active continuous relay');
calls.length = 0;
const pulseShade = new ShadesAccessory(platform, new FakeAccessory('Pulse', 'pulse'), agent, {
  name: 'Pulse', agent: 'pi', accessory: 'shades', gpio: 8, closeGpio: 9, pulse: true, duration: 0.01, timeToOpen: 0.1,
});
await pulseShade.configureAgent();
await pulseShade.service.getCharacteristic('TargetPosition').handlers.set(50);
await sleep(90);
assert.equal(calls.filter(c => c[0] === 'write' && c[1] === 8 && c[2] === 1).length, 2, 'partial travel sends stop pulse');
assert.equal(pulseShade.currentPosition, 50);
calls.length = 0;
await pulseShade.service.getCharacteristic('TargetPosition').handlers.set(100);
await sleep(90);
assert.equal(calls.filter(c => c[0] === 'write').length, 1, 'full travel must not send a restart pulse at the limit');

// Outlet with inUseGpio and pullup
calls.length = 0;
const outletWithPull = new SwitchLikeAccessory(platform, new FakeAccessory('Outlet', 'outlet'), agent, {
  name: 'Outlet', agent: 'pi', accessory: 'outlet', gpio: 11, inUseGpio: 12, pullup: 'down',
});
await outletWithPull.configureAgent();
assert.equal(calls.find(c => c[0] === 'config' && c[1] === 12)[2].pullup, 'down', 'outlet inUseGpio respects configured pullup');

calls.length = 0;
const outletDefaultPull = new SwitchLikeAccessory(platform, new FakeAccessory('Outlet2', 'outlet'), agent, {
  name: 'Outlet2', agent: 'pi', accessory: 'outlet', gpio: 11, inUseGpio: 12,
});
await outletDefaultPull.configureAgent();
assert.equal(calls.find(c => c[0] === 'config' && c[1] === 12)[2].pullup, 'up', 'outlet inUseGpio defaults to up if omitted');

// Valve with inUseGpio and pullup
calls.length = 0;
const valveWithPull = new ValveAccessory(platform, new FakeAccessory('Valve', 'valve'), agent, {
  name: 'Valve', agent: 'pi', accessory: 'valve', gpio: 13, inUseGpio: 14, pullup: 'none',
});
await valveWithPull.configureAgent();
assert.equal(calls.find(c => c[0] === 'config' && c[1] === 14)[2].pullup, 'none', 'valve inUseGpio respects configured pullup');

// Lock with single pullup setting both sensors
calls.length = 0;
const lockPull = new LockAccessory(platform, new FakeAccessory('LockPull', 'lock'), agent, {
  name: 'LockPull', agent: 'pi', accessory: 'lock', gpio: 1, closeGpio: 2, lockType: 2, doorSensor: 3, lockedSensor: 4, pullup: 'down',
});
await lockPull.configureAgent();
assert.equal(calls.find(c => c[0] === 'config' && c[1] === 3)[2].pullup, 'down', 'lock doorSensor uses device.pullup');
assert.equal(calls.find(c => c[0] === 'config' && c[1] === 4)[2].pullup, 'down', 'lock lockedSensor uses device.pullup');

// Garage door with single pullup setting both sensors
calls.length = 0;
const garagePull = new GarageDoorAccessory(platform, new FakeAccessory('GaragePull', 'garagedoor'), agent, {
  name: 'GaragePull', agent: 'pi', accessory: 'garagedoor', gpio: 26, closeSensor: 13, openSensor: 19, pullup: 'down',
});
await garagePull.configureAgent();
assert.equal(calls.find(c => c[0] === 'config' && c[1] === 13)[2].pullup, 'down', 'garagedoor closeSensor uses device.pullup');
assert.equal(calls.find(c => c[0] === 'config' && c[1] === 19)[2].pullup, 'down', 'garagedoor openSensor uses device.pullup');

// Shades with single pullup setting both sensors
calls.length = 0;
const shadesPull = new ShadesAccessory(platform, new FakeAccessory('ShadesPull', 'shades'), agent, {
  name: 'ShadesPull', agent: 'pi', accessory: 'shades', gpio: 6, closeGpio: 7, closeSensor: 20, openSensor: 21, pullup: 'none',
});
await shadesPull.configureAgent();
assert.equal(calls.find(c => c[0] === 'config' && c[1] === 20)[2].pullup, 'none', 'shades closeSensor uses device.pullup');
assert.equal(calls.find(c => c[0] === 'config' && c[1] === 21)[2].pullup, 'none', 'shades openSensor uses device.pullup');

const directory = mkdtempSync(join(tmpdir(), 'ctrlpi-regressions-'));
const sharedPath = join(directory, 'agents-config.json');
const originalFetch = globalThis.fetch;
try {
  writeFileSync(sharedPath, JSON.stringify({ preserved: true, agents: [{ name: 'original', api_key: 'keep' }] }));
  let boardKey = DEFAULT_AGENT_KEY;
  let boardName = 'twin';
  let writes = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).hostname, '192.0.2.2');
    const authorized = options.headers['Api-Key'] === boardKey;
    if (options.method === 'POST' && authorized) {
      const body = JSON.parse(options.body);
      const saved = JSON.parse(readFileSync(sharedPath)).agents.find(a => a.name === 'twin-2');
      if (body.name) {
        assert.equal(saved.name, body.name);
        boardName = body.name;
      }
      if (body.api_key) {
        assert.equal(saved.api_key, body.api_key, 'persist key before remote rotation');
        boardKey = body.api_key;
      }
      writes++;
    }
    return { ok: authorized, status: authorized ? 200 : 403 };
  };
  const locator = new AgentLocator(log, 60, cfg => saveAgent(sharedPath, cfg));
  locator.sweep = async () => {
    locator.found = new Map([['twin', ['192.0.2.1', '192.0.2.2']]]);
    return locator.found;
  };
  await locator.locate('twin');
  const saved = JSON.parse(readFileSync(sharedPath));
  assert.equal(boardName, 'twin-2');
  assert.notEqual(boardKey, DEFAULT_AGENT_KEY);
  assert.equal(saved.agents.find(a => a.name === boardName).api_key, boardKey);
  assert.match(saved.agents.find(a => a.name === boardName).updated_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(saved.agents.find(a => a.name === 'original').api_key, 'keep');
  assert.equal(saved.preserved, true);
  const count = writes;
  const unwritable = new AgentLocator(log, 60, () => {
    throw new Error('read-only'); 
  });
  unwritable.sweep = locator.sweep.bind(unwritable);
  boardKey = DEFAULT_AGENT_KEY;
  await unwritable.locate('twin');
  assert.equal(writes, count, 'failed persistence prevents remote mutations');

  for (const filter of [{ mode: 'blacklist', list: 'blocked' }, { mode: 'whitelist', list: 'allowed' }, { mode: 'whitelist', list: '' }]) {
    const p = new CtrlPiPlatform(log, {
      platform: 'ctrlPi', sharedConfigPath: sharedPath, agents: filter,
      devices: [{ name: 'Switch', agent: 'allowed', accessory: 'switch', gpio: 1 }],
    }, makeApi());
    let completeSweep;
    p.locator.sweep = () => new Promise(resolve => {
      completeSweep = resolve; 
    });
    p.startListener = () => {};
    p.configureAgents = async () => {};
    await p.discoverDevices();
    completeSweep(new Map([['blocked', ['192.0.2.2']]]));
    await sleep(0);
    assert.equal(p.agents.has('blocked'), false, 'late sweep respects filter');
    assert.equal(p.agents.has('allowed'), filter.mode === 'blacklist' || !!filter.list);
  }

  // Regression test: localConfigPath vs sharedConfigPath reconciliation and read-only shared config
  const testLocalPath = join(directory, 'ctrlpi-agents-config.json');
  const testSharedPath = join(directory, 'shared-agents-config.json');
  const initialSharedContent = JSON.stringify({
    agents: [
      { name: 'alpha', ip: '10.0.0.1', updated_at: '2026-03-01 10:00:00' },
      { name: 'delta', ip: '10.0.0.9', updated_at: '2026-01-01 10:00:00' },
    ],
  }, null, 2);
  writeFileSync(testSharedPath, initialSharedContent, 'utf8');

  writeFileSync(testLocalPath, JSON.stringify({
    agents: [
      { name: 'alpha', ip: '10.0.0.2', updated_at: '2026-02-01 10:00:00' },
      { name: 'delta', ip: '10.0.0.8', updated_at: '2026-02-01 10:00:00' },
    ],
  }, null, 2), 'utf8');

  // Verify loadReconciledAgents picks newer alpha from shared, but newer delta from local
  const reconciled = loadReconciledAgents(testLocalPath, testSharedPath);
  assert.equal(reconciled.find(a => a.name === 'alpha')?.ip, '10.0.0.1', 'newer shared agent reconciled into list');
  assert.equal(reconciled.find(a => a.name === 'delta')?.ip, '10.0.0.8', 'newer local agent kept');

  // Verify saveAgent writes strictly to localPath and never modifies sharedPath
  saveAgent(testLocalPath, { name: 'gamma', ip: '10.0.0.5' }, testSharedPath);
  assert.equal(readFileSync(testSharedPath, 'utf8'), initialSharedContent, 'sharedConfigPath is strictly read-only and never written');
  const savedLocal = JSON.parse(readFileSync(testLocalPath, 'utf8'));
  assert.equal(savedLocal.agents.find(a => a.name === 'gamma')?.ip, '10.0.0.5');
  assert.equal(savedLocal.agents.find(a => a.name === 'alpha')?.ip, '10.0.0.1');

} finally {
  globalThis.fetch = originalFetch;
  rmSync(directory, { recursive: true, force: true });
}
console.log('Schema, lock, shade, discovery, persistence, and polling regressions passed.');

