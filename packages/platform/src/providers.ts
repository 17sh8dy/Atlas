/**
 * The single `IntelligenceProvider`: **Cortex**, on this machine.
 *
 * This file used to export `createClaudeProvider` and `createOpenAIProvider`.
 * It exports one provider now, and that provider talks to loopback. Atlas is
 * an assistant with access to your files, your processes and your habits; the
 * decision that it should not *also* hold an API key for somebody else's
 * datacentre is the same one that removed Supabase from this project.
 *
 * ── "Configured" means enabled, not authenticated ───────────────────────────
 * A local provider has no key to check, so `isConfigured()` reports whether
 * the user has turned Cortex *on* — a real preference they set — and
 * reachability is discovered at call time instead. That maps cleanly onto the
 * two sentinel reasons the port already defined: `not-configured` for "nobody
 * asked for this", `offline` for "asked for, not running". Reporting
 * `isConfigured() === false` just because Cortex happened to be stopped would
 * be a lie of a different shape: it would make a stopped service look like a
 * feature that was never set up.
 *
 * ── Not streaming, and that costs nothing here ──────────────────────────────
 * `ask()` calls `onDone` and never `onDelta`. `Engine.converseWithProvider`
 * already degrades cleanly for a provider that never streams (see its own
 * comment), so a streaming Cortex can replace the Rust side later without the
 * engine changing.
 *
 * Tauri-only, like the rest of this package. A browser build gets a provider
 * that honestly reports itself unconfigured rather than one that throws —
 * "capability absence is data, not an exception", the same rule as every
 * other machine-reaching thing here.
 */

import type { IntelligenceProvider, ProviderStreamHandlers } from '@atlas/core';
import { invoke } from '@tauri-apps/api/core';

/** Where Cortex listens when nothing says otherwise. Mirrors `DEFAULT_BASE_URL`. */
export const CORTEX_DEFAULT_BASE_URL = 'http://127.0.0.1:8765';

export interface CortexOptions {
  /** False until the user turns Cortex on in Settings. */
  enabled: boolean;
  /** Loopback only — the Rust side refuses anything else. */
  baseUrl?: string;
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
      invoke<string>('ask_cortex', { baseUrl, prompt })
        .then((text) => handlers.onDone(text))
        .catch((err) => {
          const reason = err instanceof Error ? err.message : String(err);
          // `ask_cortex` returns this exact sentinel for a refused
          // connection — see its doc comment. Passed through rather than
          // rewritten, because the engine already knows what to say for it.
          handlers.onError(reason === 'offline' ? 'offline' : reason);
        });
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
