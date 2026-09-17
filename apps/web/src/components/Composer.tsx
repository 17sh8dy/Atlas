/**
 * The input. The only control Atlas actually needs.
 *
 * It grows with what you type up to a limit, submits on Enter, and takes a
 * newline on Shift+Enter — the conventions people already have from every other
 * text box worth using. It also takes focus back after every send, because an
 * assistant you have to click into between commands is one you stop using.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ExecutionMode } from '@atlas/core';
import { EXECUTION_MODE_META } from '@atlas/core';
import { Icons, Kbd, cn } from '@atlas/ui';

interface Props {
  onSubmit(text: string): void;
  busy: boolean;
  /**
   * A confirmation card is open and waiting for an answer.
   *
   * ⚠️ Separate from `busy`, and the whole reason this prop exists: while a
   * card is up the executor is parked on it, so `busy` is true — and gating
   * input on `busy` alone silently swallowed the answer. Typing "yes" put the
   * word in the box and did nothing; only the button worked, and only voice
   * reached the path built for exactly this. `useAtlas.ask` has always
   * handled a typed answer correctly; nothing could get one to it.
   */
  awaitingAnswer?: boolean;
  /** How much Atlas asks before it acts — see `@atlas/core`'s execution-mode model. */
  executionMode: ExecutionMode;
  onCycleExecutionMode(): void;
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
  /**
   * Set by a Home card (`Conversation`'s `EmptyState`): replaces whatever is
   * in the box and focuses it, cursor at the end, so the person finishes the
   * sentence themselves. Unlike `dictated`, this replaces rather than appends
   * — a card click always starts from an empty composer, since Home only
   * renders when there is nothing typed yet.
   */
  prefill?: { text: string; at: number } | null;
  /**
   * The emergency stop. The button is the backup, not the mechanism — the key
   * works from anywhere, focused or not, and this is for when a mouse is
   * already in hand. Absent props mean no stop is on offer (never the case in
   * the app today, but a composer in a test needn't have one).
   */
  onStop?(): void;
  /** The stop key Windows actually has registered, shown next to the button. */
  stopKey?: string | null;
  /** Atlas is halted: show it, and offer to carry on. */
  halted?: boolean;
  onResume?(): void;
}

const MAX_HEIGHT = 160;

export function Composer({
  onSubmit,
  busy,
  awaitingAnswer = false,
  executionMode,
  onCycleExecutionMode,
  placeholder = 'Ask Atlas anything…',
  dictation,
  dictated,
  prefill,
  onStop,
  stopKey,
  halted = false,
  onResume,
}: Props) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const lastDictation = useRef(0);
  const lastPrefill = useRef(0);

  useEffect(() => {
    if (!dictated || dictated.at === lastDictation.current) return;
    lastDictation.current = dictated.at;
    setValue((current) => (current.trim() ? `${current.trim()} ${dictated.text}` : dictated.text));
    ref.current?.focus();
  }, [dictated]);

  useEffect(() => {
    if (!prefill || prefill.at === lastPrefill.current) return;
    lastPrefill.current = prefill.at;
    setValue(prefill.text);
    // The textarea's value updates on the next render; wait for it to land
    // before moving the caret, or it snaps back to index 0.
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [prefill]);

  // Grow to fit, but stop before the transcript is squeezed off screen.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  // Focus follows the same rule as sending: an open card means the caret
  // belongs in the box, since answering by typing is the point.
  const blocked = busy && !awaitingAnswer;

  useEffect(() => {
    if (!blocked) ref.current?.focus();
  }, [blocked]);

  const send = () => {
    const text = value.trim();
    if (!text || blocked) return;
    setValue('');
    onSubmit(text);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
    // Shift+Tab would otherwise move focus backward out of the box — the
    // browser's default for a plain textarea, since it doesn't insert a tab
    // character either way. Claimed here for mode-cycling instead, which is
    // why the chip below advertises exactly this key.
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      onCycleExecutionMode();
    }
  };

  // Stop takes Send's place while Atlas works — the same spot, so the hand is
  // already there. Except when a card is open and something has been typed:
  // that is an answer on its way, and Send has to stay reachable for it.
  const showStop = Boolean(onStop) && busy && !(awaitingAnswer && value.trim());

  return (
    <div className="border-border bg-background/80 border-t px-6 py-4 backdrop-blur">
      {halted && (
        <div
          role="status"
          className="border-danger/30 bg-danger/5 mb-3 flex items-center gap-3 rounded-xl border px-3.5 py-2.5"
        >
          <span
            aria-hidden="true"
            className="bg-danger grid h-5 w-5 shrink-0 place-items-center rounded-[5px]"
          >
            <span className="h-2 w-2 rounded-[1.5px] bg-white" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-foreground text-sm font-medium">Atlas halted</p>
            <p className="text-foreground-subtle text-xs">
              Everything stopped. Nothing else runs until you send something new.
            </p>
          </div>
          {onResume && (
            <button
              type="button"
              onClick={onResume}
              className="text-foreground-muted hover:text-foreground hover:bg-surface duration-fast rounded-md px-2.5 py-1 text-xs font-medium transition"
            >
              Resume
            </button>
          )}
        </div>
      )}
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
            // atlas-enhance: opt-in hook for the Enhanced Effects setting
            // (styles/index.css) — inert unless it's on. Triggers on
            // focus-within rather than hover alone, since typing into it is
            // the whole point of this bar existing.
            'atlas-enhance',
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
                'atlas-enhance relative mb-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg',
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
          {showStop ? (
            <button
              type="button"
              onClick={onStop}
              aria-label={stopKey ? `Stop Atlas (${stopKey})` : 'Stop Atlas'}
              title={stopKey ? `Stop Atlas — ${stopKey}` : 'Stop Atlas'}
              className={cn(
                // A physical-feeling key rather than another flat icon: a
                // raised face and an inset edge, in the one colour this app
                // reserves for danger.
                'mb-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg',
                'bg-danger text-white shadow-[inset_0_-2px_0_rgb(0_0_0/0.25),0_1px_2px_rgb(0_0_0/0.3)]',
                'duration-fast transition hover:brightness-110 active:translate-y-px active:shadow-none',
                'focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2',
              )}
            >
              <span aria-hidden="true" className="h-2.5 w-2.5 rounded-[2px] bg-white" />
            </button>
          ) : (
          <button
            type="button"
            onClick={send}
            disabled={!value.trim() || blocked}
            aria-label="Send"
            className={cn(
              'atlas-enhance mb-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg',
              'accent-surface text-primary-foreground duration-fast transition',
              'hover:brightness-110 disabled:opacity-30 disabled:hover:brightness-100',
            )}
          >
            <Icons.ArrowUp className="h-4 w-4" />
          </button>
          )}
        </div>
      </div>

      {/*
        The mode indicator. Not a setting buried in a menu — it sits exactly
        where the thing it changes happens, the same reason the speech toggle
        sits in the title bar rather than only in Settings (see AtlasApp).
        Clicking it cycles too, so the control isn't keyboard-only.

        Shaped as a real pill — the same border/rounded-full/px-2.5 language
        `NovaSwitcher`'s trigger uses — rather than a loose row of text
        fragments, so it reads as one deliberate control with a name, not an
        instruction strip. The shortcut stays visible (it's still how the
        keyboard reaches it) but sits outside the pill, smaller and quieter:
        secondary to the mode itself.
      */}
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={onCycleExecutionMode}
          title={EXECUTION_MODE_META[executionMode].description}
          className={cn(
            'atlas-enhance border-border text-foreground-muted hover:bg-surface hover:text-foreground',
            'duration-fast flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition',
          )}
        >
          <span aria-hidden="true" className="text-primary tracking-tighter">
            ⏵⏵
          </span>
          <span>{EXECUTION_MODE_META[executionMode].label}</span>
        </button>
        <span className="text-foreground-subtle inline-flex items-center gap-1 text-[11px]">
          <Kbd>Shift</Kbd>+<Kbd>Tab</Kbd> to cycle
        </span>
        {/* The stop key, named while there is something to stop — the moment
            someone is most likely to need it and least likely to remember it. */}
        {busy && stopKey && (
          <span className="text-foreground-subtle ml-auto inline-flex items-center gap-1 text-[11px]">
            {stopKey.split('+').map((part, i) => (
              <span key={i} className="inline-flex items-center gap-1">
                {i > 0 && '+'}
                <Kbd>{part}</Kbd>
              </span>
            ))}{' '}
            to stop
          </span>
        )}
      </div>
    </div>
  );
}
