/**
 * Listening — Atlas hearing you.
 *
 * The mirror of `./speech`, and named against the same rule: `VoiceProfile` in
 * `./voice` already means what Atlas calls you, so the two directions of
 * actual audio are "speech" and "listening" rather than anything with "voice"
 * in it.
 *
 * ── The microphone is off until you say otherwise ───────────────────────────
 * Every default here is the quiet one. `enabled` gates whether Atlas may ask
 * the OS for the microphone at all, and nothing in the app calls for it while
 * that is false — not to show a level meter, not to warm up a stream. A
 * microphone that turns itself on to be helpful is the single behaviour that
 * would make this app impossible to trust, and no feature is worth it.
 *
 * ── Hands-free is a place, not a mode ───────────────────────────────────────
 * Continuous listening is confined to a screen you open deliberately and that
 * says so while it is open. That is the difference between "Atlas is
 * listening because I am in the room where he listens" and "Atlas is
 * listening and I have to remember that".
 */

/** What came back from the transcription engine. */
export interface Transcript {
  /** What was heard. Empty when the audio held no speech. */
  text: string;
  /** True when the engine decided this was silence rather than words. */
  empty: boolean;
}

/**
 * How Atlas starts listening without a button press. Off unless the person chooses one, and it only has any
 * effect while `ListeningPreferences.enabled` is on too. While one is chosen the microphone stream is open and
 * analysed on this PC (nothing recorded or stored) and a visible indicator says so.
 */
export type ActivationMode = 'off' | 'clap' | 'wake' | 'both';

export const ACTIVATION_MODES: readonly ActivationMode[] = ['off', 'clap', 'wake', 'both'];

export interface ListeningPreferences {
  /**
   * May Atlas use the microphone at all. Off by default, and the only gate
   * that matters: while this is false no code path calls `getUserMedia`.
   */
  enabled: boolean;
  /**
   * In the voice screen, listen again once Atlas has finished answering,
   * without being asked. Only ever consulted inside that screen.
   *
   * OFF by default (was on until 1.0.4). Brandon's rule: the microphone never
   * records without the button being pressed. Hands-free keeps it open across
   * turns after one press, so it has to be something a person switches on,
   * not something they find on.
   */
  handsFree: boolean;
  /**
   * Talking over Atlas stops him mid-sentence.
   *
   * Worth having because the alternative is worse than it sounds: without it,
   * interrupting a long answer means waiting for the answer you already know
   * you do not want. Depends on the browser's echo cancellation to avoid
   * Atlas interrupting himself, which is why it is a preference rather than
   * an assumption.
   */
  bargeIn: boolean;
  /**
   * How long a quiet stretch ends an utterance, in milliseconds.
   *
   * Too short and it cuts you off mid-thought; too long and every sentence
   * ends with an awkward wait. This is the one number people genuinely differ
   * on, so it is a setting rather than a constant.
   */
  silenceMs: number;
  /** How listening starts with no button: nothing (default), a double clap, a spoken phrase, or either. */
  activation: ActivationMode;
  /** The phrase that starts listening in wake modes. Any words the person chooses (see `validWakePhrase`). */
  wakePhrase: string;
  /** 1 (needs a loud clean clap) to 5 (a soft clap in a quiet room). */
  clapSensitivity: number;
}

export const DEFAULT_LISTENING: ListeningPreferences = {
  enabled: false,
  handsFree: false,
  bargeIn: true,
  silenceMs: 900,
  activation: 'off',
  clapSensitivity: 3,
  wakePhrase: 'Hey Atlas',
};

/** Words that are too common to wake anything: said on their own they would fire all day. */
const TOO_COMMON = new Set([
  'a',
  'an',
  'the',
  'hey',
  'hi',
  'hello',
  'ok',
  'okay',
  'yes',
  'no',
  'and',
  'you',
  'it',
  'is',
  'so',
  'well',
  'um',
  'uh',
  'oh',
]);

export type WakePhraseCheck = { ok: true; phrase: string } | { ok: false; reason: string };

/**
 * Is this usable as a wake phrase? Anything the person likes, within reason: one to four words, letters and
 * digits, long enough to be said on purpose. The check is for the matcher's sake (a phrase it cannot tell apart
 * from ordinary talk would fire constantly), not a judgement of the words.
 */
export function validWakePhrase(raw: string): WakePhraseCheck {
  const phrase = raw.replace(/\s+/g, ' ').trim();
  if (!phrase) return { ok: false, reason: 'Type the words that should wake Atlas.' };
  if (phrase.length > 40) return { ok: false, reason: 'Keep it under 40 characters.' };
  if (!/^[\p{L}\p{N}][\p{L}\p{N} '’-]*$/u.test(phrase))
    return { ok: false, reason: 'Use letters, numbers and spaces only.' };
  const words = phrase.split(' ');
  if (words.length > 4) return { ok: false, reason: 'Four words at most.' };
  const letters = phrase.replace(/[^\p{L}\p{N}]/gu, '');
  if (letters.length < 4)
    return {
      ok: false,
      reason: 'A little longer: at least four letters, so it is not set off by ordinary talk.',
    };
  if (words.every((w) => TOO_COMMON.has(w.toLowerCase())))
    return {
      ok: false,
      reason: 'Those words are too common on their own. Add a name, like “Hey Atlas”.',
    };
  return { ok: true, phrase };
}
