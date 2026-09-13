/**
 * Activity — the episodic timeline Home's Recent Activity reads from, in
 * full, with the two things a real history needs: a way to look back further
 * than the six rows Home shows, and a way to delete what's there.
 *
 * Backed directly by `Memory.episodes()`/`forgetEpisode`/`clearEpisodes`
 * (`@atlas/core`, implemented by `@atlas/data`'s `MemoryStore`) — the same
 * store Home reads, so nothing here is a second copy of the timeline that
 * could disagree with what Home shows.
 *
 * Clearing is a real, irreversible action on data with no undo, so it sits
 * behind a confirm dialog rather than firing on the first click — the same
 * bar `AllowedFolders`' remove button and the title bar's "Clear
 * conversation" hold, just with a dialog because this one can't be undone by
 * simply doing the thing again.
 */

import { useCallback, useEffect, useState } from 'react';
import type { EpisodicEvent, Memory } from '@atlas/core';
import { Button, Icons, Modal } from '@atlas/ui';
import { timeAgo } from '../../lib/timeAgo';

interface Props {
  memory: Memory;
}

export function Activity({ memory }: Props) {
  const [episodes, setEpisodes] = useState<EpisodicEvent[] | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    void memory.episodes().then((events) => setEpisodes([...events].reverse()));
  }, [memory]);

  useEffect(() => reload(), [reload]);

  const remove = useCallback(
    async (at: number) => {
      setBusy(true);
      try {
        await memory.forgetEpisode(at);
        reload();
      } finally {
        setBusy(false);
      }
    },
    [memory, reload],
  );

  const clearAll = useCallback(async () => {
    setBusy(true);
    try {
      await memory.clearEpisodes();
      reload();
    } finally {
      setBusy(false);
      setConfirmClear(false);
    }
  }, [memory, reload]);

  return (
    <div>
      <section className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-foreground mb-1 text-sm font-medium">Recent activity</h2>
          <p className="text-foreground-muted text-xs leading-relaxed">
            What Atlas has actually done — the same list Home's Recent Activity shows a few of. Kept
            on this machine only, the same as everything else Atlas remembers.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          disabled={!episodes?.length || busy}
          onClick={() => setConfirmClear(true)}
          className="shrink-0"
        >
          <Icons.Trash2 className="h-3.5 w-3.5" />
          Clear all
        </Button>
      </section>

      {episodes === null ? (
        <p className="text-foreground-subtle text-xs">Loading…</p>
      ) : episodes.length === 0 ? (
        <p className="border-border bg-surface/40 text-foreground-subtle rounded-xl border px-4 py-6 text-center text-xs leading-relaxed">
          No activity yet. Once Atlas does something, it'll show up here.
        </p>
      ) : (
        <ul className="border-border divide-border divide-y overflow-hidden rounded-xl border text-sm">
          {episodes.map((event) => (
            <li key={event.at} className="flex items-center gap-3 px-4 py-2.5">
              <span className="bg-foreground-subtle/50 h-1.5 w-1.5 shrink-0 rounded-full" />
              <span className="text-foreground min-w-0 flex-1 truncate">
                {event.label}
                {event.count && event.count > 1 && (
                  <span className="text-foreground-subtle"> · ×{event.count}</span>
                )}
              </span>
              <span className="text-foreground-subtle shrink-0 text-xs">{timeAgo(event.at)}</span>
              <button
                type="button"
                onClick={() => remove(event.at)}
                disabled={busy}
                className="text-foreground-subtle hover:text-foreground shrink-0 disabled:opacity-30"
                aria-label={`Remove "${event.label}" from activity`}
                title="Remove"
              >
                <Icons.Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={confirmClear}
        onOpenChange={setConfirmClear}
        label="Clear all activity?"
        className="max-w-sm"
      >
        <div className="border-border bg-surface rounded-2xl border p-5 shadow-lg">
          <h2 className="text-foreground text-sm font-medium">Clear all activity?</h2>
          <p className="text-foreground-subtle mt-1.5 text-xs leading-relaxed">
            This removes everything in Atlas's activity history, including what Home shows under
            Recent Activity. It can't be undone.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmClear(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={clearAll} disabled={busy}>
              Clear all
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
