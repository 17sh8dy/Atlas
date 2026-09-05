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
import { AuroraBars, Button, Icons, cn } from '@atlas/ui';
import type { Entry } from '../atlas/useAtlas';
import { CapabilityBrowser } from './CapabilityBrowser';

interface Props {
  entries: Entry[];
  busy: boolean;
  onAnswerConfirm(approved: boolean): void;
  onRunAction(skill: string, args: Record<string, string | number | boolean>): void;
  onCopy(text: string): Promise<boolean>;
  /**
   * Ask one of your own messages again.
   *
   * Worth having because a lot of what Atlas answers is a *reading* rather
   * than a fact — "what's running", disk space, the battery — and the honest
   * way to refresh one is to ask again, not to invent a cache to invalidate.
   */
  onAskAgain?(text: string): void;
}

export function Transcript({
  entries,
  busy,
  onAnswerConfirm,
  onRunAction,
  onCopy,
  onAskAgain,
}: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [entries.length, busy]);

  return (
    <div className="flex flex-col gap-3 px-6 py-5">
      {entries.map((entry) => (
        <EntryView
          key={entry.id}
          entry={entry}
          onAnswerConfirm={onAnswerConfirm}
          onRunAction={onRunAction}
          busy={busy}
          onCopy={onCopy}
          onAskAgain={onAskAgain}
        />
      ))}

      {/* Sized and placed like an assistant message, because that is what is
          about to replace it — the text lands where the bars were and nothing
          below it moves. A centred spinner would have to be pushed out of the
          way by the answer it was waiting for. */}
      {busy && <AuroraBars className="max-w-[85%]" label="Atlas is thinking" />}

      <div ref={endRef} />
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
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

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
  busy,
  onAnswerConfirm,
  onRunAction,
  onCopy,
  onAskAgain,
}: {
  entry: Entry;
  busy: boolean;
  onAnswerConfirm(approved: boolean): void;
  onRunAction(skill: string, args: Record<string, string | number | boolean>): void;
  onCopy(text: string): Promise<boolean>;
  onAskAgain?(text: string): void;
}) {
  if (entry.kind === 'you') {
    // The rail hangs under your own message, aligned right with it, and the
    // wrapper is what `group-hover` keys on — the same pattern the assistant's
    // copy button uses rather than a second one invented for this.
    return (
      <div className="group flex max-w-[80%] flex-col items-end self-end">
        <div className="accent-surface text-primary-foreground rounded-2xl rounded-br-md px-4 py-2.5 text-sm">
          {entry.text}
        </div>
        {entry.text?.trim() && onAskAgain && (
          <button
            type="button"
            onClick={() => onAskAgain(entry.text ?? '')}
            disabled={busy}
            className={cn(
              'text-foreground-subtle hover:text-foreground hover:bg-surface duration-fast',
              'mt-1.5 flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition',
              'opacity-0 focus-visible:opacity-100 group-hover:opacity-100',
              'disabled:pointer-events-none disabled:opacity-0',
            )}
            aria-label="Ask this again"
            title="Ask this again"
          >
            <Icons.RotateCcw className="h-3.5 w-3.5" />
            Again
          </button>
        )}
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
              // `whitespace-pre-wrap` alongside `break-all`: a single-step
              // confirmation is one long line that may need breaking mid-word
              // (a path), while a Plan First approval is a newline-joined
              // numbered list that has to keep its line breaks to read as one.
              <p className="text-foreground-subtle mt-1 whitespace-pre-wrap break-all text-xs">
                {entry.detail}
              </p>
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

  // Results that arrived with a grouping get the browser: sections with
  // counts, collapsed, so a hundred-odd rows read as "a lot of things" rather
  // than as a wall. A flat result set — a file search, a process list — is
  // still a flat list, because grouping it would be inventing structure the
  // skill did not report.
  if (entry.rows?.some((row) => row.group)) {
    return (
      <CapabilityBrowser
        rows={entry.rows}
        title={entry.meta?.title}
        subtitle={entry.meta?.subtitle}
      />
    );
  }

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
