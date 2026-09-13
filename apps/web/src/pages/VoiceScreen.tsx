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
 * It reads the real signal — the microphone's spectrum while you talk, the
 * synthesised audio's while Atlas answers — so it cannot show the wrong
 * state. A spinner would be honest about *waiting* and dishonest about
 * everything else: it would keep spinning through a dead microphone, a muted
 * input, a stalled transcriber. This moves when sound moves.
 *
 * See `components/VoiceOrb` for how it is drawn and why it is a canvas.
 *
 * ── The greeting fills the one genuinely empty moment ───────────────────────
 * The orb breathes and the field drifts even at rest (see `VoiceOrb` and
 * `AmbientField`'s own doc comments), so motion was never actually missing.
 * What was missing was anything to *read* the first time this screen opens
 * and nothing has been said yet — an orb and a status pill with no content
 * around them. `greeting` is the same line Home already says out loud
 * (`Phrasing.greeting()`), shown here because it happens to be exactly right
 * for a screen about talking to Atlas, not because it was invented for this
 * one. It steps aside the moment there is something real to show instead —
 * `heard`/`reply` — the same "real content beats a filler line" rule Home's
 * Recent Activity follows.
 */

import { Icons, cn } from '@atlas/ui';
import { VoiceOrb } from '../components/VoiceOrb';
import { AmbientField } from '../components/AmbientField';

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
  /** Per-band amplitude, filled into the caller's array. Read every frame. */
  bands(out: Float32Array): void;
  /** The last thing Atlas heard you say. */
  heard: string | null;
  /** The last thing Atlas said back. */
  reply: string | null;
  /** Shown only until there's something real to show instead — see the module doc comment. */
  greeting: string;
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
  bands,
  heard,
  reply,
  greeting,
  handsFree,
  error,
  onToggle,
  onClose,
}: Props) {
  const live = phase !== 'off';

  return (
    <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-8 px-8 py-10">
      {/* Behind everything, and behind it on purpose — see AmbientField. */}
      <AmbientField level={level} active={live} />

      {!live && !heard && !reply && (
        <p className="text-foreground relative max-w-sm text-center text-sm leading-relaxed">
          {greeting}
        </p>
      )}

      <div className="relative flex flex-col items-center gap-6">
        <button
          type="button"
          onClick={onToggle}
          aria-label={live ? 'Stop listening' : 'Start listening'}
          className="relative grid h-60 w-60 place-items-center rounded-full outline-none"
        >
          <span className="pointer-events-none absolute inset-0 grid place-items-center">
            <VoiceOrb phase={phase} bands={bands} level={level} size={240} />
          </span>

          {/* The mark sits inside the shape rather than beside it, so the one
              thing you press is the one thing that is moving. */}
          <span
            className={cn(
              'accent-surface text-primary-foreground relative grid h-16 w-16 place-items-center rounded-full',
              'duration-base transition',
              !live && 'opacity-60 grayscale',
            )}
          >
            {live ? <Icons.Mic className="h-6 w-6" /> : <Icons.MicOff className="h-6 w-6" />}
          </span>
        </button>

        <div className="flex flex-col items-center gap-2.5">
          {/* The status sits on glass rather than on the background, because
              the background now moves. Text laid straight onto the aurora is
              legible right up until a blob drifts under it. */}
          <p className="atlas-glass text-foreground rounded-full px-4 py-1.5 text-sm font-medium">
            {LABEL[phase]}
          </p>
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
      <div className="relative flex w-full max-w-md flex-col gap-3">
        {error && (
          <div className="border-warning/40 bg-warning/5 rounded-lg border px-4 py-3">
            <p className="text-foreground-subtle break-words text-xs leading-relaxed">{error}</p>
          </div>
        )}
        {/* One panel for the exchange rather than one per line: two floating
            cards in front of a moving field is two things to read past, and
            the pair belongs together anyway — it is a turn, not two events. */}
        {(heard || reply) && (
          <div className="atlas-glass flex flex-col gap-3 rounded-2xl px-5 py-4">
            {heard && (
              <div className="flex flex-col gap-1">
                <span className="text-foreground-subtle text-[11px] font-medium uppercase tracking-wide">
                  You said
                </span>
                <p className="text-foreground text-sm leading-relaxed">{heard}</p>
              </div>
            )}
            {heard && reply && <div className="bg-border-strong/40 h-px w-full" />}
            {reply && (
              <div className="flex flex-col gap-1">
                <span className="text-foreground-subtle text-[11px] font-medium uppercase tracking-wide">
                  Atlas
                </span>
                <p className="text-foreground-muted text-sm leading-relaxed">{reply}</p>
              </div>
            )}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={onClose}
        className="text-foreground-subtle hover:text-foreground duration-fast relative text-xs transition"
      >
        Back to the conversation
      </button>
    </div>
  );
}
