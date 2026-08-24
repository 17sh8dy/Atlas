/**
 * The React binding for `SpeechPlayer`, and the pipeline that keeps it fed.
 *
 * One player for the whole app, held in a ref: synthesised audio, the analyser
 * the visualiser reads, and the state Settings and the voice screen both
 * display. Two players would mean two Atlases able to talk at once.
 *
 * ── `speak()` is a pipeline, not a call ─────────────────────────────────────
 * A reply is cut into sentences, and each one is synthesised, handed to the
 * player, and left to play while the next is being made. So the silence before
 * Atlas starts talking is the time to synthesise *one sentence*, not the whole
 * answer — and because synthesis runs comfortably faster than speech, the
 * pieces after the first are always ready before the speaker reaches them.
 *
 * The player schedules the pieces on the audio clock so the joins cannot be
 * heard; see the note at the top of `player.ts` for why that is not the same
 * as chaining them on `onended`.
 *
 * ── Failure is handled differently for the first piece ──────────────────────
 * If the first piece fails there is no speech at all, and that is worth
 * reporting. If a later piece fails, Atlas is already talking, and the useful
 * thing is to stop cleanly rather than to throw away an answer that is
 * half-delivered. Both record the reason; only the first is a silent failure
 * anyone could mistake for success.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { segmentForSpeech, type Platform, type SpeechOptions } from '@atlas/core';
import { SpeechPlayer, type SpeechState } from './player';

export interface Speech {
  /** Synthesise and play. Resolves when playback has started, not finished. */
  speak(text: string, options?: SpeechOptions): Promise<void>;
  stop(): void;
  state: SpeechState;
  /** True when this build can speak at all. */
  supported: boolean;
  /**
   * Open the audio device before it is needed.
   *
   * Must be called from a user gesture. Costs nothing if already open, and
   * saves the device-open time from the first thing Atlas says — which is the
   * utterance the whole feature gets judged on.
   */
  prime(): void;
  /** Read from an animation frame, never from render. 0 when silent. */
  level(): number;
  /** Per-band amplitude, filled into the caller's array. Zeroed when silent. */
  bands(out: Float32Array): void;
  /**
   * Why the last attempt made no sound, or null.
   *
   * Failures used to be swallowed here on the theory that speech is an
   * accompaniment and shouldn't interrupt a reply. That was right for the
   * conversation and wrong for everything else: a Preview button that fails
   * silently is indistinguishable from a working one, which cost an entire
   * debugging round trip. The conversation still stays quiet; Settings shows
   * this.
   */
  lastError: string | null;
}

/**
 * Speaking happens on this machine. There is no other route.
 *
 * There used to be one — an `online` preference plus an OpenAI key, which
 * sent the sentence to be synthesised elsewhere. It is gone, along with the
 * key it needed. Nothing Atlas says leaves the machine, and that is now a
 * property of the code rather than of a switch someone has to leave alone.
 */
export function useSpeech(platform: Platform): Speech {
  const player = useMemo(() => new SpeechPlayer(), []);
  const [state, setState] = useState<SpeechState>('idle');
  const [lastError, setError] = useState<string | null>(null);

  useEffect(() => player.onStateChange(setState), [player]);

  // Stop talking when the window goes away. Coming back to a machine that is
  // still mid-sentence from ten minutes ago is unnerving.
  useEffect(() => {
    return () => player.stop();
  }, [player]);

  const platformRef = useRef(platform);
  platformRef.current = platform;

  const speak = useCallback(
    async (text: string, options?: SpeechOptions) => {
      const target = platformRef.current;
      if (!target.synthesizeSpeech) {
        setError('This build has no speech engine.');
        return;
      }

      const pieces = segmentForSpeech(text);
      if (pieces.length === 0) return;

      const synthesize = (piece: string): Promise<ArrayBuffer> =>
        target.synthesizeSpeech!.call(target, piece, options);

      const utterance = player.begin();

      for (let i = 0; i < pieces.length; i++) {
        // Something newer is being said, or everything was stopped. Abandoning
        // here matters: without it a cancelled reply keeps synthesising every
        // remaining sentence, competing for the CPU with the reply that
        // replaced it.
        if (utterance.cancelled) return;

        try {
          const audio = await synthesize(pieces[i]!);
          if (utterance.cancelled) return;

          if (!audio || audio.byteLength === 0) {
            // An engine that returns nothing for one sentence will very likely
            // return nothing for the next, so this ends the utterance rather
            // than grinding through the rest in silence.
            if (i === 0) setError('The speech engine returned no audio.');
            break;
          }

          await utterance.push(audio);
          if (i === 0) setError(null);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          break;
        }
      }

      utterance.close();
    },
    [player],
  );

  const stop = useCallback(() => player.stop(), [player]);
  const prime = useCallback(() => player.prime(), [player]);
  const level = useCallback(() => player.level(), [player]);
  const bands = useCallback((out: Float32Array) => player.bands(out), [player]);

  const supported = Boolean(platform.synthesizeSpeech);

  // Memoised for the same reason as `useListening`'s: the voice screen reads
  // `level` from an animation frame, and a new object on every render would
  // restart that loop continuously.
  return useMemo(
    () => ({ speak, stop, prime, state, supported, level, bands, lastError }),
    [speak, stop, prime, state, supported, level, bands, lastError],
  );
}
