/**
 * The React binding for the double-clap listener.
 *
 * The microphone is open only while ALL of these hold: the person switched the microphone on, chose "double
 * clap" as how to start, and Atlas is not already using it for something else (the voice screen, dictation) or
 * speaking. The moment any of them stops being true the stream is closed — not paused, closed — so the
 * recording indicator Windows shows is exactly as long as the thing the person asked for.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ClapListener } from './clapListener';

/** Fired on `window` whenever a clap or a double clap is recognised (detail: 'clap' | 'double'). */
export const CLAP_HEARD = 'atlas:clap-heard';

export interface ClapActivation {
  /** The stream is genuinely open and analysing right now. */
  live: boolean;
  error: string | null;
}

interface Options {
  /** Everything that must be true for a clap to be listened for at all. */
  enabled: boolean;
  /** Atlas is using (or about to use) the microphone or the speakers itself: close the stream meanwhile. */
  paused: boolean;
  sensitivity: number;
  onDouble(): void;
  /** Where tuning numbers go when `atlas.debug.clap` is set in local storage (off by default). */
  trace?(line: string): void;
}

/** Tuning numbers are recorded only when this is switched on (localStorage `atlas.debug.clap` = 1). */
function tracing(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('atlas.debug.clap') === '1';
  } catch {
    return false;
  }
}

export function useClapActivation({
  enabled,
  paused,
  sensitivity,
  onDouble,
  trace,
}: Options): ClapActivation {
  const listener = useMemo(() => new ClapListener(), []);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(onDouble);
  latest.current = onDouble;
  const traceRef = useRef(trace);
  traceRef.current = trace;

  const wanted = enabled && !paused;
  useEffect(() => {
    if (!wanted) {
      listener.stop();
      setLive(false);
      return;
    }
    setError(null);
    void listener.start(
      {
        onDouble: () => latest.current(),
        onHeard: (kind) => window.dispatchEvent(new CustomEvent(CLAP_HEARD, { detail: kind })),
        ...(tracing() ? { onTrace: (line: string) => traceRef.current?.(line) } : {}),
        onLive: setLive,
        onError: (message) => {
          setError(message);
          setLive(false);
        },
      },
      sensitivity,
    );
    return () => {
      listener.stop();
      setLive(false);
    };
  }, [wanted, sensitivity, listener]);

  return { live, error };
}
