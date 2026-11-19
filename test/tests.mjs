import { startMockAgent } from './stub-agent.mjs';
import { makeApi, makeLog, CDS, TDS, NO_SHARED } from './harness.mjs';
// Integration tests use loopback mock agents only, never a LAN sweep.
const { AgentLocator: TestLocator } = await import('../dist/discovery.js');
TestLocator.prototype.sweep = async function () {
  return this.found;
};
await import('./validation.mjs');
await import('./regressions.mjs');
const { CtrlPiPlatform } = await import('../dist/platform.js');

let pass = 0, fail = 0;
const ok = (n, c, extra='') => {
  if (c) {
    pass++;
    console.log(`  \x1b[32mPASS\x1b[0m ${n}`);
  } else {
    fail++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${n}` + (extra ? `  ->  ${extra}` : ''));
  }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const { server, state } = await startMockAgent(9401, 'mockpi');
const api = makeApi(), log = makeLog();
const writes = () => state.calls.filter(c => c.path.startsWith('/gpio/write/'));


const platform = new CtrlPiPlatform(log, {
  platform: 'ctrlPi', sharedConfigPath: NO_SHARED, webhookPort: 9402,
  agents: [{ name: 'mockpi', ip: '127.0.0.1', port: 9401, api_key: 'test-key' }],
  devices: [
    { agent: 'mockpi', name: 'Garage', accessory: 'garagedoor', gpio: 26, duration: 2, pulse: false,
      closeSensor: 13, openSensor: 19, timeToOpen: 0.3, timeToClose: 0.3 },
    { agent: 'mockpi', name: 'Porch', accessory: 'lightbulb', gpio: 6, reversed: true },
    { agent: 'mockpi', name: 'Door', accessory: 'contact', gpio: 15 },
    { agent: 'mockpi', name: 'Pilot', accessory: 'indicator', gpio: 20 },
    { agent: 'mockpi', name: 'Bell', accessory: 'button', gpio: 21 },
    { agent: 'mockpi', name: 'Attic Temp', accessory: 'temperature', script: 'dht22.sh 4', field: 'temp' },
  ],
}, api);
api.emit('didFinishLaunching');
await sleep(700);

console.log('\n--- startup: agent configured over REST');
const g = state.config.gpios;
ok('bridges.homebridge callback pushed', /^http:\/\/.+\/webhook\?agent=mockpi$/.test(state.config.bridges.homebridge || ''), state.config.bridges.homebridge);
ok('bridges.homebridge_key is a 12-char key', (state.config.bridges.homebridge_key || '').length === 12);
// The homekit pair belongs to a standalone HomeKit bridge: this plugin must leave it alone,
// or the two cannot drive the same agent at once, which is the whole reason for the split.
ok('bridges.homekit left untouched', !state.config.bridges.homekit && !state.config.bridges.homekit_key,
  JSON.stringify({ homekit: state.config.bridges.homekit, homekit_key: state.config.bridges.homekit_key }));
ok('garage relay -> output, pulse capped by agent', g['26']?.type === 'output' && g['26']?.max === 2, JSON.stringify(g['26']));
ok('close sensor -> watched input', g['13']?.type === 'input' && g['13']?.watched === true);
ok('open sensor  -> watched input', g['19']?.type === 'input' && g['19']?.watched === true);

// A sensor is configured from the script in the config, not looked up by name. The name
// on the agent comes from the device name, so there is nothing to keep in step by hand.
ok('sensor configured from script', state.sensors['attic-temp'] === 'dht22.sh 4',
  JSON.stringify(state.sensors));
const attic = platform.handlers.find(h => h.device.name === 'Attic Temp');
const atticValue = () => attic.service.getCharacteristic('CurrentTemperature').value;
ok('sensor field picked from reading', atticValue() === 21.5, String(atticValue()));
ok('light -> reversed watched output', g['6']?.type === 'output' && g['6']?.reversed === true && g['6']?.watched === true);
ok('contact -> pullup up', g['15']?.pullup === 'up', JSON.stringify(g['15']));

const handlers = platform.handlers;
const garage = handlers.find(h => h.device.name === 'Garage');
const target = garage.service.getCharacteristic('TargetDoorState');
const current = () => garage.service.getCharacteristic('CurrentDoorState').value;

console.log('\n--- garage door: one pulse per press, never two');
state.calls.length = 0;
await target.handlers.set(TDS.OPEN);
ok('press OPEN from closed sends exactly 1 pulse', writes().length === 1, `${writes().length} writes`);
ok('pulse carries the agent-side duration', writes()[0]?.body?.duration === 2, JSON.stringify(writes()[0]?.body));
ok('state becomes OPENING', current() === CDS.OPENING, String(current()));

state.calls.length = 0;
await target.handlers.set(TDS.CLOSED);
ok('press while OPENING sends exactly 1 pulse', writes().length === 1, `${writes().length} writes`);
ok('state becomes STOPPED, not CLOSING', current() === CDS.STOPPED, String(current()));

await sleep(500);
ok('no delayed follow-up pulse arrives', writes().length === 1, `${writes().length} writes total`);

state.calls.length = 0;
await target.handlers.set(TDS.CLOSED);
ok('press from STOPPED sends 1 pulse and moves', writes().length === 1 && current() === CDS.CLOSING, `${writes().length} writes, state ${current()}`);

console.log('\n--- webhook listener auth');
const post = async (key, body, agent='mockpi') => {
  const r = await fetch(`http://127.0.0.1:9402/webhook?agent=${agent}`, {
    method: 'POST', headers: key ? { 'Api-Key': key, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.status;
};
const goodKey = state.config.bridges.homebridge_key;
ok('no key -> 401', await post(null, { gpio: 13, value: 1 }) === 401);
ok('wrong key -> 401', await post('nope-not-it', { gpio: 13, value: 1 }) === 401);
ok('unknown agent -> 401', await post(goodKey, { gpio: 13, value: 1 }, 'ghost') === 401);
ok('correct key -> 200', await post(goodKey, { gpio: 13, value: 1 }) === 200);

console.log('\n--- events drive HomeKit state');
await sleep(100);
ok('close sensor triggered -> door CLOSED', current() === CDS.CLOSED, String(current()));
await post(goodKey, { gpio: 19, value: 1 });
await sleep(100);
ok('open sensor triggered -> door OPEN', current() === CDS.OPEN, String(current()));

const porch = handlers.find(h => h.device.name === 'Porch');
await post(goodKey, { gpio: 6, value: 1 });
await sleep(100);
ok('light event updates On', porch.service.getCharacteristic('On').value === true);

const door = handlers.find(h => h.device.name === 'Door');
await post(goodKey, { gpio: 15, value: 1 });
await sleep(100);
ok('contact event updates ContactSensorState', door.service.getCharacteristic('ContactSensorState').value === 1);

const pilot = handlers.find(h => h.device.name === 'Pilot');
await post(goodKey, { gpio: 20, value: 1 });
await sleep(100);
ok('indicator event updates On', pilot.service.getCharacteristic('On').value === true);
await pilot.service.getCharacteristic('On').handlers.set(false);
await sleep(250);
ok('indicator ignores a write and snaps back', pilot.service.getCharacteristic('On').value === true);

// The agents drop a webhook inside 200 ms of the last one, so a quick tap arrives as
// a 1 with no 0. A press is decided from its 1, within 3 s.
console.log('\n--- button: single, double and long press from the 1');
const bell = handlers.find(h => h.device.name === 'Bell');
const PSE = api.hap.Characteristic.ProgrammableSwitchEvent;
let presses = [];
const update = bell.service.updateCharacteristic.bind(bell.service);
bell.service.updateCharacteristic = (c, v) => {
  presses.push(v); return update(c, v);
};
await post(goodKey, { gpio: 21, value: 1 });
await sleep(3200);
ok('1 and no 0 -> single press at 3 s', presses.join() === `${PSE.SINGLE_PRESS}`, presses.join());
presses = [];
await post(goodKey, { gpio: 21, value: 1 });
await sleep(300);
await post(goodKey, { gpio: 21, value: 0 });
await sleep(3000);
ok('1 and 0 before 1.5 s -> single press', presses.join() === `${PSE.SINGLE_PRESS}`, presses.join());
presses = [];
await post(goodKey, { gpio: 21, value: 1 });
await sleep(400);
await post(goodKey, { gpio: 21, value: 1 });
await sleep(100);
ok('1 and 1 within 3 s -> double press', presses.join() === `${PSE.DOUBLE_PRESS}`, presses.join());
presses = [];
await post(goodKey, { gpio: 21, value: 1 });
await sleep(2000);
await post(goodKey, { gpio: 21, value: 0 });
await sleep(100);
ok('1 and 0 after 1.5 s -> long press', presses.join() === `${PSE.LONG_PRESS}`, presses.join());
presses = [];
await post(goodKey, { gpio: 21, value: 0 });
await sleep(200);
ok('a 0 with no press fires nothing', presses.length === 0, presses.join());

// The state a garage door comes up in is inferred, not read, whenever no sensor is
// triggered. A close sensor that is NOT triggered is positive evidence the door is not
// shut, so it wins; with only an open sensor, or none at all, there is nothing to go on
// and closed is the safer thing to show. TargetDoorState is asserted every time because
// it used to come up `undefined`: `current`/`target` were declared without initialisers,
// and class fields are defined AFTER super() returns, so they silently overwrote what
// createService() had assigned during super().
console.log('\n--- garage startup state when no sensor is triggered');
let port = 9410;
async function startupState(device, seed = {}) {
  const p = port++;
  const { server: srv, state: st } = await startMockAgent(p, 'mockpi');
  for (const [pin, v] of Object.entries(seed)) {
    st.pins.set(pin, v);
  }
  const a = makeApi();
  const plat = new CtrlPiPlatform(makeLog(), {
    platform: 'ctrlPi', sharedConfigPath: NO_SHARED, webhookPort: p + 100,
    agents: [{ name: 'mockpi', ip: '127.0.0.1', port: p, api_key: 'test-key' }],
    devices: [{ agent: 'mockpi', name: 'G', accessory: 'garagedoor', gpio: 26, ...device }],
  }, a);
  a.emit('didFinishLaunching');
  await sleep(400);
  const h = plat.handlers.find(x => x.device.name === 'G');
  const cur = h.service.getCharacteristic('CurrentDoorState').value;
  const tgt = h.service.getCharacteristic('TargetDoorState').value;
  srv.close(); plat.listener?.close();
  return { cur, tgt };
}

for (const [label, device, seed, want] of [
  ['no sensors -> CLOSED',                    {},                              {},           CDS.CLOSED],
  ['close sensor only, untriggered -> OPEN',  { closeSensor: 13 },             {},           CDS.OPEN],
  ['close sensor only, triggered -> CLOSED',  { closeSensor: 13 },             { 13: 1 },    CDS.CLOSED],
  ['open sensor only, untriggered -> CLOSED', { openSensor: 19 },              {},           CDS.CLOSED],
  ['open sensor only, triggered -> OPEN',     { openSensor: 19 },              { 19: 1 },    CDS.OPEN],
  ['both, neither triggered -> OPEN',         { closeSensor: 13, openSensor: 19 }, {},       CDS.OPEN],
  ['both, close triggered -> CLOSED',         { closeSensor: 13, openSensor: 19 }, { 13: 1 }, CDS.CLOSED],
  ['both, open triggered -> OPEN',            { closeSensor: 13, openSensor: 19 }, { 19: 1 }, CDS.OPEN],
]) {
  const { cur, tgt } = await startupState(device, seed);
  ok(label, cur === want, `CurrentDoorState=${cur}`);
  ok('   ...and TargetDoorState is a real number', Number.isFinite(tgt) && tgt === (want === CDS.OPEN ? TDS.OPEN : TDS.CLOSED),
    `TargetDoorState=${tgt}`);
}

// An agent may be configured without an address, in which case it is found by name.
// The sweep itself is real network traffic, so these drive the decisions around it: a
// fake locator for the Agent side, and a stubbed sweep for the locator's own rules.
console.log('\n--- agent discovery: address optional, found by name');
const { Agent } = await import('../dist/agent-api.js');
const { AgentLocator, MIN_SEARCH_INTERVAL, LONG_SEARCH_INTERVAL } = await import('../dist/discovery.js');

let asked = 0;
const fixed = new Agent({ name: 'mockpi', ip: '127.0.0.1', port: 9401, api_key: 'test-key' },
  makeLog(), {
    locate: async () => {
      asked++;
      return '10.0.0.9';
    },
  });
await fixed.hello();
ok('a configured IP is used as-is, with no search', asked === 0 && fixed.base === 'http://127.0.0.1:9401',
  `${asked} searches, base=${fixed.base}`);

const byName = new Agent({ name: 'mockpi', port: 9401, api_key: 'test-key' },
  makeLog(), { locate: async () => '127.0.0.1' });
ok('an agent with no IP starts with no address', byName.base === undefined, String(byName.base));
ok('...and is found by name on first use', (await byName.hello()).name === 'mockpi' && byName.base === 'http://127.0.0.1:9401',
  String(byName.base));

const ghost = new Agent({ name: 'ghost', port: 9401 }, makeLog(), { locate: async () => undefined });
let threw = false;
try {
  await ghost.hello();
} catch {
  threw = true;
}
ok('an agent that is nowhere fails cleanly', threw && ghost.base === undefined);

// Nothing listens on 9999, so the request fails at the socket: a found address must be
// dropped, because the board may simply have taken a new DHCP lease.
let searches = 0;
const moved = new Agent({ name: 'mockpi', port: 9999, api_key: 'k' },
  makeLog(), {
    locate: async () => {
      searches++;
      return '127.0.0.1';
    },
  });
await moved.hello().catch(() => {});
ok('an agent that stops answering drops its address', moved.base === undefined && searches === 1,
  `${searches} searches, base=${moved.base}`);
await moved.hello().catch(() => {});
ok('...so the next call searches for it again', searches === 2, `${searches} searches`);

// The locator's own rules, with the network sweep stubbed out.
function stubLocator(found, log) {
  const l = new AgentLocator(log, 60);
  let sweeps = 0;
  l.sweep = async () => {
    sweeps++;
    l.lastSweep = Date.now();
    l.found = new Map(Object.entries(found));
    if (!Object.keys(found).length) {
      l.failures++;
    }
    return l.found;
  };
  return [l, () => sweeps];
}

const twinLog = makeLog();
const [twins] = stubLocator({ twin: ['192.168.1.5', '192.168.1.6'] }, twinLog);
ok('two agents sharing a name are refused', await twins.locate('twin') === undefined);
ok('...and the clash is reported', twinLog.lines.some(l => l.startsWith('[error]') && l.includes('claimed by')),
  twinLog.lines.join(' | '));
const [one] = stubLocator({ solo: ['192.168.1.7'] }, makeLog());
ok('exactly one match is used', await one.locate('solo') === '192.168.1.7');

const [rate, sweeps] = stubLocator({ solo: ['192.168.1.7'] }, makeLog());
await rate.locate('solo');
await rate.locate('solo');
await rate.locate('other');
ok('a second lookup does not re-sweep inside the interval', sweeps() === 1, `${sweeps()} sweeps`);
rate.lastSweep = Date.now() - MIN_SEARCH_INTERVAL - 1;
await rate.locate('solo');
ok('...but does once the interval has passed', sweeps() === 2, `${sweeps()} sweeps`);

const [slow, slowSweeps] = stubLocator({}, makeLog());
await slow.locate('nobody');
slow.lastSweep = Date.now() - MIN_SEARCH_INTERVAL - 1;
await slow.locate('nobody');
slow.lastSweep = Date.now() - MIN_SEARCH_INTERVAL - 1;
await slow.locate('nobody');
ok('three fruitless searches happen 2 minutes apart', slowSweeps() === 3, `${slowSweeps()} sweeps`);
slow.lastSweep = Date.now() - MIN_SEARCH_INTERVAL - 1;
await slow.locate('nobody');
ok('...then the wait becomes 30 minutes', slowSweeps() === 3, `${slowSweeps()} sweeps`);
slow.lastSweep = Date.now() - LONG_SEARCH_INTERVAL - 1;
await slow.locate('nobody');
ok('...and it searches again after that', slowSweeps() === 4, `${slowSweeps()} sweeps`);

console.log('\n--- the agent Api-Key is optional');
const { DEFAULT_AGENT_KEY } = await import('../dist/settings.js');
// The mock only accepts 'test-key', so these calls are refused - which is fine, the
// question is which key went out on the wire, and that is recorded either way.
const keyOf = async (cfg, gpio) => {
  try {
    await new Agent(cfg, makeLog()).readPin(gpio);
  } catch {
    // a 403 from the mock, expected for every key but 'test-key'
  }
  return state.calls.filter(c => c.path === `/gpio/read/${gpio}`).pop()?.key;
};
ok('a blank Api-Key falls back to the shipped default',
  await keyOf({ name: 'mockpi', ip: '127.0.0.1', port: 9401, api_key: '' }, 21) === DEFAULT_AGENT_KEY);
ok('...so does a missing one',
  await keyOf({ name: 'mockpi', ip: '127.0.0.1', port: 9401 }, 22) === DEFAULT_AGENT_KEY);
ok('...and one that is only whitespace',
  await keyOf({ name: 'mockpi', ip: '127.0.0.1', port: 9401, api_key: '   ' }, 23) === DEFAULT_AGENT_KEY);
ok('a key that is set is still sent unchanged',
  await keyOf({ name: 'mockpi', ip: '127.0.0.1', port: 9401, api_key: 'test-key' }, 24) === 'test-key');
ok('the default is the value the agents ship with', DEFAULT_AGENT_KEY === 'your-secret-key', DEFAULT_AGENT_KEY);

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m`);
server.close(); platform.listener?.close();

console.log('\n--- lock: hardware state machine');
async function runLockTest(lockConfig, lockSeed, fn) {
  const p = port++;
  const { server: srv, state: st } = await startMockAgent(p, 'mockpi');
  for (const [pin, v] of Object.entries(lockSeed)) {
    st.pins.set(pin, v);
  }
  const a = makeApi();
  const plat = new CtrlPiPlatform(makeLog(), {
    platform: 'ctrlPi', sharedConfigPath: NO_SHARED, webhookPort: p + 100,
    agents: [{ name: 'mockpi', ip: '127.0.0.1', port: p, api_key: 'test-key' }],
    devices: [{ agent: 'mockpi', name: 'FrontDoor', accessory: 'lock', gpio: 10, ...lockConfig }],
  }, a);
  a.emit('didFinishLaunching');
  await sleep(400);
  const h = plat.handlers.find(x => x.device.name === 'FrontDoor');

  await fn(h, st, a);

  srv.close(); plat.listener?.close();
}

await runLockTest({ lockType: 0, duration: 0.1 }, {}, async (h, st, a) => {
  const C = a.hap.Characteristic;
  ok('Startup fail-secure without sensor -> SECURED', h.lockCurrentState === C.LockCurrentState.SECURED);

  h.service.getCharacteristic('LockTargetState').handlers.set(C.LockTargetState.UNSECURED);
  await sleep(50);
  const write = st.calls.find(c => c.path === '/gpio/write/10');
  ok('Fail-secure UNSECURED sends pulse', write && write.body.duration === 0.1);
  ok('Current state becomes UNSECURED', h.lockCurrentState === C.LockCurrentState.UNSECURED);

  await sleep(650); // wait for auto-relock timer (100 + 500)
  ok('Auto-relocks after timer', h.lockCurrentState === C.LockCurrentState.SECURED);
});

await runLockTest({ lockType: 1 }, {}, async (h, st, a) => {
  const C = a.hap.Characteristic;

  h.service.getCharacteristic('LockTargetState').handlers.set(C.LockTargetState.UNSECURED);
  await sleep(50);
  let write = st.calls.find(c => c.path === '/gpio/write/10' && c.body.value === 0);
  ok('Fail-safe UNSECURED sets pin to 0', !!write);

  h.service.getCharacteristic('LockTargetState').handlers.set(C.LockTargetState.SECURED);
  await sleep(50);
  write = st.calls.find(c => c.path === '/gpio/write/10' && c.body.value === 1);
  ok('Fail-safe SECURED sets pin to 1', !!write);
});

await runLockTest({ lockType: 2, closeGpio: 11, doorSensor: 12 }, { 12: 1 /* closed */ }, async (h, st, a) => {
  const C = a.hap.Characteristic;

  h.service.getCharacteristic('LockTargetState').handlers.set(C.LockTargetState.UNSECURED);
  await sleep(50);
  let write = st.calls.find(c => c.path === '/gpio/write/10');
  ok('Motorized UNSECURED pulses gpio (unlock pin)', !!write);

  st.calls.length = 0; // clear
  h.onEvent({ agent: 'mockpi', gpio: 12, value: 0 }); // door opened
  await sleep(10);

  h.service.getCharacteristic('LockTargetState').handlers.set(C.LockTargetState.SECURED);
  await sleep(50);
  write = st.calls.find(c => c.path === '/gpio/write/11');
  ok('Motorized refuses to SECURE while door open (no write to closeGpio)', !write);
});

console.log(`
${fail === 0 ? '[32m' : '[31m'}${pass} passed, ${fail} failed[0m`);

async function runShadesTest(shadesConfig, fn) {
  const p = port++;
  const { server: srv, state: st } = await startMockAgent(p, 'mockpi');
  if (shadesConfig.sensors) {
    st.pins.set(shadesConfig.closeSensor, 1);
    st.pins.set(shadesConfig.openSensor, 0);
  }
  const a = makeApi();
  const plat = new CtrlPiPlatform(makeLog(), {
    platform: 'ctrlPi', sharedConfigPath: NO_SHARED, webhookPort: p + 100,
    agents: [{ name: 'mockpi', ip: '127.0.0.1', port: p, api_key: 'test-key' }],
    devices: [{ agent: 'mockpi', name: 'Blinds', accessory: 'shades', gpio: 11, closeGpio: 12, ...shadesConfig }],
  }, a);
  a.emit('didFinishLaunching');
  await sleep(400);
  const h = plat.handlers.find(x => x.device.name === 'Blinds');

  await fn(h, st, a);

  srv.close(); plat.listener?.close();
}

console.log('\n--- shades: timing and limit sensors');
await runShadesTest({ closeGpio: undefined, pulse: true, duration: 0.01, timeToOpen: 0.1, timeToClose: 0.1 }, async (h, st) => {
  ok('Momentary shades without closeGpio configure one relay', !!st.config.gpios['11'] && !st.config.gpios['12'],
    JSON.stringify(st.config.gpios));
  h.service.getCharacteristic('TargetPosition').handlers.set(100);
  await sleep(200);
  h.service.getCharacteristic('TargetPosition').handlers.set(0);
  await sleep(50);
  const pins = st.calls.filter(c => c.path.startsWith('/gpio/write/')).map(c => c.path);
  ok('...and pulse gpio to open and to close', pins.length >= 2 && pins.every(p => p === '/gpio/write/11'), pins.join());
});
await runShadesTest({ timeToOpen: 0.2, timeToClose: 0.2, duration: 2, pulse: false }, async (h, st, a) => {
  const C = a.hap.Characteristic;
  ok('Startup shades without sensor -> STOPPED at 0', h.currentPosition === 0 && h.positionState === C.PositionState.STOPPED);

  h.service.getCharacteristic('TargetPosition').handlers.set(50);
  await sleep(50);

  let write = st.calls.find(c => c.path === '/gpio/write/11');
  ok('Targeting 50% opens via up relay', !!write);
  ok('Duration is calculated dynamically', write && write.body.duration === 0.1);
  ok('Position state is INCREASING', h.positionState === C.PositionState.INCREASING);

  await sleep(150);
  ok('Timer stops shades at target', h.positionState === C.PositionState.STOPPED && h.currentPosition === 50);
});

async function runIrrigationTest(irrigationConfig, fn) {
  const p = port++;
  const { server: srv, state: st } = await startMockAgent(p, 'mockpi');
  const a = makeApi();
  const plat = new CtrlPiPlatform(makeLog(), {
    platform: 'ctrlPi', sharedConfigPath: NO_SHARED, webhookPort: p + 100,
    agents: [{ name: 'mockpi', ip: '127.0.0.1', port: p, api_key: 'test-key' }],
    devices: [{ agent: 'mockpi', name: 'Sprinklers', accessory: 'irrigation', ...irrigationConfig }],
  }, a);
  a.emit('didFinishLaunching');
  await sleep(400);
  const h = plat.handlers.find(x => x.device.name === 'Sprinklers');

  await fn(h, st, a);

  srv.close(); plat.listener?.close();
}

console.log('\n--- irrigation: multi-zone system');
await runIrrigationTest({ zones: [{ gpio: 20, name: 'Lawn' }, { gpio: 21, name: 'Garden', duration: 10 }] }, async (h, st, a) => {
  const C = a.hap.Characteristic;
  ok('Master created', h.service.displayName === 'Sprinklers');
  const child = h.childServices.get(21);
  ok('Child zones created', !!child);

  await child.service.getCharacteristic('Active').handlers.set(1);
  await sleep(50);

  let write = st.calls.find(c => c.path === '/gpio/write/21');
  ok('Zone turns on', write && write.body.duration === 600);
  ok('Child inUse tracks active', child.inUse === C.InUse.IN_USE);
  ok('Master inUse syncs with active zone', h.inUse === C.InUse.IN_USE);

  await h.service.getCharacteristic('Active').handlers.set(0);
  await sleep(50);
  const off = st.calls.find(c => c.path === '/gpio/write/21' && c.body.value === 0);
  ok('Master off closes the running zone', !!off);

});

// A Homebridge restart must leave an output alone: re-sending an unchanged pin config
// makes the agent re-claim the pin, which can glitch a relay.
console.log('\n--- restart: unchanged pins are not reconfigured');
{
  const p = 9480;
  const { server: srv, state: st } = await startMockAgent(p, 'mockpi');
  const devices = [
    { agent: 'mockpi', name: 'Lamp', accessory: 'switch', gpio: 6, reversed: true },
    { agent: 'mockpi', name: 'Strike', accessory: 'lock', gpio: 5 },
    { agent: 'mockpi', name: 'Shed Light', accessory: 'lux', script: 'lux.sh' },
  ];
  const start = async (webhookPort, list = devices) => {
    const a = makeApi();
    const plat = new CtrlPiPlatform(makeLog(), {
      platform: 'ctrlPi', sharedConfigPath: NO_SHARED, webhookPort,
      agents: [{ name: 'mockpi', ip: '127.0.0.1', port: p, api_key: 'test-key' }], devices: list,
    }, a);
    a.emit('didFinishLaunching');
    await sleep(400);
    return plat;
  };
  const configs = () => st.calls.filter(c => c.method === 'POST' && c.path.startsWith('/gpio/config/'));

  const first = await start(p + 100);
  ok('first start configures the pins', configs().length === 2, `${configs().length} config calls`);
  ok('lock pin config carries no agent-unknown `pulse` field', configs().every(c => !('pulse' in c.body)),
    JSON.stringify(configs().map(c => c.body)));
  const lux = first.handlers.find(h => h.device.name === 'Shed Light');
  const luxValue = await lux.service.getCharacteristic('CurrentAmbientLightLevel').handlers.get();
  ok('lux starts inside HomeKit\'s range', luxValue === 0.0001, String(luxValue));
  first.listener.close();

  st.pins.set('6', 1);
  st.calls.length = 0;
  const second = await start(p + 101);
  ok('restart sends no pin config for unchanged pins', configs().length === 0, JSON.stringify(configs()));
  ok('restart sends no pin write', !st.calls.some(c => c.path.startsWith('/gpio/write/')));
  const lamp = second.handlers.find(h => h.device.name === 'Lamp');
  ok('restart reads the output\'s live state', lamp.service.getCharacteristic('On').value === true);
  second.listener.close();

  st.calls.length = 0;
  const third = await start(p + 102, [{ ...devices[0], reversed: false }, devices[1]]);
  ok('a changed pin is reconfigured', configs().length === 1 && configs()[0].path === '/gpio/config/6',
    JSON.stringify(configs()));
  third.listener.close();
  srv.close();
}

// A valve never closes by itself and shows no timer in Home unless valveDuration says so.
console.log('\n--- valve: default run time');
{
  const a = makeApi();
  const plat = new CtrlPiPlatform(makeLog(), {
    platform: 'ctrlPi', sharedConfigPath: NO_SHARED, webhookPort: 9690,
    agents: [{ name: 'mockpi', ip: '127.0.0.1', port: 9691, api_key: 'test-key' }],
    devices: [
      { agent: 'mockpi', name: 'Plain', accessory: 'valve', gpio: 1 },
      { agent: 'mockpi', name: 'Latch', accessory: 'valve', gpio: 2, valveType: 2, closeGpio: 3 },
      { agent: 'mockpi', name: 'LatchTimed', accessory: 'valve', gpio: 4, valveType: 2, closeGpio: 5, valveDuration: 10 },
    ],
  }, a);
  a.emit('didFinishLaunching');
  await sleep(200);
  const svc = name => plat.handlers.find(h => h.device.name === name).service;
  ok('plain valve has no timer (no SetDuration, no RemainingDuration)',
    !svc('Plain').testCharacteristic('SetDuration') && !svc('Plain').testCharacteristic('RemainingDuration'));
  ok('latching valve has no timer', !svc('Latch').testCharacteristic('SetDuration'));
  ok('a valve with valveDuration keeps the timer and its run time',
    await svc('LatchTimed').getCharacteristic('SetDuration').handlers.get() === 600
    && svc('LatchTimed').testCharacteristic('RemainingDuration'));
  plat.listener?.close();
}

// An agent that is offline when Homebridge starts must still get set up once it is back,
// by the retry timer or by its first (stale-key) event, without a restart.
console.log('\n--- agent offline at startup');
{
  const p = 9490;
  const a = makeApi();
  const plat = new CtrlPiPlatform(makeLog(), {
    platform: 'ctrlPi', sharedConfigPath: NO_SHARED, webhookPort: p + 100,
    agents: [{ name: 'mockpi', ip: '127.0.0.1', port: p, api_key: 'test-key' }],
    devices: [
      { agent: 'mockpi', name: 'Tap', accessory: 'valve', gpio: 7 },
      { agent: 'mockpi', name: 'Lawn', accessory: 'irrigation', zones: [{ name: 'Lawn', gpio: 20 }] },
    ],
  }, a);
  a.emit('didFinishLaunching');
  await sleep(400);

  const tap = plat.handlers.find(h => h.device.name === 'Tap');
  let error;
  try {
    await tap.service.getCharacteristic('Active').handlers.set(1);
  } catch (e) {
    error = e;
  }
  ok('valve write to an offline agent fails as a HomeKit error', error?.hapStatus === -70402, String(error));

  const { server: srv, state: st } = await startMockAgent(p, 'mockpi');
  const status = await fetch(`http://127.0.0.1:${p + 100}/webhook?agent=mockpi`, {
    method: 'POST', headers: { 'Api-Key': 'stale-key-1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ gpio: 7, value: 1 }),
  }).then(r => r.status);
  await sleep(400);
  ok('stale-key event from an agent not set up is refused', status === 401);
  ok('...and sets the agent up', (st.config.bridges.homebridge_key || '').length === 12, JSON.stringify(st.config.bridges));
  ok('...including its pins', st.config.gpios['7']?.type === 'output', JSON.stringify(st.config.gpios));

  st.config.bridges = {};
  plat.setUp.clear();
  plat.retrySetup();
  await sleep(400);
  ok('the retry timer sets up an agent not set up yet', (st.config.bridges.homebridge_key || '').length === 12);

  // An irrigation zone's own timer closing it while the agent is gone must not leave
  // an unhandled rejection, which stops Homebridge.
  let unhandled = 0;
  const onUnhandled = () => unhandled++;
  process.on('unhandledRejection', onUnhandled);
  const zone = plat.handlers.find(h => h.device.name === 'Lawn').childServices.get(20);
  zone.service.getCharacteristic('SetDuration').handlers.set(0.2);
  await zone.service.getCharacteristic('Active').handlers.set(1);
  srv.close();
  srv.closeAllConnections?.();
  await sleep(600);
  process.off('unhandledRejection', onUnhandled);
  ok('irrigation auto-off with the agent offline does not reject unhandled', unhandled === 0, `${unhandled}`);

  // A sweep that finds the agent somewhere new moves the Agent the accessories hold.
  plat.adoptSweep(new Map([['mockpi', ['127.0.0.2']]]), []);
  ok('sweep moves the running agent', tap.agent.base === `http://127.0.0.2:${p}`, tap.agent.base);
  const { statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const mode = statSync(join(a.user.storagePath(), 'ctrlpi-agents-config.json')).mode & 0o777;
  ok('local agent list is owner-only (0600)', mode === 0o600, mode.toString(8));
  plat.listener.close();
}

// Home keeps a valve's icon, so a new "Shown as" needs a new accessory.
console.log('\n--- valve: displayType change recreates the accessory');
for (const [cached, wanted, recreated] of [[0, 3, true], [2, 2, false]]) {
  const a = makeApi();
  const dropped = [];
  a.unregisterPlatformAccessories = (_p, _n, list) => dropped.push(...list);
  const valve = { agent: 'mockpi', name: 'Tap', accessory: 'valve', gpio: 5 };
  const old = new a.platformAccessory('Tap', a.hap.uuid.generate('mockpi:Tap'));
  old.context.device = { ...valve, displayType: cached };
  const plat = new CtrlPiPlatform(makeLog(), {
    platform: 'ctrlPi', sharedConfigPath: NO_SHARED, webhookPort: 9499, rescan: 0,
    agents: [{ name: 'mockpi', ip: '127.0.0.1', port: 9401, api_key: 'test-key' }],
    devices: [{ ...valve, displayType: wanted }],
  }, a);
  plat.configureAccessory(old);
  a.emit('didFinishLaunching');
  await sleep(300);
  ok(`displayType ${cached} -> ${wanted} ${recreated ? 'recreates' : 'keeps'} the accessory`,
    (dropped[0] === old) === recreated, `${dropped.length} unregistered`);
  plat.listener?.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
