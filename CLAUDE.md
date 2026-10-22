# CLAUDE.md - homebridge-ctrlpi

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## The README is locked

`README.md` is done. Do not edit it without the user's explicit confirmation, even for a small wording or formatting fix, and even to keep it in sync with another project's README.

## What this project is

A **Homebridge dynamic platform plugin** (TypeScript, ESM) that exposes ctrlPi GPIO agents to Apple
Home through an existing Homebridge install. It holds **no GPIO logic**: every read and write is an
HTTP call to a `pi-gpio-api` Pi, a `pico-gpio-api` Pico W or an `esp32-gpio-api` ESP32 over its REST
API, and pin changes arrive as webhook callbacks rather than by polling.

It is the plugin-shaped sibling of `homekit-bridge`. Same agents, same callback protocol, same device
vocabulary, but it runs inside someone else's Homebridge rather than as its own hap-nodejs process.
Devices are configured in **Homebridge's own `config.json`** (the settings form); agents come from
the agent lists below, not from that config.

## Agent lists and reconciliation

To avoid writing outside Homebridge's storage, `homebridge-ctrlpi`:
- Writes discovered/updated agents exclusively to `ctrlpi-agents-config.json` in
  `api.user.storagePath()` (`/var/lib/homebridge` on a standard Pi image; `localConfigPath`, JSON
  only). Both `saveAgent()` and `saveAgentList()` write it atomically with mode `0600` (it holds
  every agent's `api_key`) and skip the write when nothing changed.
- Reads `/home/pi/.ctrlpi/agents-config.json` (`sharedConfigPath`, in the form) strictly **read-only**.
- Reconciles on each read (`src/shared-config.ts`): agents missing locally are added, and the entry
  with the newer `updated_at` wins.
- **Never writes** to the shared file.

An agent's `api_key` comes only from those files (blank falls back to `DEFAULT_AGENT_KEY`). The
platform config's `agents` is a filter, `{ mode: 'none' | 'whitelist' | 'blacklist', list: 'a, b' }`.
A legacy `agents: [{ name, ip, port, api_key }]` array is still accepted in hand-written JSON (the
tests use it) and is merged over the files; it is not documented in the README.

## Unscoped package name

The package name is **unscoped** (`homebridge-ctrlpi`), because Homebridge discovers plugins
named `homebridge-*` with the `homebridge-plugin` keyword in `package.json`, and installs them
through the Homebridge UI or `npm install homebridge-ctrlpi`. Publishing is described in the
root `CLAUDE.md` only.

## It has its own callback slot: `bridges.homebridge` on 8318

This plugin claims an agent's `bridges.homebridge` + `bridges.homebridge_key` fields. Those are its
own, **not** the `bridges.homekit` pair the standalone `homekit-bridge` uses. Both projects put pins
in the Home app, so a household may well run one of each, and while they shared a single slot
whichever configured itself last silently stopped the other receiving events. With a slot each they
drive the **same** agent at once, on separate ports: 8315 mcp-bridge, 8316 homekit-bridge, 8317
matter-bridge, 8318 this plugin. That needs an agent on **0.9.21 or newer**, which is where the
`homebridge` fields were added; older agents do not have them and no events arrive.
`DEFAULT_WEBHOOK_PORT` in `src/settings.ts` says the same thing.

## Architecture

```
src/index.ts              # registerPlatform(PLATFORM_NAME, CtrlPiPlatform)
src/settings.ts           # PLATFORM_NAME, PLUGIN_NAME, ports, default key, the bridges.homebridge field names
src/types.ts              # DeviceConfig / AgentConfig / AgentFilter / PinInfo - mirrors config.schema.json
src/validation.ts         # validateConfiguration(): hand-written per-device rules, a bad device is logged and skipped, pin strings -> numbers
src/shared-config.ts      # agent list files: read, reconcile, saveAgent()
src/agent-api.ts          # Agent: the REST client for one agent, one fetch wrapper, idempotent configurePin()
src/discovery.ts          # AgentLocator: subnet sweep, hostname fallback, duplicate-name handling
src/platform.ts           # CtrlPiPlatform: agent list, accessory lifecycle, webhook listener, rescan
src/accessories/
  base.ts                 # CtrlPiAccessory abstract: info service, stale-service cleanup, wrap(), the 4 hooks
  factory.ts              # device.accessory -> accessory class
  switchLike.ts           # switch / fan / lightbulb / outlet (outlet: optional inUseGpio)
  sensor.ts               # contact / motion / occupancy / smoke / monoxide / dioxide / leak
  button.ts               # StatelessProgrammableSwitch (single / double / long press)
  garageDoor.ts           # GarageDoorOpener, with open/close sensors and travel timing
  valve.ts                # Valve, optionally with a separate close pin and in-use pin
  lock.ts                 # LockMechanism: fail-secure, fail-safe, motorized; door and bolt sensors
  shades.ts               # WindowCovering: up/down relays, timed position, limit sensors
  irrigation.ts           # IrrigationSystem with one linked Valve per zone
  measured.ts             # temperature / humidity / lux, backed by an agent sensor
config.schema.json        # Drives the Homebridge UI. Must stay in step with types.ts and the rules in validation.ts
                          # Ports and localConfigPath are deliberately absent: JSON-only, see below
test/                     # Run by `npm test`. Not published
  tests.mjs               # entry: imports validation.mjs and regressions.mjs, then the platform tests
  harness.mjs             # fake Homebridge API (makeApi, makeLog), temp storage per api, NO_SHARED
  stub-agent.mjs          # stand-in agent (startMockAgent) recording every call
```

Every accessory class implements the four hooks on `CtrlPiAccessory`: `createService()`,
`watchedPins()`, `configureAgent()`, `onEvent()`. Accessories with extra services (irrigation zones)
override `getActiveServices()`, or the base constructor removes them as stale. To add a device type,
add it to the `DeviceType` union, the `factory.ts` switch, and `config.schema.json` (the `accessory`
`oneOf` **and** its `pattern`, plus the `allOf` required-field rules). A new pin field also goes in
the `PINS` list in `validation.ts`, which turns digit strings into numbers, and its rules if the field is required or ranged.

### The settings form (homebridge-config-ui-x)

Checked against a real Homebridge UI (5.29), not just a validator:

- **`strictValidation: true`** at the schema root is what makes validation mandatory: without it the
  UI shows an orange warning and saves an invalid form anyway. The UI validates the whole form with
  the `allOf` if/then rules, so a conditional requirement blocks Save even though the field gets no
  `*`; say "Required." in that field's description instead.
- **Never put a property-level `required: true`** (or a plain `required` entry) on a field that is
  only conditionally required, such as `gpio`: the UI checks it on hidden fields too, so irrigation
  and measured sensors could never be saved.
- **An `integer` with `minimum` and `maximum` renders as a slider** starting at its midpoint unless
  its layout entry says `"type": "integer"`. `validation.mjs` asserts every such field has one.
- **`tooLong` (Warn if on for) is JSON only**: it stays in the schema but is deliberately left out
  of the layout, and `validation.mjs` asserts it stays out. Do not add it back to the form.
- **The Advanced fieldset is hidden** only for a device type with none of its fields. Its
  `condition` reads only `accessory`, so editing a field inside it never collapses it. A new field
  in it means adding its device types to that list; `regressions.mjs` checks every type.
- **An array's layout `items` always gives one visible row**, so the irrigation form shows an empty
  zone row that saves as `{ reversed: false }`. Removing the `items` stops existing zones rendering at
  all, so keep them; the zone rule (`if` used, `then` name and gpio) and `validateConfiguration()`'s
  blank-row filter both treat a row with no name and no GPIO as unused.

`createService()` runs inside the base constructor, before subclass fields are initialised, so a
subclass must not rely on its own field initialisers there (see the comments in `sensor.ts`,
`garageDoor.ts`, and the `declare` field in `irrigation.ts`).

### Units

Pulse and travel times (`duration`, `timeToOpen`, `timeToClose`) are **seconds**; `valveDuration`,
zone `duration`, `tooLong` and `rescan` are **minutes**; `interval` is seconds. `Agent.writePin()`
takes milliseconds and sends the agent seconds. `valve.ts` converts `valveDuration` to seconds in
place on the device object, once, in `createService()`.

### Startup order

`didFinishLaunching` fires `discoverDevices(true)`, which:

1. Loads and reconciles the agent files, starts a background sweep (not awaited; `adoptSweep()`
   applies it), adds every agent a device names, and applies the `agents` filter (or merges a
   legacy array).
2. Builds an `Agent` per remaining agent, **reusing** the existing object for a known name
   (`Agent.update()`), and writes the list back to the local file.
3. Once per run (`built`): resolves each device to a UUID via `deviceId()`, then registers,
   restores, recreates (type changed) or unregisters (no longer configured) accessories, records
   `${agent}:${gpio}` routes for the webhook dispatcher, and starts the listener.
4. `configureAgents()`: `setUpAgent()` for every agent in parallel. That pushes a **freshly
   generated per-agent key** with the callback URL, then calls `configureAgent()` on each accessory
   of that agent to set its pins up.

Every `rescan` minutes `discoverDevices(false)` repeats steps 1 and 2. Agent objects are never
replaced, because every accessory holds the one it was built with: a moved agent is
`relocate()`d in place. Every 2 minutes (`SETUP_RETRY_INTERVAL`) `retrySetup()` runs
`setUpAgent()` again for any agent not yet in `setUp` (unreachable at its last attempt).

### The UUID seed decides accessory identity

`deviceId()` is `${agent}:${name}` for every device. Moving a device to another pin keeps the
accessory; renaming it creates a new one. For a sensor-backed device that is doubly right: the sensor
on the agent is named after the device, so it is a different sensor too. `base.ts` `serial()` uses a
different rule (`${agent}:gpio${n}`, or the name for sensor-backed devices) and only sets the
SerialNumber. Changing the `deviceId()` seed **renames every accessory in everyone's Home app**,
losing rooms, scenes and automations.

### Callback authentication

A new 12-character key is generated per agent on **every start** and pushed into that agent's
`bridges.homebridge_key`. The listener refuses any POST that does not carry it (401), so a stale
key from a previous run stops working. `Agent.pushCallback()` verifies the push by **reading the
config back**, and only then sets `configured`. A refused POST from a known agent that is not
`configured` (offline at startup, still holding an old key) triggers `setUpAgent()` and is logged
as a warning; the agent's own delivery retry then lands. Anything else refused is logged as
`[SECURITY] Cyber attack: ...`. Older agents (before 0.9.21) ignore the fields and get a clear
upgrade error in the log; they count as set up (reachable), so the retry timer leaves them alone.

### A restart must not touch outputs

Re-sending an unchanged `/gpio/config` makes the agent re-claim the pin (the Pi closes and
reopens the gpiozero device), which can glitch a relay. So `Agent.configurePin()` compares the
wanted config with the agent's stored `gpios` (read once per setup by `pushCallback()`) and only
POSTs a pin that differs, comparing the way the agents store fields (`watched` only as true, `max`
only when nonzero, `pullup` only on inputs). Never send a field the agents do not know (lock.ts
used to send `pulse`): it would never match, so that pin would be reconfigured on every start.

## Sensors are configured, not looked up

A `temperature` / `humidity` / `lux` device names a **`script`**, not an existing sensor. The plugin
calls `POST /sensor/config/{name}` on every start to create it, named after the device slugified
(`Attic Temp` -> `attic-temp`), so nothing has to exist on the agent first and there is no second
name to keep in step. `field` picks one value out of a multi-field reading. `interval` is the poll
period in seconds, **default 900** (15 minutes); these are the only devices that poll at all.

## Development

```bash
npm run build     # rimraf dist && tsc
npm run lint      # eslint . --max-warnings=0   (must be clean; test/ needs the Node globals block)
npm test          # build, then node test/tests.mjs against stand-in agents on 127.0.0.1:9401+
```

`test/tests.mjs` constructs `CtrlPiPlatform` directly with a fake Homebridge API
(`test/harness.mjs`) and a stand-in agent (`test/stub-agent.mjs`) that records every call into
`state.calls` / `state.sensors`. Assert against those, and reach an accessory through
`platform.handlers.find(h => h.device.name === '...')`. `validation.mjs` checks the validation rules and the form layout,
`regressions.mjs` the lock, shades, discovery, persistence and polling fixes.

Tests must never touch real files or agents: every test platform passes
`sharedConfigPath: NO_SHARED`, and `makeApi()` gives each platform its own temporary storage
folder, so nothing is read from `/home/pi/.ctrlpi/` (on the test Pi that file names real agents,
and a test platform would push its callback into them) or written to `/var/lib/homebridge`.
`tests.mjs` stubs `AgentLocator.prototype.sweep`, so no test scans the LAN.

**The version is written twice**: `package.json` `version` and `this.version` in the
`CtrlPiPlatform` constructor, which becomes the HomeKit FirmwareRevision. The README's version pill
is a third copy. Change all of them together.

## Related projects

`pi-gpio-api` / `pico-gpio-api` / `esp32-gpio-api` are the agents this drives. `homekit-bridge` is
the standalone equivalent, `matter-bridge` the Matter one. See the monorepo root `CLAUDE.md` for how
they fit together.

## An agent's address is optional

An agent with no `ip` in either file (or one a device names that no file knows) is found by name.
The rules, in `src/discovery.ts` and `src/platform.ts`:

- **The background sweep** (startup and every `rescan` minutes, port 8314) asks every address on
  every local /24 for its unauthenticated `/hello`. `adoptSweep()` saves each name answering from
  exactly one address to the local file when the address is new, and relocates that running
  `Agent`. It ignores the backoff below.
- **On demand**, `Agent.ensureAddress()` calls `AgentLocator.locate()`: a sweep if one is due, then
  the name (and `<name>.local`) as a hostname, checked against `/hello`. An empty lookup is retried
  after `MIN_SEARCH_INTERVAL` (2 minutes), and after `FAILURES_BEFORE_BACKOFF` (3) empty sweeps in a
  row after `LONG_SEARCH_INTERVAL` (30 minutes) until one succeeds. `rescan: 0` disables sweeping;
  hostname lookups still run.
- **Two or more** addresses answering to one name are logged as a `[SECURITY]` error and not used.
  Each extra board that still accepts the default key is renamed `<name>-<last octet>` and re-keyed
  with a random key, saving the new identity to the local file **before** touching the board.
- An agent named with a dotted IPv4 address uses it as its address.

An agent found on demand drops its address as soon as a request fails, so the next call looks it up
again. An agent **with** an `ip` (including one the sweep saved to the local file on an earlier run)
is never searched for on demand: that is how you reach one a scan cannot see. The background sweep
still moves it if it shows up at a new address.

`ensureAddress(wait)` is the seam. Everything waits for the search except `readPin` and
`readSensor`: a sweep takes seconds, Homebridge warns about a read handler that slow, so those
fail fast and the accessory reports its last known state while the search continues behind it.

## Ports are not in the settings form

`webhookPort`, `localConfigPath` and an agent's `port` are read from the config but are **not** in
`config.schema.json`, so the UI never shows them. The defaults (8318, the Homebridge storage folder,
8314) are right for everyone, and anyone who genuinely needs to move one can still put it in the JSON
by hand. Do not add them back to the schema.
