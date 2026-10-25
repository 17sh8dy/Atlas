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
}

export function useClapActivation({
  enabled,
  paused,
  sensitivity,
  onDouble,
}: Options): ClapActivation {
  const listener = useMemo(() => new ClapListener(), []);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(onDouble);
  latest.current = onDouble;

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
