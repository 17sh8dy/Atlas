/**
 * Listening for a typed wake phrase (see wake.ts for how it is matched and what it costs).
 *
 * Uses its own `Recorder` for the microphone and the existing local transcriber for the words, so it inherits
 * every promise they make: the stream is opened only while ALL of these hold (the microphone switch is on, a
 * wake mode is chosen, Privacy mode is not on, and Atlas is not itself using the microphone or the speakers) and
 * is CLOSED, not paused, the moment any stops being true. Each burst of speech is transcribed once, looked at
 * for the phrase, and dropped: nothing is stored, nothing is logged, and a transcript that does not start with
 * the phrase is never shown to anything else.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Platform } from '@atlas/core';
import { Recorder, type ListeningState } from '../recorder';
import { matchWake } from './wake';

/** A burst longer than this is a conversation, not a wake phrase, and is not worth the processor time. */
const MAX_BURST_MS = 8000;
/** A short pause ends a burst: the phrase is short, and a quick answer matters. */
const SILENCE_MS = 700;

export interface WakeActivation {
  /** The stream is genuinely open right now. */
  live: boolean;
  error: string | null;
}

interface Options {
  enabled: boolean;
  /** Atlas is using the microphone or speakers itself: close this stream meanwhile. */
  paused: boolean;
  phrase: string;
  platform: Platform;
  /** The phrase was heard. `rest` is whatever followed it ('' when nothing did). */
  onWake(rest: string): void;
}

export function useWakeActivation({
  enabled,
  paused,
  phrase,
  platform,
  onWake,
}: Options): WakeActivation {
  const recorder = useMemo(() => new Recorder(), []);
  const [state, setState] = useState<ListeningState>('idle');
  const [error, setError] = useState<string | null>(null);
  const latest = useRef({ onWake, phrase, platform });
  latest.current = { onWake, phrase, platform };
  // One transcription at a time; while one runs, only the newest burst waits behind it.
  const busy = useRef(false);
  const waiting = useRef<ArrayBuffer | null>(null);

  const wanted = enabled && !paused && Boolean(platform.transcribeSpeech);
  useEffect(() => {
    if (!wanted) {
      recorder.stop();
      waiting.current = null;
      return;
    }
    setError(null);

    const transcribe = async (audio: ArrayBuffer): Promise<void> => {
      const { platform: p, phrase: wake } = latest.current;
      if (!p.transcribeSpeech) return;
      busy.current = true;
      try {
        // The phrase leads the transcriber's prompt (measured: 23 of 24 hearings, versus about 6 in 10 with it last).
        const heard = await p.transcribeSpeech(audio, undefined, wake);
        if (heard.empty || !heard.text.trim()) return;
        const m = matchWake(heard.text, wake);
        if (m.matched) latest.current.onWake(m.rest);
      } catch {
        // Silence and a failed read both end the same way: nothing to act on. Never log what was heard.
      } finally {
        busy.current = false;
        const next = waiting.current;
        waiting.current = null;
        if (next) void transcribe(next);
      }
    };

    void recorder.start(
      {
        onState: setState,
        onError: setError,
        onUtterance: ({ audio, durationMs }) => {
          if (durationMs > MAX_BURST_MS) return;
          if (busy.current) waiting.current = audio;
          else void transcribe(audio);
        },
      },
      { silenceMs: SILENCE_MS },
    );
    return () => {
      recorder.stop();
      waiting.current = null;
    };
  }, [wanted, recorder]);

  return { live: wanted && state !== 'idle', error };
}
