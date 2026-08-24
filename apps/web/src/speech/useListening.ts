/**
 * The React binding for `Recorder`, plus the trip to the transcriber.
 *
 * One recorder for the whole app, held in a ref: the composer's mic button and
 * the voice screen both drive it, and two would mean two microphone
 * indicators and two claims on the device.
 *
 * What this hook does *not* own is the conversation loop — hearing a sentence
 * and deciding to answer it are different jobs, and the second one needs the
 * engine. This turns audio into text and says when it is busy; the caller
 * decides what a sentence means.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Platform } from '@atlas/core';
import { Recorder, type ListeningState } from './recorder';

export interface Listening {
  /**
   * Open the microphone and start transcribing whatever is said into it.
   *
   * Safe to call twice; the second call is ignored rather than opening a
   * second device.
   */
  start(): Promise<void>;
  /** Close the microphone. This is what puts the OS recording light out. */
  stop(): void;
  state: ListeningState;
  /** True while a finished utterance is being turned into text. */
  transcribing: boolean;
  /** True when this build can listen at all. */
  supported: boolean;
  /** Read from an animation frame, never from render. 0 when closed. */
  level(): number;
  /** Per-band amplitude, filled into the caller's array. Zeroed when closed. */
  bands(out: Float32Array): void;
  /** Why the last attempt heard nothing, or null. */
  error: string | null;
  /** Raise the speech gate while Atlas is talking, so he cannot interrupt himself. */
  setDucked(ducked: boolean): void;
}

interface Options {
  /** Called with each finished sentence. Never called with an empty one. */
  onTranscript(text: string): void;
  /**
   * Called the moment speech is detected, before it has been transcribed.
   * This is barge-in's hook: stopping Atlas has to happen when you start
   * talking, not a second and a half later when the sentence is understood.
   */
  onSpeechStart?(): void;
  /** How long a quiet stretch ends an utterance. */
  silenceMs?: number;
  /**
   * Extra vocabulary for the transcriber — the names of installed apps.
   *
   * Worth threading all the way through: without it "open CrosshairX" comes
   * back as three ordinary words and the app resolution work downstream never
   * gets a chance.
   */
  hints?: string;
}

export function useListening(platform: Platform, options: Options): Listening {
  const recorder = useMemo(() => new Recorder(), []);
  const [state, setState] = useState<ListeningState>('idle');
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Held in a ref so the recorder's callbacks always see the current handlers
  // without tearing down and reopening the microphone on every render.
  const latest = useRef(options);
  latest.current = options;
  const platformRef = useRef(platform);
  platformRef.current = platform;

  const supported = Boolean(platform.transcribeSpeech);

  /**
   * Report a failure to the screen *and* to the diagnostics file.
   *
   * Both, not either. The screen is where a person sees it; the file is where
   * it can still be read when the thing that broke is the rendering, or when
   * the report arrives second-hand as "it just didn't do anything".
   */
  const fail = useCallback((message: string) => {
    setError(message);
    void platformRef.current.logDiagnostic?.('listening', message).catch(() => {
      // A diagnostics channel that throws must not become the thing being
      // diagnosed.
    });
  }, []);

  const start = useCallback(async () => {
    if (!platformRef.current.transcribeSpeech) {
      fail('This build has no listening engine.');
      return;
    }
    setError(null);
    await recorder.start(
      {
        onState: setState,
        onSpeechStart: () => latest.current.onSpeechStart?.(),
        onError: fail,
        onUtterance: async ({ audio }) => {
          const target = platformRef.current;
          if (!target.transcribeSpeech) return;
          setTranscribing(true);
          try {
            // On this machine, always. The connected-service branch that used
            // to sit here is gone along with its key.
            const heard = await target.transcribeSpeech.call(target, audio, latest.current.hints);
            // Silence is a normal outcome, not a failure: a door closing
            // crosses the gate and transcribes to nothing. Reporting it would
            // fill the screen with apologies for noises.
            if (!heard.empty && heard.text.trim()) {
              latest.current.onTranscript(heard.text.trim());
            }
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err));
          } finally {
            setTranscribing(false);
          }
        },
      },
      { silenceMs: latest.current.silenceMs },
    );
  }, [recorder, fail]);

  /**
   * The caller fires this and forgets it, so the catch has to be here.
   *
   * `void listening.start()` at the call site would turn anything that
   * escaped into an unhandled rejection — silence, which is the one outcome
   * a microphone button must never produce.
   */
  const startSafely = useCallback(async () => {
    try {
      await start();
    } catch (err) {
      fail(`Listening could not start (${err instanceof Error ? err.message : String(err)}).`);
    }
  }, [start, fail]);

  const stop = useCallback(() => recorder.stop(), [recorder]);
  const level = useCallback(() => recorder.level(), [recorder]);
  const bands = useCallback((out: Float32Array) => recorder.bands(out), [recorder]);
  const setDucked = useCallback((ducked: boolean) => recorder.setDucked(ducked), [recorder]);

  // Closing the microphone when the app goes away is not politeness, it is the
  // difference between a recording indicator that means something and one that
  // is always on.
  useEffect(() => () => recorder.stop(), [recorder]);

  // Memoised, and not only to quiet the linter. The visualiser runs an
  // animation loop keyed on `level`, so a fresh object every render would tear
  // that loop down and rebuild it sixty times a second — and every effect that
  // legitimately depends on "the microphone" would fire on every render.
  return useMemo(
    () => ({
      start: startSafely,
      stop,
      state,
      transcribing,
      supported,
      level,
      bands,
      error,
      setDucked,
    }),
    [startSafely, stop, state, transcribing, supported, level, bands, error, setDucked],
  );
}
