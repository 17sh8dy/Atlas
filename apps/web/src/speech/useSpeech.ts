/**
 * The React binding for `SpeechPlayer`.
 *
 * One player for the whole app, held in a ref: synthesised audio, the analyser
 * the visualiser reads, and the state Settings and the voice screen both
 * display. Two players would mean two Atlases able to talk at once.
 *
 * `speak()` is what every caller uses — Settings previews with it, and the
 * conversation speaks replies with it. Synthesis failures are swallowed on
 * purpose: speech is an accompaniment to a reply that is already on screen, so
 * a missing voice should be silence, never an error bubble.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Platform, SpeechOptions } from '@atlas/core';
import { SpeechPlayer, type SpeechState } from './player';

export interface Speech {
  /** Synthesise and play. Resolves when playback has started, not finished. */
  speak(text: string, options?: SpeechOptions): Promise<void>;
  stop(): void;
  state: SpeechState;
  /** True when this build can speak at all. */
  supported: boolean;
  /** Read from an animation frame, never from render. 0 when silent. */
  level(): number;
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
      const synth = platformRef.current.synthesizeSpeech;
      if (!synth) {
        setError('This build has no speech engine.');
        return;
      }
      try {
        const audio = await synth.call(platformRef.current, text, options);
        if (!audio || audio.byteLength === 0) {
          setError('The speech engine returned no audio.');
          return;
        }
        await player.play(audio);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [player],
  );

  const stop = useCallback(() => player.stop(), [player]);
  const level = useCallback(() => player.level(), [player]);

  return {
    speak,
    stop,
    state,
    supported: Boolean(platform.synthesizeSpeech),
    level,
    lastError,
  };
}
