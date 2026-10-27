# Homebridge ctrlPi Plugin

[![Platform: Homebridge](https://img.shields.io/badge/platform-Homebridge%201.8%20%7C%202.0%2B-006400.svg)](#install)
[![Version 0.9.80](https://img.shields.io/badge/version-0.9.80-blue.svg)](https://github.com/ctrlpi/homebridge-ctrlpi/tags)
[![Auth: Api-Key](https://img.shields.io/badge/auth-Api--Key-orange.svg)](#authentication)
[![Agents: Pi, Pico & ESP32](https://img.shields.io/badge/agents-Pi%2C%20Pico%20%26%20ESP32-006400.svg)](#install)
[![License: MIT](https://img.shields.io/badge/license-MIT-188038.svg)](LICENSE)
![Status: Beta](https://img.shields.io/badge/status-Beta-red.svg)
[![Build Status](https://github.com/ctrlpi/homebridge-ctrlpi/actions/workflows/ci.yml/badge.svg)](https://github.com/ctrlpi/homebridge-ctrlpi/actions)

A Homebridge plugin that brings Raspberry Pi, Pico W, and ESP32 GPIO into Apple Home, by driving one or more GPIO agents over their REST API.

Runs wherever Homebridge runs, secured with API key authentication, configured entirely from the Homebridge UI.

> Looking for the GPIO servers themselves, AI-agent control, a Matter bridge or development support tools, see the [Related projects](#related-projects) below.

This plugin holds **no GPIO logic of its own**. Homebridge does not have to run on the Pi: every pin is read and driven over HTTP against a [`pi-gpio-api`](https://github.com/ctrlpi/pi-gpio-api) Pi, a [`pico-gpio-api`](https://github.com/ctrlpi/pico-gpio-api) Pico W, or an [`esp32-gpio-api`](https://github.com/ctrlpi/esp32-gpio-api) ESP32, so one Homebridge instance can front every board in the house.

```
[Apple Home]
        │  HomeKit (HAP)
        ▼
[Homebridge + homebridge-ctrlpi]
        │  REST (GET/POST, Api-Key per agent)
        ├────→ [pi5       192.168.1.50:8314]   (pi-gpio-api on a Raspberry Pi 5)
        ├────→ [kitchen   192.168.1.53:8314]   (pi-gpio-api on a Zero 2 W)
        ├────→ [shed      192.168.1.51:8314]   (pico-gpio-api on a Pico W)
        ├────→ [porch     192.168.1.52:8314]   (esp32-gpio-api on an ESP32)
        └────→ [garden    192.168.1.54:8314]   (esp32-gpio-api on an ESP32-S3)
        ▲
        └── watched-pin callbacks back to :8318, Api-Key per agent
```

## Install

**Requirements:** Homebridge 1.8 or 2.0+. Homebridge brings its own Node (20 or newer), so on a normal Homebridge install there is nothing else to set up. You also need at least one GPIO agent on your LAN.

### Option 1: Homebridge UI (recommended)

Open **Plugins**, search for **homebridge-ctrlpi**, and install it. Everything below is editable in the plugin's settings screen, so the JSON is only ever there if you prefer to write it.

### Option 2: terminal

```bash
sudo hb-service add homebridge-ctrlpi
```

Restart Homebridge afterwards, either way.

## Quick Start

1. In the Homebridge UI, open **Plugins**, find **ctrlPi** and click **Settings**.
2. Under **Devices**, click **Add** for each thing wired to an agent. Pick the **Agent** it lives on, give the device a **Name**, choose its **Accessory** type and enter the **GPIO** pin. The form shows only the fields that type needs, such as sensors for a garage door or a script for a temperature sensor.
3. Click **Save** and restart Homebridge.

Every device names the agent it lives on, and that name is carried onto the accessory, so an accessory in the Home app always says which board owns the pin behind it. The agents themselves are found on your network by name: there is nothing to declare for them.

The accessories appear in the Home app, each one individually automatable.

Nothing has to be configured on the agent first. On every start the plugin pushes each pin's configuration to its agent and registers its own callback, so the agent is set up from these settings rather than alongside them.

## Agents

An agent is known by its `name` (what it answers on `GET /hello`). Agents are found on your network automatically, see [Agent discovery](#agent-discovery).

**Filter.** `agents` narrows the list this plugin drives, without deleting anything from either file:

```json
"agents": { "mode": "whitelist", "list": "pi5, shed" }
```

`mode` is `none` (default), `whitelist` or `blacklist`; `list` is a comma-separated list of exact agent names.

## Accessories

| `accessory` | HomeKit service | Backed by |
|---|---|---|
| **Output Devices** | | |
| `fan` | Fan | an output pin |
| `lightbulb` | Lightbulb | an output pin |
| `outlet` | Outlet | an output pin, optional in-use input |
| `switch` | Switch | an output pin |
| **Input Devices** | | |
| `button` | Stateless Programmable Switch | an input pin, single / double / long press |
| `contact` | Contact Sensor | an input pin |
| `dioxide` | Carbon Dioxide Sensor | an input pin |
| `indicator` | Lightbulb, read-only | an input pin, shows its state as a light; taps are ignored |
| `leak` | Leak Sensor | an input pin |
| `monoxide` | Carbon Monoxide Sensor | an input pin |
| `motion` | Motion Sensor | an input pin |
| `occupancy` | Occupancy Sensor | an input pin |
| `smoke` | Smoke Sensor | an input pin |
| **Combined Devices** | | |
| `garagedoor` | Garage Door Opener | a relay pin, optional open and close sensors |
| `irrigation` | Irrigation System | one relay pin per zone, each zone a Valve |
| `lock` | Lock Mechanism | one or two relay pins, optional door and bolt sensors |
| `shades` | Window Covering | an up and a down relay, optional limit sensors |
| `valve` | Valve | one or two relay pins, optional position sensor |
| **Environment Sensors** | | |
| `humidity` | Humidity Sensor | an agent **script**, polled |
| `lux` | Light Sensor | an agent **script**, polled |
| `temperature` | Temperature Sensor | an agent **script**, polled |

### Config fields

| Field | Applies to | Description |
|---|---|---|
| `name` | all | The accessory's name in the Home app. Also pushed to the agent as that pin's name. |
| `agent` | all | The name of the agent this device is wired to. Required. |
| `accessory` | all | One of the types above (default `switch`). |
| `gpio` | pin-backed | The BCM pin on a Pi, the GP pin on a Pico, the GPIO number on an ESP32. |
| `reversed` | pin-backed | Invert the pin, for an active-low relay. |
| `pullup` | inputs | Agent-side pull resistor, `"up"`, `"down"` or `"none"` (default `"up"`). On a combined device it applies to all its sensors. |
| `pulse` | outputs, `shades` | Pulse: the agent drives the pin and reverts it itself rather than latching. |
| `duration` | pulsed outputs | Pulse length in seconds (default `2` for outputs, garage doors and shades; `3` for locks; `23` for latching valves). |
| `tooLong` | outputs | Log a warning when the output has been on this many minutes. |
| `closeSensor` / `openSensor` | `garagedoor`, `shades` | Input pins reporting fully closed / fully open. |
| `closeSensorReversed` / `openSensorReversed` | `garagedoor`, `shades` | Invert either sensor. |
| `timeToOpen` / `timeToClose` | `garagedoor`, `shades` | Travel time in seconds (default `18`). |
| `closeGpio` | latching `valve`, motorized `lock`, `shades` | The second relay. Optional for shades with `pulse: true`. |
| `closeReversed` | latching `valve`, motorized `lock`, `shades` | Invert the second relay (defaults to `reversed`). |
| `inUseGpio` / `inUseReversed` | `valve`, `outlet` | Input confirming it really is on, and whether to invert it. |
| `valveType` | `valve` | Wiring, see [Valves](#valves). |
| `valveDuration` | `valve` | Default run time in minutes (default `20`, `0` disables automatic closing). |
| `displayType` | `valve` | How Home shows it: `0` generic, `1` irrigation, `2` shower head, `3` water faucet. |
| `lockType` | `lock` | Wiring, see [Locks](#locks). |
| `doorSensor` / `doorSensorReversed` | `lock` | Input reporting the door shut. Locking is refused while it reads open. |
| `lockedSensor` / `lockedSensorReversed` | `lock` | Input confirming the bolt is thrown. |
| `zones` | `irrigation` | `[{ name, gpio, duration, reversed }]`, see [Irrigation](#irrigation). |
| `script` | measured | The script the agent runs for this reading: `"<file> [args...]"`, a bare filename in the agent's `scripts/` folder. Required. |
| `field` | measured | Only when the script returns several fields: which one to read. |
| `interval` | measured | How often the agent runs the script, in seconds (default `900`, 15 minutes). `0` reads once at start and never again. |

### Sensors

Input pins show up as these devices. **High** is a pin value of 1 as the agent reports it, after `reversed` is applied.

| `accessory` | HomeKit service | High | Low |
|---|---|---|---|
| `contact` | Contact Sensor | Open (contact not detected) | Closed (contact detected) |
| `motion` | Motion Sensor | Motion detected | No motion |
| `occupancy` | Occupancy Sensor | Occupancy detected | No occupancy |
| `smoke` | Smoke Sensor | Smoke detected | No smoke |
| `monoxide` | Carbon Monoxide Sensor | Carbon monoxide detected | No carbon monoxide |
| `dioxide` | Carbon Dioxide Sensor | Carbon dioxide detected | No carbon dioxide |
| `leak` | Leak Sensor | Leak detected | No leak |
| `indicator` | Lightbulb (read-only) | On | Off |

A `contact` sensor reads as Open when high because HomeKit reports 1 as "contact not detected". With a reed switch wired the usual way, a closed door is low; set `reversed` if yours is the other way round. An `indicator` looks like a lightbulb but ignores taps, Siri and scenes, and snaps back to the pin's real state.

**Polled sensors.** `temperature`, `humidity` and `lux` are backed by a script the agent runs, and **the plugin configures that sensor itself**. You give it the script; you do not have to create the sensor on the agent first, or keep a sensor name in step between two places.

```json
{ "agent": "pi5", "name": "Attic", "accessory": "temperature", "script": "dht22.sh 4", "field": "temp" }
```

On every start the plugin sends that script to the agent under a sensor named after the device (`Attic Temp` becomes `attic-temp`), so editing the script in the settings and restarting is all it takes to change what runs. `script` is `"<file> [args...]"` where the file is a bare filename in the agent's `scripts/` folder and the arguments are letters and digits only: the agent validates that at config time and again on every read, and will only ever run a script from that one folder.

`field` is only needed when the script returns several values at once. A script printing `{"temp": 21.5, "humidity": 55}` needs `"field": "temp"`; one printing a bare number needs no `field` at all.

Polling defaults to **15 minutes** (`interval`, in seconds). That is deliberately slow: unlike a pin, a reading makes the agent actually execute a script, so it is real work on the device rather than something free to ask for repeatedly.

### Garage doors

A garage opener has one button: every pulse means "next action", and a pulse while the door is moving **stops** it. So if you press mid-travel, the plugin sends that single pulse and leaves the door stopped.

**Use at least one sensor.** Add a `closeSensor`, an `openSensor`, or both. Without a sensor the plugin cannot see the door, so it only guesses its state from `timeToOpen` and `timeToClose`. With a sensor it knows when the door has really finished, and when someone uses the wall button, Home shows the door opening or closing. The travel time plus 5 seconds is then only a safety net that reports an obstruction.

### Valves

Three valve types are supported, chosen with `valveType`:

| `valveType` | Wiring |
|---|---|
| `0` | normally closed, single control: energised means open |
| `1` | normally open, single control: energised means closed |
| `2` | latching / pulsed, two controls: a pulse on `gpio` opens, a pulse on `closeGpio` closes |

A latching valve holds position with no power, so the relay state afterwards says nothing about where the valve is. Add `inUseGpio` for real feedback.

`valveDuration` sets the run time Home starts with, and the valve closes itself when it runs out. Home can change the run time per valve.

### Locks

Three lock types are supported, chosen with `lockType`:

| `lockType` | Wiring |
|---|---|
| `0` | fail-secure strike: a pulse on `gpio` unlocks, and it relocks by itself when the pulse ends |
| `1` | fail-safe maglock: `gpio` held on locks, off unlocks |
| `2` | motorized, two relays: a pulse on `gpio` unlocks, a pulse on `closeGpio` locks |

With no `lockedSensor` the plugin shows the state it last commanded, and assumes locked at startup. With `doorSensor` it refuses to lock while the door reads open, and until it has read the sensor once.

### Shades

Shades use one relay to open (`gpio`) and one to close (`closeGpio`). There are two ways to drive them, chosen with `pulse`:

- **`pulse: false` (default):** the relay stays on while the shade moves, for up to its travel time. Use this for motors that run only while powered.
- **`pulse: true`:** the relay gives a short pulse, like pressing a remote button. Use this for controllers that start on a press and stop on the next press. `closeGpio` is optional: with a single input, every move and stop is a pulse on `gpio`. Stopping at a position in between sends a stop pulse, and a full open or close lets the controller's own end limits stop the motor.

The shade's position is estimated from `timeToOpen` and `timeToClose`. Add a `closeSensor` and an `openSensor` to correct the position at each end.

### Irrigation

`irrigation` is one Irrigation System with a Valve per zone. Add a zone for each sprinkler valve, with its name and GPIO.

Each zone's `duration` is its default run time in minutes (default `20`, at most `60`); Home can change it per zone, up to an hour. The agent times each run and never holds a zone's relay on longer than an hour, and turning the system off closes every running zone.

### Validation

The settings form will not save while any device breaks a rule (the check mark at the top turns into a red warning and **Save** is disabled). Startup checks the same rules again, for a hand-edited configuration: a device that breaks one is skipped, with an error in the log naming it and the rule, and every other device loads.

- Device and agent names must not be blank, and a device name must be unique on its agent. Pin-backed devices need `gpio`, measured sensors a non-blank `script`, and shades (unless `pulse: true`) and motorized locks and latching valves `closeGpio`.
- Pins accept non-negative integers or digit strings, including `0`; optional pins may be left blank.
- Pulse and travel times are in seconds (at least `0.001`), `interval` in whole seconds (`0` reads once at start only, up to `3600` in the form), and `rescan` and `tooLong` in whole minutes. `valveDuration` and zone durations are in minutes, up to `60`, the longest run HomeKit can show.
- An irrigation system can be saved before it has zones, and the form's empty zone row is ignored. A zone counts as used once it has a name or a GPIO. It needs a GPIO; without a name it is called `GPIO <pin>`. A zone that breaks a rule is skipped and the rest of the system stays.

## Platform fields

| Field | Default | Description |
|---|---|---|
| `name` | `ctrlPi` | The platform's name in the Homebridge log. |
| `devices` | `[]` | The accessories, see [Accessories](#accessories). |
| `agents` | no filter | `{ mode, list }`, see [Agents](#agents). |
| `rescan` | `60` | Background discovery interval in minutes, `0` to disable. |
| `sharedConfigPath` | `/home/pi/.ctrlpi/agents-config.json` | The shared agent list, read only. |
| `localConfigPath` | `<storage>/ctrlpi-agents-config.json` | The plugin's own agent list, in Homebridge's storage folder. JSON only. |
| `webhookPort` | `8318` | Port of the plugin's event listener. JSON only. |

`localConfigPath` and `webhookPort` are not in the settings form, because the defaults suit everyone; they can still be set by hand in the JSON. The same goes for an agent's `port` (default `8314`).

## Authentication

Two independent keys are in play, and they are never the same one:

| Key | Where it lives | What it does |
|---|---|---|
| the agent's `api_key` | the agent lists (see [Agent discovery](#agent-discovery)) | Each **agent's** own key, sent as an `Api-Key` header on every REST call the plugin makes. |
| the callback key | generated, never configured | Gates **this plugin's** event listener. Regenerated on every start and pushed to each agent. |

On every start the plugin generates a fresh 12-character key per agent and pushes it alongside the callback URL, into that agent's `bridges.homebridge` and `bridges.homebridge_key` fields. The agent presents it as an `Api-Key` header on each event, and anything arriving without it is refused with a `401` and logged as a `[SECURITY]` error. A stale key from a previous run therefore stops working the moment the plugin restarts.

The plugin reads the agent's config back after the push, and only counts the agent as registered once it echoes both the URL **and** the key.

An agent that is offline when Homebridge starts is tried again every 2 minutes. If it comes back still holding the key from a previous run, its first event is refused and sets it up at once; the agent retries the delivery, and by then it has the new key.

> **No TLS.** The agents' REST API and this plugin's listener both speak plain HTTP, so keys travel as plaintext. That is fine on a trusted LAN, but do not expose port 8318 or an agent's 8314 to the internet.

## Agent discovery

The plugin builds its agent list from three places:

1. **The shared list** at `sharedConfigPath` (default `/home/pi/.ctrlpi/agents-config.json`), kept by the other ctrlPi tools. The plugin only reads it.
2. **Its own list**, `ctrlpi-agents-config.json` in Homebridge's storage folder. Everything the plugin learns is written here.
3. **Every agent a device names**, added by name and located on the network.

Where both files hold the same agent, the newer entry wins. An agent's `api_key` comes from those files; with none, the plugin uses the default `your-secret-key`.

At startup and every `rescan` minutes (default `60`) the plugin sweeps the local /24 networks for agents answering `/hello`, and follows an agent that moves to a new address. An agent still without an address when a device needs it is looked up by name (and `<name>.local`). Set `rescan` to `0` to turn sweeps off. An agent with an `ip` is taken at its word, which is how you reach one on another subnet.

When two boards answer to the same name, the plugin logs a `[SECURITY]` error, then renames each extra board that still accepts the default key to `<name>-<last octet>` and gives it a fresh random key.

> On Raspberry Pi OS Bookworm, home folders are private, so Homebridge may not be able to read `/home/pi/.ctrlpi/`. Agents are then found by discovery alone, with the default key. Point `sharedConfigPath` at a file Homebridge can read if your agents use other keys.

## How it works

**Nothing is polled except named sensors.** At startup the plugin configures each pin it needs events for with `watched: true` and registers its own callback. From then on the agent POSTs a small JSON body whenever a pin changes, including changes the plugin did not cause, so a wall switch or a physical button shows up in HomeKit immediately. Only `temperature`, `humidity` and `lux` are polled, because a sensor is a script the agent runs on demand and there is nothing for it to watch.

**A restart leaves your outputs alone.** On every start the plugin compares each pin's wanted config with what the agent already stores, and only sends the ones that differ. Re-sending an unchanged output would make the agent re-claim the pin, which can glitch a relay, so a Homebridge restart never touches a light, a relay or a maglock that is already set up. What an output does when the **agent** itself reboots is the agent's `init` setting (`"last"` restores the previous state), set on the agent rather than here.

**Pulses are timed by the agent.** A momentary output sends `duration` with the write, and the pin's `max` caps how long it may stay driven, so the agent reverts it itself. If Homebridge restarts mid-pulse the relay still releases, which a plugin-side timer cannot promise.

**Accessories are keyed by agent and name.** An accessory's identity is its agent name plus its own `name`, so moving a device to another pin keeps its room, scenes and automations, while renaming it in the settings creates a new accessory. Changing a device's `accessory` type, or a valve's `displayType` (Home keeps the icon it first saw), recreates it too. Removing it from the config removes it from the Home app on the next restart.

## Files

The state the plugin persists, besides what Homebridge itself keeps in its accessory cache. Each is created when first needed, so there is nothing to set up by hand.

| File | Contents |
|---|---|
| `ctrlpi-agents-config.json` in Homebridge's storage folder (`/var/lib/homebridge` on a standard Pi image) | The plugin's own agent list: `{name, ip, port, api_key, updated_at}` per agent, from discovery and the shared list. Readable by its owner only, since it holds the agents' keys. Other ctrlPi tools read it, never write it |
| `/home/pi/.ctrlpi/agents-config.json` | The shared agent list. Read only: the plugin never writes it |

## Tests

```bash
npm install
npm test
npm run lint
```

`npm test` builds the plugin and runs it against a stand-in ctrlPi agent and a stub Homebridge API, with no hardware, no Homebridge and no LAN scan, in a temporary folder: the settings validation cases, agent configuration over REST, restarts that leave outputs alone, agents offline at startup, the single-pulse garage door rule, webhook authentication, event-driven state, discovery and its backoff, the optional `api_key`, and the lock, shades and irrigation devices.

## Related projects

- **[`pi-gpio-api`](https://github.com/ctrlpi/pi-gpio-api)**: Raspberry Pi GPIO REST server that reads inputs and drives outputs (and named sensors) over an HTTP API.
- **[`pico-gpio-api`](https://github.com/ctrlpi/pico-gpio-api)**: Raspberry Pi Pico W port of the GPIO REST server, with the same endpoints, wire format, and auth.
- **[`esp32-gpio-api`](https://github.com/ctrlpi/esp32-gpio-api)**: ESP32 port of the GPIO REST server for MicroPython, with the same endpoints, wire format, and auth.
- **[`mcp-bridge`](https://github.com/ctrlpi/mcp-bridge)**: MCP server that exposes GPIO control as tools for AI agents (e.g. Claude), executing them over the agents' REST API.
- **`matter-bridge`** *(coming soon)*: Matter bridge that exposes GPIO pins and sensors to any Matter platform (Apple Home, Google Home, Alexa, Home Assistant), driven over the agents' REST API.
- **[`ctrlpi-cli`](https://github.com/ctrlpi/ctrlpi-cli)**: Command-line interface for interacting with ctrlPi agents, with shared agent configuration.
- **[`ctrlpi-lab`](https://github.com/ctrlpi/ctrlpi-lab)**: A local browser dashboard for your ctrlPi setup. Test GPIO and sensor endpoints, watch webhook events, and tail agent logs.
- **[`pico-bay`](https://github.com/ctrlpi/pico-bay)**: Web app and MCP server for managing MicroPython and CircuitPython boards, such as the Raspberry Pi Pico and ESP32, over USB.
- **`pi-bay`** *(coming soon)*: A local web app and MCP server for Raspberry Pi boards over the network. Edit files, open a remote terminal, and manage your Pi remotely.

## License

[MIT](LICENSE)
