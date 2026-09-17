/**
 * Home's Recent Activity — the real record of what Atlas has actually done,
 * not a re-hash of what you typed.
 *
 * ── Why this exists now and didn't before ────────────────────────────────
 * The old `Conversation.tsx` deliberately shipped without a "recent" row: at
 * the time, episodic memory lived only in the process and died with it, so a
 * recent row shown on a fresh launch would always be empty, and one that
 * cannot be re-run just to look at is dead weight. `@atlas/data`'s
 * `MemoryStore` now persists episodes to disk (see `EPISODIC_LIMIT` there),
 * which is the one fact that changes the calculus — there is finally
 * something real to show.
 *
 * ── Real data only, and that is the whole rule ───────────────────────────
 * Every row here is a `EpisodicEvent` `recordEpisodes` (`@atlas/engine`)
 * wrote after a skill actually ran. Nothing is invented to make the panel
 * look alive — an empty state that tells the truth is worth more than a
 * feed of sample rows a first-time user would mistake for history that
 * doesn't belong to them.
 *
 * ── Not clickable ─────────────────────────────────────────────────────────
 * Episodic memory stores what *happened* ("Opened Steam"), not the sentence
 * that caused it, so there is nothing here to re-run — and a row that does
 * nothing when clicked is precisely the unfinished feeling this rewrite is
 * removing elsewhere. Rows are read, not pressed.
 */

import { Icons } from '@atlas/ui';
import type { EpisodicEvent } from '@atlas/core';
import { timeAgo } from '../lib/timeAgo';

/** Enough to read as "recent" without turning Home into a log viewer. */
const VISIBLE = 6;

export function RecentActivity({
  episodes,
  onDoSomething,
}: {
  /** Oldest-first, the same order `Memory.episodes()` returns — reversed here for display. */
  episodes: EpisodicEvent[];
  /** The empty state's call to action: focus the composer, same as an empty-starter card. */
  onDoSomething(): void;
}) {
  const recent = episodes.slice(-VISIBLE).reverse();

  return (
    <section className="w-full max-w-lg">
      <p className="text-foreground-subtle mb-2.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide">
        <Icons.Activity className="h-3.5 w-3.5" />
        Recent activity
      </p>

      {recent.length === 0 ? (
        <div className="border-border bg-surface/40 flex flex-col items-center gap-2.5 rounded-xl border px-4 py-6 text-center">
          <p className="text-foreground-subtle text-xs leading-relaxed">
            Nothing yet — what Atlas does will show up here.
          </p>
          <button
            type="button"
            onClick={onDoSomething}
            className="text-primary hover:text-foreground duration-fast text-xs font-medium transition"
          >
            Do something now
          </button>
        </div>
      ) : (
        <ul className="border-border bg-surface/40 divide-border divide-y overflow-hidden rounded-xl border">
          {recent.map((event) => (
            <li key={event.at} className="flex items-center gap-3 px-4 py-3">
              <span className="bg-foreground-subtle/50 h-2 w-2 shrink-0 rounded-full" />
              <span className="text-foreground min-w-0 flex-1 truncate text-base">
                {event.label}
                {event.count && event.count > 1 && (
                  <span className="text-foreground-subtle"> · ×{event.count}</span>
                )}
              </span>
              <span className="text-foreground-subtle shrink-0 text-xs">{timeAgo(event.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
