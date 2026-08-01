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

import { useEffect, useRef } from 'react';
import { Button, Icons, cn } from '@atlas/ui';
import type { Entry } from '../atlas/useAtlas';

interface Props {
  entries: Entry[];
  busy: boolean;
  onAnswerConfirm(approved: boolean): void;
  onRunAction(skill: string, args: Record<string, string | number | boolean>): void;
}

export function Transcript({ entries, busy, onAnswerConfirm, onRunAction }: Props) {
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
        />
      ))}

      {busy && (
        <div className="flex items-center gap-2 text-sm text-foreground-subtle">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
          Working…
        </div>
      )}

      <div ref={endRef} />
    </div>
  );
}

function EntryView({
  entry,
  onAnswerConfirm,
  onRunAction,
}: {
  entry: Entry;
  onAnswerConfirm(approved: boolean): void;
  onRunAction(skill: string, args: Record<string, string | number | boolean>): void;
}) {
  if (entry.kind === 'you') {
    return (
      <div className="self-end max-w-[80%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-primary-foreground">
        {entry.text}
      </div>
    );
  }

  if (entry.kind === 'atlas') {
    return (
      <div className="max-w-[85%] whitespace-pre-wrap text-sm leading-relaxed text-foreground">
        {entry.text}
      </div>
    );
  }

  if (entry.kind === 'confirm') {
    const answered = entry.answered;
    return (
      <div
        className={cn(
          'max-w-[85%] rounded-xl border p-4 transition duration-fast',
          answered === 'yes' && 'border-border bg-surface/50 opacity-70',
          answered === 'no' && 'border-border bg-surface/50 opacity-70',
          !answered && 'border-primary/40 bg-primary/5',
        )}
      >
        <div className="flex items-start gap-2.5">
          <Icons.Shield className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{entry.question}</p>
            {entry.detail && (
              <p className="mt-1 break-all text-xs text-foreground-subtle">{entry.detail}</p>
            )}

            {answered ? (
              <p className="mt-2 text-xs text-foreground-subtle">
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

  // Results.
  return (
    <div className="max-w-[92%] overflow-hidden rounded-xl border border-border bg-surface/40">
      {entry.meta?.title && (
        <div className="flex items-baseline justify-between border-b border-border px-4 py-2.5">
          <span className="text-xs font-medium text-foreground">{entry.meta.title}</span>
          {entry.meta.subtitle && (
            <span className="text-xs text-foreground-subtle">{entry.meta.subtitle}</span>
          )}
        </div>
      )}

      <ul className="divide-y divide-border">
        {entry.rows?.map((row, i) => (
          <li key={i} className="flex items-center gap-3 px-4 py-2.5">
            <span className="text-base leading-none">{row.icon ?? '•'}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-foreground">{row.title}</p>
              {row.subtitle && (
                <p className="truncate text-xs text-foreground-subtle">{row.subtitle}</p>
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
