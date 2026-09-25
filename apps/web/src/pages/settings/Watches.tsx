/**
 * Watches — everything Atlas is keeping an eye on, and everything it has.
 *
 * The person asked for four things here and each has a control: *inspect*
 * (the condition, every step with its state, and the log), *pause/resume*,
 * *cancel*, and *delete*. A watch that stopped to ask — a step the original
 * approval didn't cover, or a restart that left it unsure whether a step
 * happened — shows the question with its answers right on the row, because
 * a question you have to go looking for is one that doesn't get answered.
 *
 * Backed directly by the live `WatchManager`: this page subscribes to it, so
 * a watch that fires while the page is open changes in front of you.
 */

import { useEffect, useState } from 'react';
import type { Watch, WatchStepState } from '@atlas/core';
import { FINISHED_WATCH_STATUSES } from '@atlas/core';
import type { WatchManager } from '@atlas/engine';
import { Button, Icons, cn } from '@atlas/ui';
import { timeAgo } from '../../lib/timeAgo';

interface Props {
  watches: WatchManager;
}

const STATUS: Record<Watch['status'], { label: string; tone: string }> = {
  active: { label: 'Watching', tone: 'text-accent' },
  paused: { label: 'Paused', tone: 'text-foreground-muted' },
  running: { label: 'Running its steps', tone: 'text-accent' },
  'awaiting-approval': { label: 'Waiting for you', tone: 'text-warning' },
  done: { label: 'Done', tone: 'text-foreground-subtle' },
  failed: { label: 'Stopped', tone: 'text-danger' },
  expired: { label: 'Expired', tone: 'text-foreground-subtle' },
  cancelled: { label: 'Cancelled', tone: 'text-foreground-subtle' },
};

const STEP_MARK: Record<WatchStepState, string> = {
  pending: '○',
  started: '◐',
  done: '●',
  failed: '✕',
  skipped: '–',
};

export function Watches({ watches }: Props) {
  const [list, setList] = useState<readonly Watch[]>(() => watches.list());
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => watches.subscribe((next) => setList([...next])), [watches]);

  const live = list.filter((w) => !FINISHED_WATCH_STATUSES.includes(w.status));
  const finished = list.filter((w) => FINISHED_WATCH_STATUSES.includes(w.status));

  return (
    <div>
      <section className="mb-6">
        <h2 className="text-foreground mb-1 text-sm font-medium">Watches</h2>
        <p className="text-foreground-muted text-xs leading-relaxed">
          Things Atlas is keeping an eye on — “let me know when this download finishes”, “when the
          build finishes, run the tests”. Follow-up steps run only as you approved them. Watches are
          kept on this PC and carry on after Atlas restarts; if Atlas can’t tell whether a step
          already happened, it stops and asks here instead of repeating it. The emergency stop
          pauses every watch.
        </p>
      </section>

      {list.length === 0 ? (
        <p className="border-border bg-surface/40 text-foreground-subtle rounded-xl border px-4 py-6 text-center text-xs leading-relaxed">
          Nothing is being watched. Try “let me know when this download finishes”.
        </p>
      ) : (
        <>
          {live.length > 0 && (
            <WatchList title="Live" items={live} watches={watches} open={open} onToggle={setOpen} />
          )}
          {finished.length > 0 && (
            <WatchList
              title="Finished"
              items={finished}
              watches={watches}
              open={open}
              onToggle={setOpen}
            />
          )}
        </>
      )}
    </div>
  );
}

function WatchList({
  title,
  items,
  watches,
  open,
  onToggle,
}: {
  title: string;
  items: Watch[];
  watches: WatchManager;
  open: string | null;
  onToggle(id: string | null): void;
}) {
  return (
    <section className="mb-6">
      <h3 className="text-foreground-subtle mb-2 text-[11px] font-medium uppercase tracking-wide">
        {title}
      </h3>
      <ul className="border-border divide-border divide-y overflow-hidden rounded-xl border text-sm">
        {items.map((w) => (
          <WatchRow
            key={w.id}
            w={w}
            watches={watches}
            expanded={open === w.id}
            onToggle={() => onToggle(open === w.id ? null : w.id)}
          />
        ))}
      </ul>
    </section>
  );
}

function WatchRow({
  w,
  watches,
  expanded,
  onToggle,
}: {
  w: Watch;
  watches: WatchManager;
  expanded: boolean;
  onToggle(): void;
}) {
  const status = STATUS[w.status];
  const finished = FINISHED_WATCH_STATUSES.includes(w.status);
  const done = w.stepStates.filter((s) => s === 'done' || s === 'skipped').length;

  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-3">
        <Icons.Eye className={cn('mt-0.5 h-4 w-4 shrink-0', status.tone)} />
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={onToggle}
            className="text-foreground block w-full text-left"
          >
            <span className="block truncate">{capitalize(w.describe)}</span>
            <span className="text-foreground-subtle block truncate text-xs">
              <span className={status.tone}>{status.label}</span>
              {w.steps.length > 0 && ` · steps ${done}/${w.steps.length}`}
              {' · '}
              {finished && w.finishedAt
                ? `ended ${timeAgo(w.finishedAt)}`
                : `started ${timeAgo(w.createdAt)}`}
              {!finished &&
                ` · expires ${new Date(w.expiresAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`}
            </span>
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {(w.status === 'active' || w.status === 'running') && (
            <IconButton label="Pause" onClick={() => void watches.pause(w.id)}>
              <Icons.Pause className="h-3.5 w-3.5" />
            </IconButton>
          )}
          {w.status === 'paused' && (
            <IconButton label="Resume" onClick={() => void watches.resume(w.id)}>
              <Icons.Play className="h-3.5 w-3.5" />
            </IconButton>
          )}
          {!finished && (
            <IconButton label="Cancel" onClick={() => void watches.cancel(w.id)}>
              <Icons.X className="h-3.5 w-3.5" />
            </IconButton>
          )}
          <IconButton label="Delete" onClick={() => void watches.remove(w.id)}>
            <Icons.Trash2 className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </div>

      {w.status === 'awaiting-approval' && w.question && (
        <div className="border-border bg-surface ml-7 mt-3 rounded-lg border p-3">
          <p className="text-foreground flex gap-2 text-xs leading-relaxed">
            <Icons.Hand className="text-warning mt-0.5 h-3.5 w-3.5 shrink-0" />
            {w.question.question}
          </p>
          {w.question.detail && (
            <pre className="text-foreground-muted mt-2 max-h-32 overflow-auto whitespace-pre-wrap text-[11px]">
              {w.question.detail}
            </pre>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="primary"
              onClick={() => void watches.answer(w.id, 'approve')}
            >
              {w.question.kind === 'uncertain-step'
                ? 'Run it again'
                : w.question.kind === 'met-while-offline'
                  ? 'Carry on'
                  : 'Approve'}
            </Button>
            {w.question.step !== undefined && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void watches.answer(w.id, 'skip')}
              >
                {w.question.kind === 'uncertain-step' ? 'It already happened' : 'Skip this step'}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => void watches.answer(w.id, 'deny')}>
              Cancel the watch
            </Button>
          </div>
        </div>
      )}

      {expanded && (
        <div className="ml-7 mt-3 space-y-3 text-xs">
          <p className="text-foreground-muted">
            You said: <span className="text-foreground">“{w.request}”</span>
          </p>
          {w.steps.length > 0 && (
            <ol className="space-y-1">
              {w.stepLabels.map((label, i) => (
                <li key={i} className="text-foreground-muted flex gap-2">
                  <span className="w-3 text-center" title={w.stepStates[i]}>
                    {STEP_MARK[w.stepStates[i] ?? 'pending']}
                  </span>
                  <span className={cn(w.stepStates[i] === 'done' && 'text-foreground')}>
                    {label}
                  </span>
                </li>
              ))}
            </ol>
          )}
          <div>
            <p className="text-foreground-subtle mb-1 font-medium">Log</p>
            <ul className="text-foreground-muted space-y-0.5">
              {w.log.slice(-12).map((line, i) => (
                <li key={i}>
                  <span className="text-foreground-subtle">
                    {new Date(line.at).toLocaleTimeString([], {
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </span>{' '}
                  {line.text}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </li>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="text-foreground-subtle hover:text-foreground hover:bg-surface rounded-md p-1.5"
    >
      {children}
    </button>
  );
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}
