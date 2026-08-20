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
        <div className="text-foreground-subtle flex items-center gap-2 text-sm">
          <span className="bg-primary h-1.5 w-1.5 animate-pulse rounded-full" />
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
      <div className="accent-surface text-primary-foreground max-w-[80%] self-end rounded-2xl rounded-br-md px-4 py-2.5 text-sm">
        {entry.text}
      </div>
    );
  }

  if (entry.kind === 'atlas') {
    return (
      <div className="text-foreground max-w-[85%] whitespace-pre-wrap text-sm leading-relaxed">
        {entry.text}
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
