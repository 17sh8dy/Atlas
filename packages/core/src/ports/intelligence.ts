/**
 * The intelligence port — optional external reasoning.
 *
 * Atlas's engine is deterministic and complete on its own: it understands
 * commands, drives the machine, searches, and remembers without any model
 * connected. A provider adds one thing the engine deliberately doesn't do —
 * open-ended reasoning about the wider world — and it is an accessory, never a
 * prerequisite.
 *
 * That ordering is a product decision as much as an architectural one, and it
 * is expressed here: the engine depends on this port, but nothing in it is
 * required for the engine to run. Every method that could fail returns a
 * result the engine can proceed without.
 */

import type { HaltSignal } from '../models/halt';

/**
 * The providers Atlas knows about.
 *
 * An id is a string: `local:qwen3-8b` for a local model (see
 * `LOCAL_MODEL_PROFILES`), `nova-intelligence` for the from-scratch Nova model,
 * or a generated id for each cloud provider a person added. The set is a
 * runtime fact, not a fixed list — which is why this is not a union.
 */
export type ProviderId = string;

export interface ProviderStreamHandlers {
  /** A chunk of the answer, as it arrives. */
  onDelta(chunk: string): void;
  /** The complete answer. Always called on success, after the last delta. */
  onDone(full: string): void;
  /**
   * `not-configured` — nobody set this up; not an error, just absent.
   * `offline`        — configured but unreachable right now.
   * anything else    — a real failure worth logging.
   */
  onError(reason: 'not-configured' | 'offline' | string): void;
}

export interface IntelligenceProvider {
  id: ProviderId;
  label: string;
  /** False until the user has actually set this one up. */
  isConfigured(): boolean;
  /** True for providers that run on this machine and send nothing outward. */
  isLocal(): boolean;
  /**
   * `signal` aborts on an emergency stop. The native side already drops the
   * request itself; a provider uses the signal to stop delivering to
   * handlers nobody is listening to any more.
   */
  ask(
    prompt: string,
    handlers: ProviderStreamHandlers,
    options?: {
      signal?: HaltSignal;
      /**
       * "Think longer": the person asked for extended thinking and a fuller
       * answer. A provider that has such a mode uses it; one that does not
       * ignores this — the prompt itself already asks for a thorough answer.
       */
      deeper?: boolean;
    },
  ): void;
  /** Opens whatever UI configures this provider. */
  configure?(): void;
}

/**
 * The set of providers Atlas knows about, and which one is currently in play.
 *
 * `active()` returns null when nothing is connected — the normal, supported
 * state, not a degraded one.
 */
export interface IntelligenceRegistry {
  register(provider: IntelligenceProvider): void;
  get(id: ProviderId): IntelligenceProvider | null;
  list(): IntelligenceProvider[];
  active(): IntelligenceProvider | null;
  setActive(id: ProviderId | null): void;
}
