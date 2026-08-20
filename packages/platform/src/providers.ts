/**
 * Concrete `IntelligenceProvider`s for Claude and ChatGPT — real API calls
 * through `ask_claude`/`ask_openai` (`apps/desktop/src-tauri/src/intelligence.rs`).
 * Tauri-only, same as the rest of this package: a browser build has no way
 * to make these calls without hitting CORS (see `intelligence.rs`'s own
 * doc comment on why that work happens in Rust), so it simply doesn't get
 * them — "capability absence is data, not an exception," the same rule as
 * every other machine-reaching thing here.
 *
 * Non-streaming: `ask()` calls `onDone` directly, never `onDelta`.
 * `Engine`'s `converseWithProvider` already degrades cleanly for a provider
 * that never streams (see its own comment) — a real streaming version can
 * replace the Rust side of this later without the engine changing.
 */

import type { IntelligenceProvider, ProviderStreamHandlers } from '@atlas/core';
import { invoke } from '@tauri-apps/api/core';

function createInvokedProvider(
  id: 'claude' | 'openai',
  label: string,
  command: string,
  apiKey: string | undefined,
): IntelligenceProvider {
  return {
    id,
    label,
    isConfigured: () => Boolean(apiKey?.trim()),
    isLocal: () => false,
    ask(prompt: string, handlers: ProviderStreamHandlers) {
      if (!apiKey?.trim()) {
        handlers.onError('not-configured');
        return;
      }
      invoke<string>(command, { apiKey, prompt })
        .then((text) => handlers.onDone(text))
        .catch((err) => handlers.onError(err instanceof Error ? err.message : String(err)));
    },
  };
}

export function createClaudeProvider(apiKey: string | undefined): IntelligenceProvider {
  return createInvokedProvider('claude', 'Claude', 'ask_claude', apiKey);
}

export function createOpenAIProvider(apiKey: string | undefined): IntelligenceProvider {
  return createInvokedProvider('openai', 'ChatGPT', 'ask_openai', apiKey);
}
