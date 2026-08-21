/**
 * Concrete `IntelligenceProvider`s for Claude and ChatGPT — real API calls
 * through `ask_claude`/`ask_openai` (`apps/desktop/src-tauri/src/intelligence.rs`).
 * Tauri-only, same as the rest of this package: a browser build has no way
 * to make these calls without hitting CORS (see `intelligence.rs`'s own
 * doc comment on why that work happens in Rust), so it simply doesn't get
 * them — "capability absence is data, not an exception," the same rule as
 * every other machine-reaching thing here.
 *
 * **Streaming.** A Tauri command resolves once, so it cannot itself be a
 * stream. The Rust side therefore splits one answer across two channels:
 * incremental text arrives as events, and the finished text is the command's
 * return value. This adapter joins them back into the single
 * `ProviderStreamHandlers` shape the engine already understood — `onDelta`
 * per chunk, then exactly one `onDone` or `onError`.
 *
 * The property worth preserving: **the promise stays the source of truth.** If
 * the subscription fails, arrives late, or misses a chunk, `onDone` still
 * delivers the complete answer. Streaming degrades to the old behaviour rather
 * than to a truncated reply.
 */

import type { IntelligenceProvider, ProviderStreamHandlers } from '@atlas/core';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/** One chunk of a streamed answer, as `intelligence.rs` emits it. */
interface StreamChunk {
  text: string;
}

/**
 * A fresh channel name per call.
 *
 * Two answers in flight must not share one, or the second one's tokens land in
 * the first one's bubble. `crypto.randomUUID` exists in WebView2 on a secure
 * context; the counter fallback is sufficient because the only requirement is
 * uniqueness within this window's lifetime.
 */
let streamCounter = 0;
function nextStreamId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  streamCounter += 1;
  return `${Date.now()}-${streamCounter}`;
}

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

      const streamId = nextStreamId();
      let unlisten: UnlistenFn | null = null;
      let finished = false;

      /** Tear the subscription down exactly once, however the call ended. */
      const stop = () => {
        finished = true;
        unlisten?.();
        unlisten = null;
      };

      void listen<StreamChunk>(`atlas://intelligence/${streamId}`, (event) => {
        // Anything arriving after the promise settled is ignored: the full
        // text has already been delivered, and appending would duplicate it.
        if (finished) return;
        const text = event.payload?.text;
        if (text) handlers.onDelta(text);
      })
        .then((fn) => {
          // `listen` resolves asynchronously, so a fast answer can finish
          // before the handle exists. Unsubscribing right here is what stops
          // a short reply leaking one listener per question.
          if (finished) fn();
          else unlisten = fn;
        })
        .catch(() => {
          // No subscription means no streaming — not a failed answer. The
          // promise below still resolves with the whole text.
        });

      invoke<string>(command, { apiKey, prompt, streamId })
        .then((text) => {
          stop();
          handlers.onDone(text);
        })
        .catch((err) => {
          stop();
          handlers.onError(err instanceof Error ? err.message : String(err));
        });
    },
  };
}

export function createClaudeProvider(apiKey: string | undefined): IntelligenceProvider {
  return createInvokedProvider('claude', 'Claude', 'ask_claude', apiKey);
}

export function createOpenAIProvider(apiKey: string | undefined): IntelligenceProvider {
  return createInvokedProvider('openai', 'ChatGPT', 'ask_openai', apiKey);
}
