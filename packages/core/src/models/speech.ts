/**
 * Speech — Atlas saying things out loud.
 *
 * ── Named "speech", never "voice" ───────────────────────────────────────────
 * `VoiceProfile` in `./voice` already means something else entirely: what
 * Atlas calls you and what it calls itself. That name was taken before this
 * feature existed, and `phrasing.ts` carries a comment explaining it was
 * deliberately not called "voice" so that this feature could be. Keeping the
 * two apart in the type names is the whole reason a reader can tell which one
 * a piece of code means.
 *
 * ── Personas are speakers, not sliders ──────────────────────────────────────
 * The obvious design is one voice with pitch and timbre controls. The engine
 * underneath does not work that way: pitch is not a parameter a neural TTS
 * model exposes, and faking it by resampling makes a voice sound broken
 * rather than different. What the model does offer is 109 genuinely distinct
 * speakers, so a persona *is* a speaker — plus pace, which is real.
 */

/** One selectable voice. */
export interface SpeechVoice {
  /** Stable id used in settings and passed to the engine. */
  id: string;
  /** What the picker shows: "British male — Surrey". */
  label: string;
  /** Grouping in the picker. */
  group: 'male' | 'female';
  /** Where the speaker is from, as the corpus documents it. */
  region: string;
}

export interface SpeechOptions {
  /** Which voice to use. Falls back to the default when unknown. */
  voiceId?: string;
  /**
   * Pace. 1 is the model's natural speed; higher is slower, because this maps
   * to the engine's length scale rather than to a rate multiplier. Clamped by
   * the implementation, so a bad value is slow or brisk, never silent.
   */
  pace?: number;
}

/** What the app remembers about speaking, through the `Storage` port. */
export interface SpeechPreferences {
  /** Off by default: an assistant that starts talking unasked is startling. */
  enabled: boolean;
  voiceId: string;
  pace: number;
}

export const DEFAULT_SPEECH: SpeechPreferences = {
  enabled: false,
  voiceId: 'male-surrey',
  pace: 1.06,
};
