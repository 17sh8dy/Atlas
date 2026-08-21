/**
 * Talking to Atlas — the screen where the microphone is open.
 *
 * ── Why listening has a place rather than a mode ────────────────────────────
 * A microphone that can be on anywhere is a microphone you have to remember
 * the state of, and remembering is exactly what an assistant is supposed to
 * save you. So continuous listening lives on a screen you open on purpose,
 * that says what it is doing the whole time it is doing it, and that closes
 * the device when you leave. "Atlas is listening because I am on the screen
 * where he listens" is a thing a person can hold in their head.
 *
 * ── The visualiser is a status light, not decoration ────────────────────────
 * It reads the real signal — the microphone's level while you talk, the
 * synthesised audio's while Atlas answers — so it cannot show the wrong
 * state. A spinner would be honest about *waiting* and dishonest about
 * everything else: it would keep spinning through a dead microphone, a muted
 * input, a stalled transcriber. This moves when sound moves, and is still
 * when there is none.
 *
 * It updates from an animation frame writing a CSS variable, never from React
 * state. Sixty renders a second to move a circle would be sixty reconciliations
 * of a screen that is otherwise still.
 */

import { useEffect, useRef } from 'react';
import { Icons, cn } from '@atlas/ui';

export type VoicePhase =
  /** Microphone closed. Nothing is being captured. */
  | 'off'
  /** Open, waiting for you to say something. */
  | 'listening'
  /** You are talking. */
  | 'hearing'
  /** You stopped; the words are being worked out. */
  | 'transcribing'
  /** Atlas is working on an answer. */
  | 'thinking'
  /** Atlas is talking. */
  | 'speaking';

interface Props {
  phase: VoicePhase;
  /** Live 0–1 amplitude. Read on every frame, never rendered. */
  level(): number;
  /** The last thing Atlas heard you say. */
  heard: string | null;
  /** The last thing Atlas said back. */
  reply: string | null;
  /** Whether the loop continues on its own after each answer. */
  handsFree: boolean;
  /** Why nothing is happening, if something is wrong. */
  error: string | null;
  onToggle(): void;
  onClose(): void;
}

const LABEL: Record<VoicePhase, string> = {
  off: 'Microphone off',
  listening: 'Listening',
  hearing: 'Listening',
  transcribing: 'Working out what you said',
  thinking: 'Thinking',
  speaking: 'Speaking',
};

export function VoiceScreen({
  phase,
  level,
  heard,
  reply,
  handsFree,
  error,
  onToggle,
  onClose,
}: Props) {
  const orb = useRef<HTMLDivElement>(null);
  const live = phase !== 'off';

  /**
   * The amplitude loop.
   *
   * Smoothed on the way in, because the raw value is jittery enough to make
   * the orb buzz rather than breathe, and a display that buzzes reads as
   * broken however accurate it is. Decays faster than it rises so the ring
   * follows a syllable up and settles down after it, the way a level meter
   * does.
   */
  useEffect(() => {
    if (!live) {
      orb.current?.style.setProperty('--voice-level', '0');
      return;
    }
    let frame = 0;
    let smoothed = 0;
    const tick = () => {
      const next = level();
      smoothed = next > smoothed ? smoothed + (next - smoothed) * 0.5 : smoothed * 0.86;
      orb.current?.style.setProperty('--voice-level', smoothed.toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [live, level]);

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-8 px-8 py-10">
      <div className="flex flex-col items-center gap-6">
        <button
          type="button"
          onClick={onToggle}
          aria-label={live ? 'Stop listening' : 'Start listening'}
          className="group relative grid h-40 w-40 place-items-center rounded-full outline-none"
        >
          {/* Two rings driven by the same variable at different gains: the
              outer one overshoots, which is what makes a loud syllable read
              as a pulse rather than as a step. */}
          <span
            ref={orb}
            className={cn(
              'absolute inset-0 rounded-full transition-colors',
              live ? 'bg-primary/10' : 'bg-surface',
            )}
            style={{ ['--voice-level' as string]: '0' }}
          >
            <span
              className={cn(
                'absolute inset-0 rounded-full',
                live ? 'bg-primary/15' : 'bg-transparent',
              )}
              style={{
                transform: 'scale(calc(1 + var(--voice-level) * 0.34))',
                opacity: 'calc(0.35 + var(--voice-level) * 0.65)',
              }}
            />
            <span
              className={cn(
                'absolute inset-4 rounded-full',
                live ? 'bg-primary/25' : 'bg-transparent',
              )}
              style={{ transform: 'scale(calc(1 + var(--voice-level) * 0.18))' }}
            />
          </span>

          {/* The idle breath. Only while the microphone is open and nothing is
              being said — a still screen would be indistinguishable from a
              frozen one, and this is the difference between "waiting for you"
              and "stopped working". */}
          <span
            className={cn(
              'accent-surface text-primary-foreground relative grid h-20 w-20 place-items-center rounded-full',
              'duration-base transition',
              phase === 'listening' && 'motion-safe:animate-pulse',
              !live && 'opacity-60 grayscale',
            )}
          >
            {live ? (
              <Icons.Mic className="h-8 w-8" />
            ) : (
              <Icons.MicOff className="h-8 w-8" />
            )}
          </span>
        </button>

        <div className="flex flex-col items-center gap-1.5">
          <p className="text-foreground text-sm font-medium">{LABEL[phase]}</p>
          <p className="text-foreground-subtle text-xs">
            {live
              ? handsFree
                ? 'Just talk. Atlas answers, then listens again.'
                : 'Talk, then wait. Press the circle to listen again.'
              : 'Press the circle to open the microphone.'}
          </p>
        </div>
      </div>

      {/* The last exchange, in text. A voice interface with no transcript is a
          black box the moment it mishears you — and it will mishear you. */}
      <div className="flex w-full max-w-md flex-col gap-3">
        {error && (
          <div className="border-warning/40 bg-warning/5 rounded-lg border px-4 py-3">
            <p className="text-foreground-subtle break-words text-xs leading-relaxed">{error}</p>
          </div>
        )}
        {heard && (
          <div className="flex flex-col gap-1">
            <span className="text-foreground-subtle text-[11px] font-medium uppercase tracking-wide">
              You said
            </span>
            <p className="text-foreground text-sm leading-relaxed">{heard}</p>
          </div>
        )}
        {reply && (
          <div className="flex flex-col gap-1">
            <span className="text-foreground-subtle text-[11px] font-medium uppercase tracking-wide">
              Atlas
            </span>
            <p className="text-foreground-muted text-sm leading-relaxed">{reply}</p>
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={onClose}
        className="text-foreground-subtle hover:text-foreground duration-fast text-xs transition"
      >
        Back to the conversation
      </button>
    </div>
  );
}
