/**
 * `IntelligenceProvider`s: local models, Nova Intelligence, and whichever
 * cloud providers a person has opted into and configured.
 *
 * ── Intelligence, not control ───────────────────────────────────────────────
 * A provider is the conversation and reasoning layer. It takes text and
 * returns text; it cannot act. What Atlas *does* — PowerShell, window
 * control, files — belongs to its skills and executor, which do not consult a
 * provider to decide what is permitted. Choosing a different provider changes
 * how Atlas talks and reasons and nothing about what it may do.
 *
 * ── The model that is asked is the model that was chosen ────────────────────
 * Each local model is its own provider with its own id, and its `ask()` sends
 * that model's Ollama tag — nothing shared, nothing looked up later. So
 * "which model answered" is a property of which provider is active, and
 * `providers.test.ts` checks that each one puts its own tag on the wire.
 *
 * ── "Configured" means enabled, not authenticated ───────────────────────────
 * A local model has no key to check, so `isConfigured()` reports whether the
 * user has turned local models *on* — a real preference they set — and
 * whether the server is up, or the model pulled, is discovered at call time
 * and reported precisely (see `explainLocalFailure`). A cloud provider's
 * `isConfigured()` is the same shape for the same reason.
 *
 * ── Streaming ───────────────────────────────────────────────────────────────
 * Local models and Nova Intelligence stream token by token through the
 * `atlas://intelligence/{streamId}` event channel. Cloud providers do not yet:
 * `createCloudProvider`'s `ask()` calls `onDone` once, and
 * `Engine.converseWithProvider` degrades cleanly for a non-streaming provider.
 *
 * Tauri-only, like the rest of this package. A browser build gets no
 * providers at all rather than ones that throw — "capability absence is
 * data, not an exception", the same rule as every other machine-reaching
 * thing here.
 */

import type {
  HaltSignal,
  CloudProviderConfig,
  CloudProviderTestResult,
  IntelligenceProvider,
  LocalModelProfile,
  ProviderStreamHandlers,
} from '@atlas/core';
import { invoke } from '@tauri-apps/api/core';

/** Where Ollama listens when nothing says otherwise. Mirrors `OLLAMA_DEFAULT_URL`. */
export const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
/** Where Nova Intelligence's server listens. Mirrors `NOVA_DEFAULT_URL`. */
export const NOVA_INTELLIGENCE_DEFAULT_BASE_URL = 'http://127.0.0.1:8766';

export const NOVA_INTELLIGENCE_PROVIDER_ID = 'nova-intelligence';

/**
 * Streams one native call and turns `atlas://intelligence/{streamId}` events
 * into `onDelta` calls. The subscription is opened *before* `invoke`, because
 * `listen` resolves asynchronously and a fast first delta could otherwise beat
 * a subscription started after the command was already sent.
 */
async function streamNative(
  command: string,
  args: Record<string, unknown>,
  handlers: ProviderStreamHandlers,
  explain: (reason: string) => string,
  signal?: HaltSignal,
): Promise<void> {
  const streamId = crypto.randomUUID();
  let unlisten: (() => void) | null = null;
  // The native side drops the request itself on a halt; this just stops
  // listening for deltas nobody will read.
  signal?.addEventListener('abort', () => unlisten?.(), { once: true });
  try {
    const { listen } = await import('@tauri-apps/api/event');
    unlisten = await listen<string>(`atlas://intelligence/${streamId}`, (event) => {
      handlers.onDelta(event.payload);
    });
    const text = await invoke<string>(command, { ...args, streamId });
    handlers.onDone(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // `offline` is the sentinel the engine already knows how to phrase.
    handlers.onError(reason === 'offline' ? 'offline' : explain(reason));
  } finally {
    unlisten?.();
  }
}

// ---------------------------------------------------------------------------
// Local models (Ollama)
// ---------------------------------------------------------------------------

export interface LocalModelOptions {
  /** False until the user turns local models on in Settings. */
  enabled: boolean;
  /** Loopback only — the Rust side refuses anything else. */
  baseUrl?: string;
}

/** What a person should do about a failure, in the words they would use. */
export function explainLocalFailure(label: string, tag: string, reason: string): string {
  if (reason.startsWith('model-missing:')) {
    return `${label} isn't installed yet. In a terminal, run:  ollama pull ${tag}`;
  }
  return reason;
}

/**
 * One local model as one provider. `profile.ollamaTag` and `profile.think` are
 * read here, once, and are what every `ask()` puts on the wire.
 */
export function createLocalModelProvider(
  profile: Pick<LocalModelProfile, 'id' | 'label' | 'ollamaTag' | 'think'>,
  options: LocalModelOptions,
): IntelligenceProvider {
  const baseUrl = options.baseUrl?.trim() || OLLAMA_DEFAULT_BASE_URL;

  return {
    id: profile.id,
    label: profile.label,
    isConfigured: () => options.enabled,
    isLocal: () => true,
    ask(prompt: string, handlers: ProviderStreamHandlers, askOptions?: { signal?: HaltSignal }) {
      if (!options.enabled) {
        handlers.onError('not-configured');
        return;
      }
      void streamNative(
        'ask_local_model_stream',
        { baseUrl, model: profile.ollamaTag, prompt, think: profile.think ?? null },
        handlers,
        (reason) => explainLocalFailure(profile.label, profile.ollamaTag, reason),
        askOptions?.signal,
      );
    },
  };
}

export interface InstalledLocalModel {
  /** Ollama's own name for it, e.g. `qwen3:8b`. */
  name: string;
  sizeBytes: number;
}

/**
 * The models Ollama has on disk, or `null` when it is not running. `null` and
 * `[]` are different answers — "not running" and "running, nothing pulled" —
 * and Settings words them differently. Never throws.
 */
export async function listInstalledLocalModels(
  baseUrl?: string,
): Promise<InstalledLocalModel[] | null> {
  try {
    return await invoke<InstalledLocalModel[]>('local_models_installed', {
      baseUrl: baseUrl?.trim() || OLLAMA_DEFAULT_BASE_URL,
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Nova Intelligence
// ---------------------------------------------------------------------------

export function createNovaIntelligenceProvider(options: LocalModelOptions): IntelligenceProvider {
  const baseUrl = options.baseUrl?.trim() || NOVA_INTELLIGENCE_DEFAULT_BASE_URL;

  return {
    id: NOVA_INTELLIGENCE_PROVIDER_ID,
    label: 'Nova Intelligence',
    isConfigured: () => options.enabled,
    isLocal: () => true,
    ask(prompt: string, handlers: ProviderStreamHandlers, askOptions?: { signal?: HaltSignal }) {
      if (!options.enabled) {
        handlers.onError('not-configured');
        return;
      }
      void streamNative(
        'ask_nova_intelligence_stream',
        { baseUrl, prompt },
        handlers,
        (reason) => reason,
        askOptions?.signal,
      );
    },
  };
}

/** Whether Nova Intelligence is answering right now. Never throws; false is a fine answer. */
export async function isNovaIntelligenceReachable(baseUrl?: string): Promise<boolean> {
  try {
    return await invoke<boolean>('nova_intelligence_reachable', {
      baseUrl: baseUrl?.trim() || NOVA_INTELLIGENCE_DEFAULT_BASE_URL,
    });
  } catch {
    return false;
  }
}

/**
 * Cloud model providers — optional, user-configured, never required. See
 * `CloudProviderConfig`'s own doc comment (`@atlas/core`) and
 * `cloud_intelligence.rs`'s module doc for the full shape of this feature;
 * this file is just the phone line, the same as every other Tauri adapter
 * here — no validation happens on this side, because the webview is the
 * least trusted part of the app.
 *
 * ── The key never crosses back into this process ────────────────────────
 * `saveProviderSecret` writes a key once, at the moment it's typed in, and
 * nothing here ever reads it back — there is no `readProviderSecret`. The
 * Rust side (`secrets.rs`) reads it directly when building a request; the
 * only round trip a key makes is renderer → Rust → the provider's own API,
 * never renderer → Rust → renderer.
 */

export async function saveProviderSecret(providerId: string, secret: string): Promise<void> {
  await invoke<void>('save_secret', { providerId, secret });
}

/** Whether a key is saved — never the value itself. */
export async function hasProviderSecret(providerId: string): Promise<boolean> {
  try {
    return await invoke<boolean>('has_secret', { providerId });
  } catch {
    return false;
  }
}

export async function deleteProviderSecret(providerId: string): Promise<void> {
  await invoke<void>('delete_secret', { providerId });
}

/** The Settings page's "Test connection" button. Never throws — a failed test is data, not an exception. */
export async function testCloudProviderConnection(
  config: Pick<CloudProviderConfig, 'id' | 'kind' | 'baseUrl' | 'model'>,
): Promise<CloudProviderTestResult> {
  try {
    const reply = await invoke<string>('test_cloud_provider', {
      providerId: config.id,
      kind: config.kind,
      baseUrl: config.baseUrl,
      model: config.model,
    });
    return { ok: true, message: reply };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * One `IntelligenceProvider` per configured cloud provider. Not streaming —
 * see `cloud_intelligence.rs`'s module doc for why this pass deliberately
 * stops at "correct and foundational" rather than also adding streaming for
 * three providers at once. `Engine.converseWithProvider` already degrades a
 * non-streaming provider to a single `onDone` call, so this is a complete,
 * working provider today and a config-only change to add deltas later.
 */
export function createCloudProvider(config: CloudProviderConfig): IntelligenceProvider {
  return {
    id: config.id,
    label: config.label,
    isConfigured: () => config.enabled,
    isLocal: () => false,
    ask(prompt: string, handlers: ProviderStreamHandlers) {
      if (!config.enabled) {
        handlers.onError('not-configured');
        return;
      }
      invoke<string>('ask_cloud_provider', {
        providerId: config.id,
        kind: config.kind,
        baseUrl: config.baseUrl,
        model: config.model,
        prompt,
      })
        .then((text) => handlers.onDone(text))
        .catch((err) => handlers.onError(err instanceof Error ? err.message : String(err)));
    },
  };
}
