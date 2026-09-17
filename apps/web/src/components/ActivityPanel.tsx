/**
 * "Searching the web ▸" — and, when you ask, what that actually means.
 *
 * ── The rule this panel is built around ─────────────────────────────────────
 * It shows **observable actions**: the query that went out, the hosts that
 * came back, the folder that was walked, the application that was reached for.
 * It never shows deliberation. "Searching Microsoft's docs for this error" is
 * the right shape; anything resembling a private reasoning trace is not, and
 * the data model has no field it could arrive in — see `models/activity.ts`.
 *
 * ── Collapsed by default, and quiet about it ────────────────────────────────
 * The collapsed row is one line that says what is happening now. Expanding is
 * for the person who wants the detail, and it is the same disclosure shape the
 * finished-run summary already uses, so the two read as one idea rather than
 * two components that happen to both have arrows.
 *
 * The height animation measures the content rather than guessing a max-height,
 * which is what keeps a two-step run and a nine-step run both open cleanly
 * instead of one snapping and the other easing.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { elapsedLabel, summarizeRun, type ActivityRun, type ActivityState, type ActivityStep } from '@atlas/core';
import { Icons, cn } from '@atlas/ui';

const STATE_STYLE: Record<ActivityState, { className: string; label: string }> = {
  running: { className: 'text-primary', label: 'Running' },
  done: { className: 'text-success', label: 'Done' },
  failed: { className: 'text-danger', label: 'Failed' },
  skipped: { className: 'text-foreground-subtle', label: 'Skipped' },
  halted: { className: 'text-danger', label: 'Stopped' },
};

function StateDot({ state }: { state: ActivityState }) {
  const style = STATE_STYLE[state];
  if (state === 'running') {
    return (
      <span className={cn('relative flex h-2 w-2 shrink-0', style.className)} aria-label="Running">
        <span className="absolute inline-flex h-full w-full rounded-full bg-current opacity-60 motion-safe:animate-ping" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-current" />
      </span>
    );
  }
  return (
    <span
      aria-label={style.label}
      className={cn('grid h-2 w-2 shrink-0 place-items-center', style.className)}
    >
      <span className="h-2 w-2 rounded-full bg-current" />
    </span>
  );
}

export function ActivityPanel({ run }: { run: ActivityRun }) {
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  // Re-measured as steps arrive, so an open panel grows with the run instead
  // of clipping whatever lands after it was opened.
  useLayoutEffect(() => {
    if (!open) return;
    setHeight(body.current?.scrollHeight ?? 0);
  }, [open, run]);

  // A ticking clock only while something is actually running — an idle panel
  // does no work, and a finished one shows fixed durations.
  const active = run.state === 'running';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [active]);

  if (!run.steps.length && !active) return null;

  const summary = summarizeRun(run);

  return (
    <div className="max-w-[85%]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'text-foreground-subtle hover:text-foreground duration-fast -ml-1.5 flex items-center gap-1.5',
          'rounded-md px-1.5 py-1 text-xs transition',
          'focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2',
        )}
      >
        <Icons.ChevronRight
          className={cn('duration-fast h-3.5 w-3.5 transition-transform', open && 'rotate-90')}
        />
        {active && <StateDot state="running" />}
        <span className={cn(active && 'text-foreground')}>{summary}</span>
        {active && run.steps.length > 1 && (
          <span className="text-foreground-subtle">
            · {run.steps.filter((s) => s.state !== 'running' && s.state !== undefined).length + 1} of{' '}
            {run.steps.length}
          </span>
        )}
      </button>

      <div
        style={{ height: open ? height : 0 }}
        className="overflow-hidden transition-[height] duration-200 ease-out motion-reduce:transition-none"
      >
        <div ref={body} className="border-border ml-[5px] mt-1 border-l pl-3.5">
          {run.steps.map((step) => (
            <StepRow key={step.id} step={step} now={now} />
          ))}
        </div>
      </div>
    </div>
  );
}

function StepRow({ step, now }: { step: ActivityStep; now: number }) {
  return (
    <div className="py-1.5">
      <div className="flex items-baseline gap-2 text-xs">
        <span className="mt-1 self-start">
          <StateDot state={step.state} />
        </span>
        <span className="text-foreground min-w-0 flex-1">
          <span className="font-medium">{step.label}</span>
          {step.detail && (
            <span className="text-foreground-subtle"> — {step.detail}</span>
          )}
        </span>
        <span className="text-foreground-subtle shrink-0 tabular-nums">
          {elapsedLabel(step, now)}
        </span>
      </div>

      {step.children && step.children.length > 0 && (
        <ul className="border-border mt-1 space-y-1 border-l pl-3.5">
          {step.children.map((child) => (
            <li key={child.id} className="flex items-baseline gap-2 text-[11px]">
              <span className="mt-1 self-start">
                <StateDot state={child.state} />
              </span>
              <span className="text-foreground-muted min-w-0 flex-1">
                {child.label}
                {child.detail && (
                  <span className="text-foreground-subtle"> — {child.detail}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
