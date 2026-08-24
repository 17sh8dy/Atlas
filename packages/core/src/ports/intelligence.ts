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

/**
 * The providers Atlas knows about.
 *
 * One. This used to read `'claude' | 'local' | 'gemini'`, which described a
 * marketplace rather than a product: three ways to send your questions
 * somewhere else, and the local option the only one never built. Cortex is
 * the whole list now, and it runs on this machine.
 *
 * The `(string & {})` tail is kept so the type still admits an id without
 * widening to `string` in editors — it is a hook for a *local* provider that
 * does not exist yet, not an invitation to add a second cloud one.
 */
export type ProviderId = 'cortex' | (string & {});

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
  ask(prompt: string, handlers: ProviderStreamHandlers): void;
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
