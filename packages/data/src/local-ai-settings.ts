/**
 * The intelligence layer's settings: whether local models are on, whether
 * Nova Intelligence is on, where each listens, and which provider is in use.
 *
 * ── Two switches, both off until asked ──────────────────────────────────────
 * Atlas works completely with no model connected, so neither one is on by
 * default and neither is probed until the user turns it on — polling a port
 * nobody asked Atlas to talk to would be a connection attempt without
 * consent, however harmless the destination. A stored value that is anything
 * other than the string `'true'` reads as off, so a corrupted or half-written
 * preference fails closed.
 *
 * ── Why an endpoint is stored at all ────────────────────────────────────────
 * So a server on a non-default port can be reached without a rebuild. It is
 * not a general destination field: `validate_base_url` in `intelligence.rs`
 * refuses anything that is not loopback, so the worst a bad value can do is
 * fail to connect. That validation lives on the native side because that is
 * the side that actually makes the request.
 *
 * Same `MemoryStore`-backed `Fact` pattern as `preferences.ts` — subject-keyed,
 * `kind: 'preference'` — not a new store. Cloud providers are configured
 * separately (`cloud-provider-settings.ts`); their keys never come through
 * here.
 */

import type { Storage } from '@atlas/core';
import { MemoryStore } from './memory-store';

const LOCAL_ENABLED = 'local.enabled';
const LOCAL_URL = 'local.baseUrl';
const NOVA_ENABLED = 'nova.enabled';
const NOVA_URL = 'nova.baseUrl';
const NOVA_FOLDER = 'nova.folder';
const NOVA_AUTOSTART = 'nova.autoStart';
/** Which provider is active, or none. */
const ACTIVE_SUBJECT = 'provider.active';

export interface EndpointSettings {
  enabled: boolean;
  /** Empty means "wherever it normally listens" — resolved on the native side. */
  baseUrl: string;
}

/**
 * Nova Intelligence is a program that lives in its own folder (Python, plus a
 * trained model), not something the Atlas installer carries — so besides where
 * it listens, Atlas keeps where it is, and whether to start it for you.
 */
export interface NovaSettings extends EndpointSettings {
  /** The NovaIntelligence folder the person chose. Empty means "look in the usual places". */
  folder: string;
  /**
   * Start the server when Atlas opens, if Nova Intelligence is switched on and
   * not already running. On by default — switching it on is the request. It
   * only ever applies once the person has switched Nova Intelligence on.
   */
  autoStart: boolean;
}

export interface LocalAiSettings {
  /** Local models, served by Ollama on this machine. */
  local: EndpointSettings;
  /** The from-scratch Nova Intelligence model, served by its own local process. */
  nova: NovaSettings;
}

export const DEFAULT_LOCAL_AI_SETTINGS: LocalAiSettings = {
  local: { enabled: false, baseUrl: '' },
  nova: { enabled: false, baseUrl: '', folder: '', autoStart: true },
};

async function readEndpoint(
  memory: MemoryStore,
  enabledSubject: string,
  urlSubject: string,
): Promise<EndpointSettings> {
  const [enabled, baseUrl] = await Promise.all([
    memory.fact('preference', enabledSubject),
    memory.fact('preference', urlSubject),
  ]);
  return {
    enabled: enabled?.value === 'true',
    baseUrl: typeof baseUrl?.value === 'string' ? baseUrl.value : '',
  };
}

export async function readLocalAiSettings(storage: Storage): Promise<LocalAiSettings> {
  const memory = new MemoryStore(storage);
  const [local, novaEndpoint, folder, autoStart] = await Promise.all([
    readEndpoint(memory, LOCAL_ENABLED, LOCAL_URL),
    readEndpoint(memory, NOVA_ENABLED, NOVA_URL),
    memory.fact('preference', NOVA_FOLDER),
    memory.fact('preference', NOVA_AUTOSTART),
  ]);
  return {
    local,
    nova: {
      ...novaEndpoint,
      folder: typeof folder?.value === 'string' ? folder.value : '',
      // Unset means on; only an explicit 'false' turns it off.
      autoStart: autoStart?.value !== 'false',
    },
  };
}

export async function writeLocalModelsEnabled(storage: Storage, enabled: boolean): Promise<void> {
  await new MemoryStore(storage).remember('preference', LOCAL_ENABLED, enabled ? 'true' : 'false');
}

export async function writeLocalModelsBaseUrl(storage: Storage, baseUrl: string): Promise<void> {
  await new MemoryStore(storage).remember('preference', LOCAL_URL, baseUrl.trim());
}

export async function writeNovaIntelligenceEnabled(
  storage: Storage,
  enabled: boolean,
): Promise<void> {
  await new MemoryStore(storage).remember('preference', NOVA_ENABLED, enabled ? 'true' : 'false');
}

export async function writeNovaIntelligenceBaseUrl(
  storage: Storage,
  baseUrl: string,
): Promise<void> {
  await new MemoryStore(storage).remember('preference', NOVA_URL, baseUrl.trim());
}

export async function writeNovaIntelligenceFolder(storage: Storage, folder: string): Promise<void> {
  await new MemoryStore(storage).remember('preference', NOVA_FOLDER, folder.trim());
}

export async function writeNovaIntelligenceAutoStart(
  storage: Storage,
  autoStart: boolean,
): Promise<void> {
  await new MemoryStore(storage).remember(
    'preference',
    NOVA_AUTOSTART,
    autoStart ? 'true' : 'false',
  );
}

export async function readActiveProvider(storage: Storage): Promise<string | undefined> {
  return (await new MemoryStore(storage).fact('preference', ACTIVE_SUBJECT))?.value;
}

/** `null` clears the pick — Atlas then uses the default local model if local models are on. */
export async function writeActiveProvider(storage: Storage, id: string | null): Promise<void> {
  await new MemoryStore(storage).remember('preference', ACTIVE_SUBJECT, id ?? '');
}
