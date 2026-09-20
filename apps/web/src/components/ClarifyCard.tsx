/**
 * A question Atlas asks when a request left something out.
 *
 * Meant to read as part of the conversation, not as a dialog or an error: it
 * sits in the transcript like any other message, in the same width, with the
 * same border language as a confirmation card — because it is the same kind of
 * moment, Atlas waiting on the person before it goes on. It differs from a
 * confirmation in what it asks: not "may I?" but "which?".
 *
 * ── Choices and typing, both ────────────────────────────────────────────────
 * Numbered options for the common answers, and the composer below stays open
 * for anything else. An option that needs a name ("Tell me a specific game")
 * opens a field right here; the rest resolve on a click. Numbers work when
 * typed, too (`readClarifyReply`).
 *
 * Once answered it stays in the record as what was asked and what was chosen,
 * dimmed, so scrolling back explains why Atlas did what it did.
 */

import { useState } from 'react';
import type { ClarifyAnswer, ClarifyChoice } from '@atlas/core';
import { Button, Icons, Input, cn } from '@atlas/ui';

export interface ClarifyCardProps {
  question: string;
  choices: readonly ClarifyChoice[];
  /** `yes`: answered. `no`: walked away. `halted`: the emergency stop landed first. */
  answered?: 'yes' | 'no' | 'halted';
  /** What was chosen or typed, for the record. */
  reply?: string;
  onAnswer(answer: ClarifyAnswer, label: string): void;
}

export function ClarifyCard({ question, choices, answered, reply, onAnswer }: ClarifyCardProps) {
  // The option currently asking for typing, and what has been typed so far.
  const [typing, setTyping] = useState<ClarifyChoice | null>(null);
  const [draft, setDraft] = useState('');

  const submit = () => {
    const text = draft.trim();
    if (!typing || !text) return;
    onAnswer({ kind: 'text', text, many: Boolean(typing.input?.many) }, text);
  };

  return (
    <div
      className={cn(
        'duration-fast max-w-[85%] rounded-xl border p-4 transition',
        answered ? 'border-border bg-surface/50 opacity-70' : 'border-primary/40 bg-primary/5',
      )}
    >
      <div className="flex items-start gap-2.5">
        <Icons.Compass className="text-primary mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-foreground text-sm font-medium">{question}</p>

          {answered ? (
            <p className="text-foreground-subtle mt-2 text-xs">
              {answered === 'yes'
                ? `✓ ${reply ? `You chose: ${reply}` : 'You answered.'}`
                : answered === 'halted'
                  ? 'Halted before this was answered.'
                  : '✕ You left it.'}
            </p>
          ) : typing ? (
            <div className="mt-3">
              <p className="text-foreground-subtle mb-1.5 text-xs">{typing.label}</p>
              <div className="flex gap-2">
                <Input
                  autoFocus
                  value={draft}
                  placeholder={typing.input?.placeholder}
                  spellCheck={false}
                  autoComplete="off"
                  aria-label={typing.label}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submit();
                    if (e.key === 'Escape') {
                      setTyping(null);
                      setDraft('');
                    }
                  }}
                />
                <Button size="sm" disabled={!draft.trim()} onClick={submit}>
                  Continue
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setTyping(null);
                    setDraft('');
                  }}
                >
                  Back
                </Button>
              </div>
            </div>
          ) : (
            <>
              <ol className="mt-3 flex flex-col gap-1.5">
                {choices.map((choice, i) => (
                  <li key={choice.id}>
                    <button
                      type="button"
                      onClick={() =>
                        choice.input
                          ? setTyping(choice)
                          : onAnswer({ kind: 'choice', id: choice.id }, choice.label)
                      }
                      className={cn(
                        'border-border text-foreground hover:bg-surface-raised hover:border-border-strong',
                        'duration-fast flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-sm transition',
                        'focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2',
                      )}
                    >
                      <span className="text-primary w-4 shrink-0 text-xs font-medium tabular-nums">
                        {i + 1}
                      </span>
                      <span>{choice.label}</span>
                    </button>
                  </li>
                ))}
              </ol>
              <p className="text-foreground-subtle mt-2 text-xs">Or just type your answer below.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
