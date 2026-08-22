/**
 * The input. The only control Atlas actually needs.
 *
 * It grows with what you type up to a limit, submits on Enter, and takes a
 * newline on Shift+Enter — the conventions people already have from every other
 * text box worth using. It also takes focus back after every send, because an
 * assistant you have to click into between commands is one you stop using.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Icons, cn } from '@atlas/ui';

interface Props {
  onSubmit(text: string): void;
  busy: boolean;
  placeholder?: string;
  /**
   * Dictation, when this build can listen and the microphone is switched on.
   * Absent rather than disabled otherwise — a button that explains why it
   * does nothing is still a button that does nothing.
   */
  dictation?: {
    active: boolean;
    transcribing: boolean;
    onToggle(): void;
  };
  /**
   * Words dictated into the box.
   *
   * They land here to be *read* rather than being sent straight off. A
   * transcriber acting on what it thinks it heard is one that eventually
   * deletes something, and the half-second it takes to glance at a sentence
   * is the whole difference. `at` rather than the text alone, so saying the
   * same thing twice appends twice.
   */
  dictated?: { text: string; at: number } | null;
}

const MAX_HEIGHT = 160;

export function Composer({
  onSubmit,
  busy,
  placeholder = 'Ask Atlas anything…',
  dictation,
  dictated,
}: Props) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const lastDictation = useRef(0);

  useEffect(() => {
    if (!dictated || dictated.at === lastDictation.current) return;
    lastDictation.current = dictated.at;
    setValue((current) => (current.trim() ? `${current.trim()} ${dictated.text}` : dictated.text));
    ref.current?.focus();
  }, [dictated]);

  // Grow to fit, but stop before the transcript is squeezed off screen.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  useEffect(() => {
    if (!busy) ref.current?.focus();
  }, [busy]);

  const send = () => {
    const text = value.trim();
    if (!text || busy) return;
    setValue('');
    onSubmit(text);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="border-border bg-background/80 border-t px-6 py-4 backdrop-blur">
      {/*
        The ring says Atlas is working, and only that.

        A composer that looks identical whether or not a question is in flight
        is the reason people press Enter twice. This is the one place a person
        is already looking when they are waiting, so it is where the waiting
        belongs — better than a spinner somewhere else on the screen, and much
        better than a permanently animated border, which would be decoration
        and would stop meaning anything within a day.

        Built by rotating a box carrying a conic gradient inside a rounded,
        clipped wrapper, with the input sitting a pixel inside it. Animating a
        gradient's angle directly would need `@property`, and this has to be
        right in a WebView rather than only in the newest CSS engine.
      */}
      <div className="relative rounded-xl p-px">
        {busy && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl"
          >
            <span
              className="atlas-orbit absolute left-1/2 top-1/2 aspect-square w-[160%] -translate-x-1/2 -translate-y-1/2"
              style={{
                background:
                  'conic-gradient(from 0deg, transparent 0deg, transparent 250deg, rgb(var(--color-primary)) 320deg, transparent 360deg)',
              }}
            />
          </span>
        )}

        <div
          className={cn(
            'border-border bg-surface relative flex items-end gap-2 rounded-[11px] border px-3 py-2',
            'duration-fast focus-within:border-border-strong transition',
            // While the ring is turning the border would fight it, so the
            // input's own edge steps back and lets the ring be the edge.
            busy && 'border-transparent',
          )}
        >
          <textarea
            ref={ref}
            rows={1}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              dictation?.transcribing
                ? 'Working out what you said…'
                : dictation?.active
                  ? 'Listening — just talk, and it lands here.'
                  : placeholder
            }
            className={cn(
              'text-foreground flex-1 resize-none bg-transparent py-1.5 text-sm',
              'placeholder:text-foreground-subtle focus:outline-none',
            )}
          />
          {dictation && (
            <button
              type="button"
              onClick={dictation.onToggle}
              aria-label={dictation.active ? 'Stop dictating' : 'Dictate'}
              aria-pressed={dictation.active}
              title={dictation.active ? 'Stop dictating' : 'Dictate'}
              className={cn(
                'relative mb-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg',
                'duration-fast transition',
                dictation.active
                  ? 'bg-primary/15 text-primary'
                  : 'text-foreground-subtle hover:bg-surface-raised hover:text-foreground',
              )}
            >
              {/* The dot is the recording indicator, and it is deliberately
                inside the button rather than somewhere tidier: the control
                that opened the microphone is the one place a person will look
                to check whether it is still open. */}
              {dictation.active && (
                <span className="bg-primary absolute right-1 top-1 h-1.5 w-1.5 rounded-full motion-safe:animate-pulse" />
              )}
              <Icons.Mic className={cn('h-4 w-4', dictation.transcribing && 'opacity-40')} />
            </button>
          )}
          <button
            type="button"
            onClick={send}
            disabled={!value.trim() || busy}
            aria-label="Send"
            className={cn(
              'mb-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg',
              'accent-surface text-primary-foreground duration-fast transition',
              'hover:brightness-110 disabled:opacity-30 disabled:hover:brightness-100',
            )}
          >
            <Icons.ArrowUp className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
