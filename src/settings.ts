/**
 * Platform name users put in the Homebridge config's `platform` field.
 */
export const PLATFORM_NAME = 'ctrlPi';

/**
 * Must match the `name` in package.json.
 */
export const PLUGIN_NAME = 'homebridge-ctrlpi';

/**
 * Default REST port of a pi-gpio-api / pico-gpio-api agent.
 */
export const DEFAULT_AGENT_PORT = 8314;

/**
 * The Api-Key every agent ships with. An agent with no key in the agent lists is
 * sent this one, which is right for a board that has never been re-keyed.
 */
export const DEFAULT_AGENT_KEY = 'your-secret-key';

/** Default port for this plugin's webhook listener (the agents' callbacks). */
export const DEFAULT_WEBHOOK_PORT = 8318;

/**
 * This plugin's callback slot in the agent's `bridges` object: the URL and the key the
 * agent sends with each event. Each bridge has its own slot, so several can drive one
 * agent at once. Needs an agent on 0.9.21 or newer.
 */
export const CALLBACK_FIELD = 'homebridge';
export const CALLBACK_KEY_FIELD = 'homebridge_key';
