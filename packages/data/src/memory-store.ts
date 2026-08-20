/**
 * Real semantic + episodic memory, replacing Phase 1's preferences-only
 * module.
 *
 * Semantic — facts, preferences, and aliases are the same `Fact` shape with
 * different `kind`s, so they share one array under one key rather than one
 * store per kind. Aliases (Phase 2.2) and preferences (Phase 1) are both
 * callers of `remember`/`facts`, not separate modules.
 *
 * Episodic — a capped, repeat-collapsing timeline (see `EpisodicEvent`'s doc
 * comment in `@atlas/core`): consecutive identical events merge into a count
 * instead of filling the log with duplicates, and only the most recent
 * `EPISODIC_LIMIT` entries are kept.
 *
 * Working memory (`Focus`) is deliberately not here — it lives in-memory for
 * the session (see the engine), not on disk. Persisting conversation state
 * across restarts is Phase 3's job, not this one's.
 */

import type { EpisodicEvent, Fact, Memory, Storage } from '@atlas/core';

// Predates facts/aliases generalizing beyond preferences — kept as-is so
// preference data already on disk isn't orphaned by a rename.
const FACTS_KEY = 'atlas.preferences';
const EPISODES_KEY = 'atlas.memory.episodes';
const EPISODIC_LIMIT = 200;

export class MemoryStore implements Memory {
  constructor(private readonly storage: Storage) {}

  async facts(kind?: Fact['kind']): Promise<Fact[]> {
    const all = (await this.storage.get<Fact[]>(FACTS_KEY)) ?? [];
    return kind ? all.filter((f) => f.kind === kind) : all;
  }

  async fact(kind: Fact['kind'], subject: string): Promise<Fact | undefined> {
    return (await this.facts(kind)).find((f) => f.subject === subject);
  }

  async remember(kind: Fact['kind'], subject: string, value: string): Promise<void> {
    const trimmed = value.trim();
    const next = (await this.facts()).filter((f) => !(f.kind === kind && f.subject === subject));
    if (trimmed) next.push({ kind, subject, value: trimmed, at: Date.now() });
    await this.storage.set(FACTS_KEY, next);
  }

  async forget(kind: Fact['kind'], subject: string): Promise<void> {
    const next = (await this.facts()).filter((f) => !(f.kind === kind && f.subject === subject));
    await this.storage.set(FACTS_KEY, next);
  }

  async episodes(): Promise<EpisodicEvent[]> {
    return (await this.storage.get<EpisodicEvent[]>(EPISODES_KEY)) ?? [];
  }

  async record(type: string, label: string, data?: Record<string, unknown>): Promise<void> {
    const events = await this.episodes();
    const last = events[events.length - 1];
    if (last && last.type === type && last.label === label) {
      events[events.length - 1] = { ...last, count: (last.count ?? 1) + 1, at: Date.now() };
    } else {
      events.push({ type, label, at: Date.now(), data });
    }
    await this.storage.set(EPISODES_KEY, events.slice(-EPISODIC_LIMIT));
  }
}
