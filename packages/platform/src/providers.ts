/**
 * `IntelligenceProvider`s: **Cortex** always, plus whichever cloud providers
 * a person has opted into and configured.
 *
 * This file used to export `createClaudeProvider` and `createOpenAIProvider`
 * for exactly two hard-coded cloud providers, both since deleted. It is not
 * back to that: `createCloudProvider` takes a `CloudProviderConfig` and
 * builds one provider from it, so the *number* of cloud providers is a
 * runtime fact (however many the user has added) rather than a fixed export
 * list. Cortex is still the only one wired in unconditionally — see
 * `useAtlas.ts`'s registration order — and Atlas still works completely with
 * every cloud provider absent or disabled.
 *
 * ── "Configured" means enabled, not authenticated ───────────────────────────
 * Cortex has no key to check, so `isConfigured()` reports whether the user
 * has turned it *on* — a real preference they set — and reachability is
 * discovered at call time instead. A cloud provider's `isConfigured()` is the
 * same shape for the same reason: whether the person switched it on, not
 * whether the key happens to be valid right now — that maps onto the
 * `offline`/error sentinels `ask()` already reports per call.
 *
 * ── Streaming, and where it stops ───────────────────────────────────────────
 * Cortex streams (`streamCortex`, below) — real token-by-token delivery
 * through `ask_cortex_stream` and the `atlas://intelligence/{streamId}` event
 * channel. Cloud providers do not yet: `createCloudProvider`'s `ask()` calls
 * `onDone` once. `Engine.converseWithProvider` already degrades cleanly for a
 * non-streaming provider, so this is a complete, correct provider today, not
 * a placeholder — see `cloud_intelligence.rs`'s module doc for why this pass
 * stopped there.
 *
 * Tauri-only, like the rest of this package. A browser build gets no
 * providers at all rather than ones that throw — "capability absence is
 * data, not an exception", the same rule as every other machine-reaching
 * thing here.
 */

import type {
  CloudProviderConfig,
  CloudProviderTestResult,
  IntelligenceProvider,
  ProviderStreamHandlers,
} from '@atlas/core';
import { invoke } from '@tauri-apps/api/core';

/** Where Cortex listens when nothing says otherwise. Mirrors `DEFAULT_BASE_URL`. */
export const CORTEX_DEFAULT_BASE_URL = 'http://127.0.0.1:8765';

export interface CortexOptions {
  /** False until the user turns Cortex on in Settings. */
  enabled: boolean;
  /** Loopback only — the Rust side refuses anything else. */
  baseUrl?: string;
}

/**
 * Streams one call to `ask_cortex_stream` and turns
 * `atlas://intelligence/{streamId}` events into `onDelta` calls. The
 * subscription is opened *before* `invoke`, the same ordering
 * `transcribeSpeech`'s caller and the old Claude/OpenAI streaming code both
 * needed — `listen` resolves asynchronously, so a fast first delta can beat
 * a subscription started after the command was already sent.
 */
async function streamCortex(
  baseUrl: string,
  prompt: string,
  handlers: ProviderStreamHandlers,
): Promise<void> {
  const streamId = crypto.randomUUID();
  let unlisten: (() => void) | null = null;
  try {
    const { listen } = await import('@tauri-apps/api/event');
    unlisten = await listen<string>(`atlas://intelligence/${streamId}`, (event) => {
      handlers.onDelta(event.payload);
    });
    const text = await invoke<string>('ask_cortex_stream', { baseUrl, prompt, streamId });
    handlers.onDone(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // `offline` is the exact sentinel `ask_cortex`/`ask_cortex_stream` both
    // return for a refused connection — passed through rather than
    // rewritten, because the engine already knows what to say for it.
    handlers.onError(reason === 'offline' ? 'offline' : reason);
  } finally {
    unlisten?.();
  }
}

export function createCortexProvider(options: CortexOptions): IntelligenceProvider {
  const baseUrl = options.baseUrl?.trim() || CORTEX_DEFAULT_BASE_URL;

  return {
    id: 'cortex',
    label: 'Cortex',
    isConfigured: () => options.enabled,
    isLocal: () => true,
    ask(prompt: string, handlers: ProviderStreamHandlers) {
      if (!options.enabled) {
        handlers.onError('not-configured');
        return;
      }
      void streamCortex(baseUrl, prompt, handlers);
    },
  };
}

/** Whether Cortex is answering right now. Never throws; false is a fine answer. */
export async function isCortexReachable(baseUrl?: string): Promise<boolean> {
  try {
    return await invoke<boolean>('cortex_reachable', {
      baseUrl: baseUrl?.trim() || CORTEX_DEFAULT_BASE_URL,
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
