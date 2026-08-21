/**
 * The conversation.
 *
 * Four entry shapes, because an assistant that can act needs to show more than
 * two colours of speech bubble: what you said, what Atlas said, rows you can
 * act on, and the approval gate that stands in front of anything risky.
 *
 * The confirmation card is the one worth looking at twice. It renders inline in
 * the transcript rather than as a modal, so the request stays in the context
 * that produced it — and once answered it stays visible, showing what you
 * decided. An approval that vanishes leaves no record of having been given.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Icons, cn } from '@atlas/ui';
import type { EngineStatus } from '@atlas/engine';
import type { Entry } from '../atlas/useAtlas';

interface Props {
  entries: Entry[];
  busy: boolean;
  /** What Atlas is doing, when it is worth naming. */
  status?: EngineStatus | null;
  onAnswerConfirm(approved: boolean): void;
  onRunAction(skill: string, args: Record<string, string | number | boolean>): void;
  onCopy(text: string): Promise<boolean>;
}

export function Transcript({
  entries,
  busy,
  status,
  onAnswerConfirm,
  onRunAction,
  onCopy,
}: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [entries.length, busy, status?.label]);

  return (
    <div className="flex flex-col gap-3 px-6 py-5">
      {entries.map((entry) => (
        <EntryView
          key={entry.id}
          entry={entry}
          onAnswerConfirm={onAnswerConfirm}
          onRunAction={onRunAction}
          onCopy={onCopy}
        />
      ))}

      {busy && <StatusLine status={status} />}

      <div ref={endRef} />
    </div>
  );
}

/**
 * The one line that says what Atlas is doing.
 *
 * It replaces a permanent "Working…", which was the same whether Atlas opened
 * an app in forty milliseconds or spent four seconds on a network round trip.
 * Naming the stage is what makes a long pause legible instead of alarming —
 * and naming the PROVIDER is the part that matters most in a local-first
 * assistant, because "Switching to Claude…" is the moment the user's question
 * stops being handled on their own machine. That deserves to be visible
 * rather than inferred.
 *
 * Falls back to the generic line when no stage is set, which is the ordinary
 * case for local commands that finish too fast to narrate.
 */
function StatusLine({ status }: { status?: EngineStatus | null }) {
  const stage = status?.stage ?? 'working';
  const Icon =
    stage === 'searching' ? Icons.Globe : stage === 'working' ? Icons.Activity : Icons.Sparkles;

  return (
    <div
      className="text-foreground-subtle flex items-center gap-2 text-sm"
      // Announced politely so a screen reader hears the escalation without
      // it interrupting whatever is already being read.
      role="status"
      aria-live="polite"
    >
      <span
        className={cn(
          'grid h-5 w-5 place-items-center rounded-md transition',
          // The hand-off to a model is the one stage worth colouring. Tinting
          // every stage would make the accent meaningless; tinting none would
          // lose the only moment a user might want to notice.
          stage === 'switching' || stage === 'thinking'
            ? 'bg-primary/10 text-primary'
            : 'text-foreground-subtle',
        )}
      >
        <Icon className={cn('h-3.5 w-3.5', stage !== 'working' && 'animate-pulse')} />
      </span>

      <span className="animate-pulse">{status?.label ?? 'Working…'}</span>

      {/* Only ever shown for a provider that runs on this machine, because
          that is the reassuring case and the one worth a word. A remote
          provider is already named in the label itself. */}
      {status?.local && (
        <span className="border-border text-foreground-subtle rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
          on this device
        </span>
      )}
    </div>
  );
}

/**
 * The action rail under an assistant message. Copy is the only action so far,
 * and it is built as a rail rather than a lone button so the next one (retry,
 * speak, save as note) lands here instead of inventing a second pattern.
 *
 * What it copies is exactly `entry.text` — the string already on screen.
 * There is no hidden metadata to strip because the transcript never holds
 * any: skill ids, arguments and outcomes live on the engine's own entries,
 * and results rows are a different entry kind that has no rail at all.
 */
function MessageActions({
  text,
  onCopy,
}: {
  text: string;
  onCopy(text: string): Promise<boolean>;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A message can be copied, then copied again before the confirmation has
  // faded. Without clearing, the first timer resets the label while the
  // second copy is still fresh.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const handle = useCallback(async () => {
    const ok = await onCopy(text);
    setState(ok ? 'copied' : 'failed');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1600);
  }, [onCopy, text]);

  if (!text.trim()) return null;

  return (
    <div className="mt-1.5 flex items-center gap-1">
      <button
        type="button"
        onClick={handle}
        // Visible on hover and on keyboard focus, and always visible once
        // pressed so the confirmation cannot be missed by moving the mouse.
        className={cn(
          'text-foreground-subtle hover:text-foreground hover:bg-surface duration-fast',
          'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition',
          'focus-visible:opacity-100',
          state === 'idle' ? 'opacity-0 group-hover:opacity-100' : 'opacity-100',
        )}
        aria-label={state === 'copied' ? 'Copied to clipboard' : 'Copy this message'}
      >
        {state === 'copied' ? (
          <Icons.Check className="h-3.5 w-3.5" />
        ) : (
          <Icons.Clipboard className="h-3.5 w-3.5" />
        )}
        {state === 'copied' ? 'Copied' : state === 'failed' ? "Couldn't copy" : 'Copy'}
      </button>
    </div>
  );
}

function EntryView({
  entry,
  onAnswerConfirm,
  onRunAction,
  onCopy,
}: {
  entry: Entry;
  onAnswerConfirm(approved: boolean): void;
  onRunAction(skill: string, args: Record<string, string | number | boolean>): void;
  onCopy(text: string): Promise<boolean>;
}) {
  if (entry.kind === 'you') {
    return (
      <div className="accent-surface text-primary-foreground max-w-[80%] self-end rounded-2xl rounded-br-md px-4 py-2.5 text-sm">
        {entry.text}
      </div>
    );
  }

  if (entry.kind === 'atlas') {
    // The action rail sits in a group wrapper rather than inside the message,
    // so the button never reflows the text it belongs to.
    return (
      <div className="group max-w-[85%]">
        <div className="text-foreground whitespace-pre-wrap text-sm leading-relaxed">
          {entry.text}
        </div>
        <MessageActions text={entry.text ?? ''} onCopy={onCopy} />
      </div>
    );
  }

  if (entry.kind === 'confirm') {
    const answered = entry.answered;
    return (
      <div
        className={cn(
          'duration-fast max-w-[85%] rounded-xl border p-4 transition',
          answered === 'yes' && 'border-border bg-surface/50 opacity-70',
          answered === 'no' && 'border-border bg-surface/50 opacity-70',
          !answered && 'border-primary/40 bg-primary/5',
        )}
      >
        <div className="flex items-start gap-2.5">
          <Icons.Shield className="text-primary mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-foreground text-sm font-medium">{entry.question}</p>
            {entry.detail && (
              <p className="text-foreground-subtle mt-1 break-all text-xs">{entry.detail}</p>
            )}

            {answered ? (
              <p className="text-foreground-subtle mt-2 text-xs">
                {answered === 'yes' ? '✓ You approved this.' : '✕ You declined this.'}
              </p>
            ) : (
              <div className="mt-3 flex gap-2">
                <Button size="sm" onClick={() => onAnswerConfirm(true)}>
                  Yes, do it
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onAnswerConfirm(false)}>
                  Cancel
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Results rows have their own actions already, and a result list is not
  // prose — copying it would produce a wall of titles nobody asked for. So
  // only spoken messages get the rail.

  // Results.
  return (
    <div className="border-border bg-surface/40 max-w-[92%] overflow-hidden rounded-xl border">
      {entry.meta?.title && (
        <div className="border-border flex items-baseline justify-between border-b px-4 py-2.5">
          <span className="text-foreground text-xs font-medium">{entry.meta.title}</span>
          {entry.meta.subtitle && (
            <span className="text-foreground-subtle text-xs">{entry.meta.subtitle}</span>
          )}
        </div>
      )}

      <ul className="divide-border divide-y">
        {entry.rows?.map((row, i) => (
          <li key={i} className="flex items-center gap-3 px-4 py-2.5">
            <span className="text-base leading-none">{row.icon ?? '•'}</span>
            <div className="min-w-0 flex-1">
              <p className="text-foreground truncate text-sm">{row.title}</p>
              {row.subtitle && (
                <p className="text-foreground-subtle truncate text-xs">{row.subtitle}</p>
              )}
            </div>
            <div className="flex shrink-0 gap-1.5">
              {row.actions?.map((action) => (
                <Button
                  key={action.label}
                  size="sm"
                  variant="ghost"
                  onClick={() => onRunAction(action.skill, action.args)}
                >
                  {action.label}
                </Button>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
