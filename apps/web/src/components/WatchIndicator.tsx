/**
 * The title bar's quiet "Atlas is keeping an eye on something".
 *
 * Absent when nothing is being watched — a permanent eye would be one more
 * icon to learn to ignore. Present, it says how many; when one of them has
 * stopped to ask, a small amber dot appears and the label says so, because a
 * question nobody can see is a question nobody answers. Clicking it opens
 * Settings → Watches, where every watch can be read, answered, paused or
 * cancelled.
 */

import { useEffect, useState } from 'react';
import type { Watch } from '@atlas/core';
import { FINISHED_WATCH_STATUSES } from '@atlas/core';
import type { WatchManager } from '@atlas/engine';
import { Icons, cn } from '@atlas/ui';

interface Props {
  watches: WatchManager;
  onOpen(): void;
}

export function WatchIndicator({ watches, onOpen }: Props) {
  const [live, setLive] = useState<Watch[]>([]);

  useEffect(
    () =>
      watches.subscribe((list) =>
        setLive(list.filter((w) => !FINISHED_WATCH_STATUSES.includes(w.status))),
      ),
    [watches],
  );

  if (!live.length) return null;

  const waiting = live.filter((w) => w.status === 'awaiting-approval').length;
  const paused = live.filter((w) => w.status === 'paused').length;
  const label = waiting
    ? `${waiting} watch${waiting === 1 ? ' needs' : 'es need'} you`
    : paused === live.length
      ? `${paused} paused watch${paused === 1 ? '' : 'es'}`
      : `Watching ${live.length} thing${live.length === 1 ? '' : 's'}`;

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${label} — open Watches`}
      title={label}
      className={cn(
        'duration-fast relative flex h-7 items-center gap-1 rounded-md px-1.5 text-xs transition',
        waiting
          ? 'text-warning hover:bg-surface'
          : 'text-foreground-subtle hover:bg-surface hover:text-foreground',
      )}
    >
      <Icons.Eye className="h-3.5 w-3.5" />
      <span className="tabular-nums">{live.length}</span>
      {waiting > 0 && (
        <span className="bg-warning absolute right-0.5 top-1 h-1.5 w-1.5 animate-pulse rounded-full motion-reduce:animate-none" />
      )}
    </button>
  );
}
