/**
 * Tasks — what Atlas ran as several steps, step by step, and where each one ended.
 *
 * ── Read-only, on purpose ───────────────────────────────────────────────────
 * This page shows the task books and offers two controls that only ever make *less* happen or
 * hand the decision back to you: Cancel (stop before the next step) and Resume (which asks you,
 * in the conversation, about any step whose fate is unknown). Nothing here runs a step itself;
 * every step of every task goes through the normal checks and approvals.
 *
 * ── Honest labels ───────────────────────────────────────────────────────────
 * "Confirmed" appears only for a step whose result Atlas read back and saw. A finished step with
 * nothing to read back says "done", and a read-only step says it only read. A step that may or
 * may not have happened says exactly that.
 */

import { useEffect, useState } from 'react';
import type { Task, TaskStep } from '@atlas/core';
import { FINISHED_TASK_STATUSES, summarizeTask } from '@atlas/core';
import type { TaskStore } from '@atlas/engine';
import { Button, Icons, cn } from '@atlas/ui';
import { timeAgo } from '../../lib/timeAgo';

export interface TasksHandle {
  store: TaskStore;
  /** Ask the running task to stop before its next step. False if none is running. */
  cancel(id: string): boolean;
}

interface Props {
  tasks: TasksHandle;
  /** Hand the decision about a stopped task to the conversation, where its questions are asked. */
  onResume(): void;
}

const STATUS: Record<Task['status'], { label: string; tone: string }> = {
  planned: { label: 'Not started', tone: 'text-foreground-muted' },
  running: { label: 'Running', tone: 'text-accent' },
  awaiting: { label: 'Waiting for you', tone: 'text-warning' },
  interrupted: { label: 'Stopped part-way', tone: 'text-warning' },
  done: { label: 'Done', tone: 'text-foreground-subtle' },
  partial: { label: 'Partly done', tone: 'text-warning' },
  failed: { label: 'Failed', tone: 'text-danger' },
  cancelled: { label: 'Cancelled', tone: 'text-foreground-subtle' },
};

const MARK: Record<TaskStep['status'], string> = {
  done: '✓',
  failed: '✗',
  uncertain: '?',
  blocked: '⛔',
  skipped: '–',
  cancelled: '–',
  pending: '…',
  running: '▶',
};

/** What a step's row says after its label — only what the books support. */
export function stepNote(s: TaskStep): string | null {
  if (s.status === 'done') {
    if (s.verified === 'confirmed') return s.evidence ? `confirmed — ${s.evidence}` : 'confirmed';
    if (s.verified === 'unconfirmed') return s.evidence ? `done, but not confirmed — ${s.evidence}` : 'done, but not confirmed';
    return s.readOnly ? 'read-only' : (s.reason ?? null);
  }
  if (s.status === 'failed') return s.error ?? 'failed';
  return s.reason ?? null;
}

export function Tasks({ tasks, onResume }: Props) {
  const [list, setList] = useState<Task[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      void tasks.store.list().then((all) => {
        if (alive) setList([...all].reverse());
      });
    load();
    const off = tasks.store.subscribe(load);
    return () => {
      alive = false;
      off();
    };
  }, [tasks]);

  return (
    <div>
      <section className="mb-6">
        <h2 className="text-foreground mb-1 text-sm font-medium">Tasks</h2>
        <p className="text-foreground-muted text-xs leading-relaxed">
          Jobs Atlas ran as several steps, with what each step did. Try “run the pc-checkup task” or
          “run the space review task on Downloads”. Every step goes through the same checks and
          approvals as anything you type, and the emergency stop ends a task like anything else. If
          one is stopped part-way, a step that was in progress is never run again without asking
          you.
        </p>
      </section>

      {list === null ? (
        <p className="text-foreground-subtle text-xs">Loading…</p>
      ) : list.length === 0 ? (
        <p className="border-border bg-surface/40 text-foreground-subtle rounded-xl border px-4 py-6 text-center text-xs leading-relaxed">
          No tasks yet. Say “run the pc-checkup task”.
        </p>
      ) : (
        <ul className="border-border divide-border divide-y overflow-hidden rounded-xl border text-sm">
          {list.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              expanded={open === task.id}
              onToggle={() => setOpen(open === task.id ? null : task.id)}
              onCancel={() => tasks.cancel(task.id)}
              onResume={onResume}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function TaskRow({
  task,
  expanded,
  onToggle,
  onCancel,
  onResume,
}: {
  task: Task;
  expanded: boolean;
  onToggle(): void;
  onCancel(): void;
  onResume(): void;
}) {
  const status = STATUS[task.status];
  const sum = summarizeTask(task);
  const finished = FINISHED_TASK_STATUSES.includes(task.status);
  const stopped = task.status === 'interrupted' || task.status === 'awaiting';

  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-3">
        <Icons.Activity className={cn('mt-0.5 h-4 w-4 shrink-0', status.tone)} />
        <button type="button" onClick={onToggle} className="text-foreground min-w-0 flex-1 text-left">
          <span className="block truncate">{task.goal}</span>
          <span className="text-foreground-subtle block truncate text-xs">
            <span className={status.tone}>{status.label}</span>
            {` · ${sum.done} of ${sum.total} steps`}
            {sum.confirmed > 0 && ` · ${sum.confirmed} confirmed`}
            {` · ${timeAgo(task.updatedAt)}`}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {task.status === 'running' && (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
          {stopped && (
            <Button size="sm" variant="secondary" onClick={onResume}>
              Resume…
            </Button>
          )}
        </div>
      </div>

      {(expanded || stopped) && (
        <ol className="ml-7 mt-3 space-y-1 text-xs">
          {task.steps.map((s) => {
            const note = stepNote(s);
            return (
              <li key={s.id} className="text-foreground-muted flex gap-2">
                <span className="w-3 shrink-0 text-center" title={s.status}>
                  {MARK[s.status]}
                </span>
                <span className={cn(s.status === 'done' && 'text-foreground')}>
                  {s.label}
                  {note && <span className="text-foreground-subtle"> — {note}</span>}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {stopped && sum.uncertain > 0 && (
        <p className="text-warning ml-7 mt-2 text-xs">
          {sum.uncertain} step{sum.uncertain === 1 ? '' : 's'} may or may not have happened. Atlas
          won’t run {sum.uncertain === 1 ? 'it' : 'them'} again unless you say so.
        </p>
      )}
      {finished && task.status === 'partial' && (
        <p className="text-foreground-subtle ml-7 mt-2 text-xs">
          Some steps finished and the rest did not run; each says why.
        </p>
      )}
    </li>
  );
}
