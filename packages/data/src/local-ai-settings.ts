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
/** Which provider is active, or none. */
const ACTIVE_SUBJECT = 'provider.active';

export interface EndpointSettings {
  enabled: boolean;
  /** Empty means "wherever it normally listens" — resolved on the native side. */
  baseUrl: string;
}

export interface LocalAiSettings {
  /** Local models, served by Ollama on this machine. */
  local: EndpointSettings;
  /** The from-scratch Nova Intelligence model, served by its own local process. */
  nova: EndpointSettings;
}

export const DEFAULT_LOCAL_AI_SETTINGS: LocalAiSettings = {
  local: { enabled: false, baseUrl: '' },
  nova: { enabled: false, baseUrl: '' },
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
  const [local, nova] = await Promise.all([
    readEndpoint(memory, LOCAL_ENABLED, LOCAL_URL),
    readEndpoint(memory, NOVA_ENABLED, NOVA_URL),
  ]);
  return { local, nova };
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

export async function readActiveProvider(storage: Storage): Promise<string | undefined> {
  return (await new MemoryStore(storage).fact('preference', ACTIVE_SUBJECT))?.value;
}

/** `null` clears the pick — Atlas then uses the default local model if local models are on. */
export async function writeActiveProvider(storage: Storage, id: string | null): Promise<void> {
  await new MemoryStore(storage).remember('preference', ACTIVE_SUBJECT, id ?? '');
}
