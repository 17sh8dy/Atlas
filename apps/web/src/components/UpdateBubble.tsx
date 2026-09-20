/**
 * The "Update available" bubble.
 *
 * A small glass card in the top-right corner, in the same `atlas-glass` as the
 * rest of the app so it follows the theme and accent without a style of its
 * own. It is not a modal: nothing behind it is blocked, and "Later" puts it
 * away. It holds no update logic — it renders an `Updater` and calls it.
 *
 * Every state the service can be in has a face here: checking, available,
 * downloading (with a real progress bar), verifying, installing, restarting,
 * complete, and failed (which also covers "went back to the previous version").
 * Only `hidden` renders nothing.
 */

import { useEffect, useState } from 'react';
import { Button, Icons, Spinner } from '@atlas/ui';
import type { UpdateManifest } from '@atlas/updater';
import type { Updater } from '../update/useUpdater';
import { formatVersion } from '../pages/settings/About';

const MB = 1024 * 1024;

/** "123 MB of 356 MB". Whole megabytes: a download this size does not need decimals. */
export function describeProgress(received: number, total: number | null): string {
  const done = Math.round(received / MB);
  return total ? `${done} MB of ${Math.round(total / MB)} MB` : `${done} MB`;
}

/** 0–100, or null when the size is unknown. */
export function percent(received: number, total: number | null): number | null {
  if (!total || total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((received / total) * 100)));
}

function Notes({ manifest }: { manifest: UpdateManifest }) {
  const notes = manifest.releaseNotes.slice(0, 4);
  if (notes.length === 0) return null;
  return (
    <ul className="text-foreground-muted mt-2 flex flex-col gap-1 text-xs leading-relaxed">
      {notes.map((n, i) => (
        <li key={i} className="flex gap-2">
          <span
            aria-hidden
            className="text-primary mt-[7px] h-1 w-1 shrink-0 rounded-full bg-current"
          />
          <span>{n}</span>
        </li>
      ))}
    </ul>
  );
}

function Bar({ value }: { value: number | null }) {
  return (
    <div
      className="bg-border mt-3 h-1.5 overflow-hidden rounded-full"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value ?? undefined}
    >
      <div
        className={
          value === null
            ? 'accent-surface h-full w-1/3 animate-pulse rounded-full'
            : 'accent-surface duration-fast h-full rounded-full transition-[width] ease-out motion-reduce:transition-none'
        }
        style={value === null ? undefined : { width: `${value}%` }}
      />
    </div>
  );
}

export function UpdateBubble({ updater }: { updater: Updater }) {
  const { state } = updater;
  const visible = state.status !== 'hidden';

  // A one-frame delay so the card can ease in instead of appearing.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!visible) {
      setShown(false);
      return;
    }
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, [visible]);

  if (!visible) return null;

  let icon = <Icons.Sparkles className="text-primary h-4 w-4" />;
  let title = '';
  let body: React.ReactNode = null;
  let actions: React.ReactNode = null;

  switch (state.status) {
    case 'checking':
      icon = <Spinner className="h-4 w-4" />;
      title = 'Checking for updates…';
      break;

    case 'available': {
      const m = state.manifest;
      title = 'Update available';
      body = (
        <>
          <p className="text-foreground-muted mt-0.5 text-xs">
            Atlas {formatVersion(m.version)} is ready
            {updater.currentVersion ? ` — you have ${formatVersion(updater.currentVersion)}` : ''}.
          </p>
          <Notes manifest={m} />
        </>
      );
      actions = (
        <>
          <Button size="sm" onClick={updater.update}>
            Update
          </Button>
          {!m.mandatory && (
            <Button size="sm" variant="ghost" onClick={updater.later}>
              Later
            </Button>
          )}
        </>
      );
      break;
    }

    case 'downloading': {
      const pct = percent(state.received, state.total);
      icon = <Icons.Download className="text-primary h-4 w-4" />;
      title = `Downloading ${formatVersion(state.manifest.version)}`;
      body = (
        <>
          <Bar value={pct} />
          <p className="text-foreground-subtle mt-1.5 text-xs tabular-nums">
            {describeProgress(state.received, state.total)}
            {pct !== null ? ` · ${pct}%` : ''}
          </p>
        </>
      );
      actions = (
        <Button size="sm" variant="ghost" onClick={updater.cancel}>
          Cancel
        </Button>
      );
      break;
    }

    case 'verifying':
      icon = <Spinner className="h-4 w-4" />;
      title = 'Verifying the download…';
      body = <Bar value={null} />;
      break;

    case 'installing':
      icon = <Spinner className="h-4 w-4" />;
      title = 'Getting ready to install…';
      body = (
        <>
          <Bar value={null} />
          <p className="text-foreground-subtle mt-1.5 text-xs">
            Keeping a copy of this version, just in case.
          </p>
        </>
      );
      break;

    case 'restarting':
      icon = <Spinner className="h-4 w-4" />;
      title = 'Restarting Atlas…';
      body = (
        <p className="text-foreground-subtle mt-0.5 text-xs">
          Atlas will close and reopen on {formatVersion(state.manifest.version)} in a moment.
        </p>
      );
      break;

    case 'complete':
      icon = <Icons.Check className="text-primary h-4 w-4" />;
      title = `Updated to ${formatVersion(state.version)}`;
      body = <p className="text-foreground-muted mt-0.5 text-xs">You’re on the latest version.</p>;
      actions = (
        <Button size="sm" variant="ghost" onClick={updater.acknowledge}>
          Done
        </Button>
      );
      break;

    case 'failed':
      icon = <Icons.TriangleAlert className="text-primary h-4 w-4" />;
      title = state.rolledBack ? 'Update rolled back' : 'Update didn’t finish';
      body = <p className="text-foreground-muted mt-0.5 text-xs leading-relaxed">{state.error}</p>;
      actions = (
        <>
          {state.manifest && !state.rolledBack && (
            <Button size="sm" onClick={updater.retry}>
              Try again
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={updater.acknowledge}>
            Dismiss
          </Button>
        </>
      );
      break;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className={[
        'atlas-glass pointer-events-auto fixed right-4 top-14 z-40 w-[300px] max-w-[calc(100vw-2rem)] rounded-xl p-3.5',
        'duration-base transition ease-out motion-reduce:transition-none',
        shown ? 'translate-y-0 opacity-100' : '-translate-y-1 opacity-0',
      ].join(' ')}
    >
      <div className="flex items-center gap-2">
        {icon}
        <h2 className="text-foreground text-sm font-medium">{title}</h2>
      </div>
      {body}
      {actions && <div className="mt-3 flex items-center gap-2">{actions}</div>}
    </div>
  );
}
