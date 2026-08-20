/**
 * Working memory — what "it" and "the second one" refer to right now.
 *
 * Deliberately in-process and never persisted: `Focus`'s own doc comment in
 * `@atlas/core` says a pronoun resolving against something from an hour ago
 * is worse than one that admits it doesn't know. Living only in memory (and
 * expiring on its own via `TTL_MS`) is what makes that true across a restart
 * too — Phase 3's cross-restart persistence deliberately does not cover this.
 *
 * Being in-process rather than storage-backed also means it's synchronous,
 * which is what lets a grammar rule read it directly (grammar rules can't do
 * I/O — see the comment on `filesOpenAlias` in `core-grammar.ts` for the
 * async case this sidesteps).
 */

import type { Focus, ResultRow } from '@atlas/core';

const TTL_MS = 10 * 60 * 1000;

const ORDINAL_INDEX: Record<string, number> = { first: 1, second: 2, third: 3 };

export class WorkingMemory {
  private results: ResultRow[] = [];
  private resultsAt = 0;
  private focus: Focus | null = null;

  /** Called whenever a skill renders a result list. */
  setResults(rows: readonly ResultRow[]): void {
    this.results = [...rows];
    this.resultsAt = Date.now();
    // An unambiguous single result becomes "it" for a follow-up, the same
    // way opening one of several does (see `resolveOrdinal`).
    if (rows.length === 1 && rows[0]) this.setFocus('result', rows[0].title, rows[0]);
  }

  setFocus(type: string, title: string, payload?: unknown): void {
    this.focus = { type, title, payload, at: Date.now() };
  }

  /** "the second one" / "the last one" against the most recently shown list. */
  resolveOrdinal(word: string): ResultRow | null {
    const rows = this.freshResults();
    if (!rows.length) return null;
    const index = word === 'last' ? rows.length : ORDINAL_INDEX[word];
    if (!index) return null;
    const row = rows[index - 1];
    if (!row) return null;
    this.setFocus('result', row.title, row);
    return row;
  }

  /** Bare "it" / "that" / "this" / "one" — only when unambiguous. */
  resolveFocusRow(): ResultRow | null {
    const focus = this.freshFocus();
    return (focus?.payload as ResultRow | undefined) ?? null;
  }

  private freshResults(): ResultRow[] {
    if (this.results.length && Date.now() - this.resultsAt > TTL_MS) this.results = [];
    return this.results;
  }

  private freshFocus(): Focus | null {
    if (this.focus && Date.now() - this.focus.at > TTL_MS) this.focus = null;
    return this.focus;
  }
}
