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

export interface ListeningPreferences {
  /**
   * May Atlas use the microphone at all. Off by default, and the only gate
   * that matters: while this is false no code path calls `getUserMedia`.
   */
  enabled: boolean;
  /**
   * In the voice screen, listen again once Atlas has finished answering,
   * without being asked. Only ever consulted inside that screen.
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
}

export const DEFAULT_LISTENING: ListeningPreferences = {
  enabled: false,
  handsFree: true,
  bargeIn: true,
  silenceMs: 900,
};
