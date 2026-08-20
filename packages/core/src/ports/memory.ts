/**
 * The memory port — semantic facts (preferences, aliases) and a capped
 * episodic timeline, behind one small interface so the engine can depend on
 * the shape of memory without depending on how it's persisted. Mirrors the
 * `Platform`/`Storage` seam: skills take a `Memory`, never a concrete store.
 */

import type { EpisodicEvent, Fact } from '../models/memory';

export interface Memory {
  facts(kind?: Fact['kind']): Promise<Fact[]>;
  fact(kind: Fact['kind'], subject: string): Promise<Fact | undefined>;
  remember(kind: Fact['kind'], subject: string, value: string): Promise<void>;
  forget(kind: Fact['kind'], subject: string): Promise<void>;
  episodes(): Promise<EpisodicEvent[]>;
  record(type: string, label: string, data?: Record<string, unknown>): Promise<void>;
}
