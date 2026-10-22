import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { AgentConfig } from './types.js';

/** The plugin's own agent list, kept in Homebridge's storage folder. */
export const LOCAL_FILE = 'ctrlpi-agents-config.json';
export const DEFAULT_SHARED_PATH = '/home/pi/.ctrlpi/agents-config.json';

/** `YYYY-MM-DD HH:MM:SS` in UTC, the `updated_at` format every ctrlPi project uses. */
function now(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/** Reconcile overlay agents into base agents: add missing ones, or update if overlay is newer. */
export function reconcileAgentList(baseAgents: AgentConfig[], overlayAgents: AgentConfig[]): AgentConfig[] {
  const result = [...baseAgents];
  for (const overlay of overlayAgents) {
    if (!overlay || !overlay.name) {
      continue;
    }
    const idx = result.findIndex(a => a.name === overlay.name);
    if (idx === -1) {
      result.push({ ...overlay });
    } else {
      const existing = result[idx];
      const overlayDate = overlay.updated_at || '';
      const existingDate = existing.updated_at || '';
      if (overlayDate > existingDate) {
        result[idx] = { ...existing, ...overlay };
      }
    }
  }
  return result;
}

/** Read the agents list from a file, or from a `config.json` beside it when that has none. */
export function readAgentsFile(filePath: string): AgentConfig[] {
  if (existsSync(filePath)) {
    try {
      const data = JSON.parse(readFileSync(filePath, 'utf8'));
      if (Array.isArray(data.agents)) {
        return data.agents;
      }
    } catch {
      // unreadable or not JSON: try the `config.json` beside it
    }
  }
  const fallback = filePath.replace(/agents-config\.json$/, 'config.json');
  if (fallback !== filePath && existsSync(fallback)) {
    try {
      const data = JSON.parse(readFileSync(fallback, 'utf8'));
      if (Array.isArray(data.agents)) {
        return data.agents;
      }
    } catch {
      // unreadable or not JSON: no agents from it
    }
  }
  return [];
}

/** Load agents from local Homebridge config and reconcile any newer ones from shared config (read-only). */
export function loadReconciledAgents(localPath: string, sharedPath?: string): AgentConfig[] {
  const localAgents = readAgentsFile(localPath);
  if (!sharedPath) {
    return localAgents;
  }
  const sharedAgents = readAgentsFile(sharedPath);
  return reconcileAgentList(localAgents, sharedAgents);
}

/** The local file's whole content, keeping any keys besides `agents`. */
function readLocal(localPath: string): Record<string, unknown> {
  if (!existsSync(localPath)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(localPath, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Write the local file atomically and readable by its owner only (0600): it holds every
 * agent's api_key. Skipped when nothing changed, so a rescan does not rewrite it.
 */
function writeLocal(localPath: string, data: Record<string, unknown>): void {
  const text = JSON.stringify(data, null, 2);
  if (existsSync(localPath)) {
    try {
      if (readFileSync(localPath, 'utf8') === text) {
        return;
      }
    } catch {
      // unreadable: rewrite it
    }
  }
  mkdirSync(dirname(localPath), { recursive: true });
  const temporary = `${localPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text, { mode: 0o600 });
    renameSync(temporary, localPath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Preserve other agents, reconcile newer external agents (read-only), and write strictly to localPath. */
export function saveAgent(localPath: string, agent: AgentConfig, sharedPath?: string): void {
  const localData = readLocal(localPath);
  const localAgents: AgentConfig[] = Array.isArray(localData.agents) ? (localData.agents as AgentConfig[]) : [];
  const sharedAgents: AgentConfig[] = sharedPath ? readAgentsFile(sharedPath) : [];
  const reconciled = reconcileAgentList(localAgents, sharedAgents);

  const idx = reconciled.findIndex(a => a.name === agent.name);
  if (idx !== -1) {
    reconciled[idx] = { ...reconciled[idx], ...agent, updated_at: now() };
  } else {
    reconciled.push({ ...agent, updated_at: agent.updated_at ?? now() });
  }

  localData.agents = reconciled;
  writeLocal(localPath, localData);
}

/**
 * Save the platform's agent list to localPath: every known agent is reconciled in, and
 * an active agent whose address changed gets the new one and a fresh `updated_at`.
 */
export function saveAgentList(localPath: string, agents: AgentConfig[], active: AgentConfig[]): void {
  const localData = readLocal(localPath);
  const existing = (Array.isArray(localData.agents) ? localData.agents : []) as AgentConfig[];
  const reconciled = reconcileAgentList(existing, agents);
  for (const cfg of active) {
    const match = reconciled.find(a => a.name === cfg.name);
    if (!match) {
      reconciled.push({ ...cfg, updated_at: cfg.updated_at ?? now() });
    } else if (cfg.ip && match.ip !== cfg.ip) {
      match.ip = cfg.ip;
      match.updated_at = now();
    }
  }
  localData.agents = reconciled;
  writeLocal(localPath, localData);
}
