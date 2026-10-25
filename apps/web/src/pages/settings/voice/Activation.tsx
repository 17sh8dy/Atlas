/**
 * Starting to listen without pressing anything: a double clap, a phrase the person types, or either.
 *
 * Off unless chosen, and only offered once the microphone itself is switched on. The wording says exactly what
 * each costs, because both keep the microphone open: Atlas analyses the sound on this PC and keeps nothing.
 */

import { useEffect, useState } from 'react';
import type { ActivationMode, ListeningPreferences } from '@atlas/core';
import { validWakePhrase } from '@atlas/core';
import { SegmentedControl } from '@atlas/ui';
import { CLAP_HEARD } from '../../../speech/activation/useClapActivation';

const OPTIONS: ReadonlyArray<{ value: ActivationMode; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'clap', label: 'Double clap' },
  { value: 'wake', label: 'Say a phrase' },
  { value: 'both', label: 'Either' },
];

interface Props {
  listening: ListeningPreferences;
  onChange(next: Partial<ListeningPreferences>): void;
}

export function Activation({ listening, onChange }: Props) {
  const [phrase, setPhrase] = useState(listening.wakePhrase);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => setPhrase(listening.wakePhrase), [listening.wakePhrase]);

  // "Try it": what the detector just heard, so sensitivity can be tuned on THIS microphone without guessing.
  const [heard, setHeard] = useState<{ kind: 'clap' | 'double'; at: number } | null>(null);
  useEffect(() => {
    const on = (e: Event) =>
      setHeard({ kind: (e as CustomEvent<'clap' | 'double'>).detail, at: Date.now() });
    window.addEventListener(CLAP_HEARD, on);
    return () => window.removeEventListener(CLAP_HEARD, on);
  }, []);
  useEffect(() => {
    if (!heard) return;
    const t = setTimeout(() => setHeard(null), 2500);
    return () => clearTimeout(t);
  }, [heard]);

  const wake = listening.activation === 'wake' || listening.activation === 'both';
  const clap = listening.activation === 'clap' || listening.activation === 'both';

  const commit = () => {
    const checked = validWakePhrase(phrase);
    if (!checked.ok) {
      setProblem(checked.reason);
      return;
    }
    setProblem(null);
    if (checked.phrase !== listening.wakePhrase) onChange({ wakePhrase: checked.phrase });
    setPhrase(checked.phrase);
  };

  return (
    <div className="flex flex-col gap-2">
      <span className="text-foreground text-sm">Start listening without pressing anything</span>
      <SegmentedControl
        options={OPTIONS}
        value={listening.activation}
        onChange={(activation) => onChange({ activation })}
      />
      <p className="text-foreground-subtle text-xs leading-relaxed">
        {listening.activation === 'off'
          ? 'Off. Atlas only listens when you press the microphone button.'
          : 'While this is on Atlas keeps the microphone open and analyses the sound on this PC. Nothing is recorded or stored, Windows shows its microphone indicator, and so does Atlas. Privacy mode (General → Background) turns it off.'}
      </p>

      {clap && (
        <p className="text-foreground-subtle text-xs leading-relaxed">
          Double clap: two sharp claps about half a second apart. Speech, knocks and applause are
          ignored. Try it now: this shows what Atlas hears.{' '}
          <span className="text-foreground" aria-live="polite">
            {heard ? (heard.kind === 'double' ? '✓ Heard a double clap' : '✓ Heard a clap') : ''}
          </span>
        </p>
      )}

      {wake && (
        <div className="flex flex-col gap-1.5">
          <label className="text-foreground text-sm" htmlFor="wake-phrase">
            The phrase that wakes Atlas
          </label>
          <input
            id="wake-phrase"
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && commit()}
            maxLength={40}
            placeholder="Hey Atlas"
            className="border-border bg-surface text-foreground h-9 w-full max-w-xs rounded-md border px-3 text-sm"
          />
          {problem ? (
            <p className="text-danger text-xs">{problem}</p>
          ) : (
            <p className="text-foreground-subtle text-xs leading-relaxed">
              Any words you like, up to four. Atlas reads short bursts of speech on this PC and
              looks for them at the start; the text is thrown away unless it starts with your
              phrase. It uses some processor time when there is talking nearby and reacts about a
              second after you finish. Say it with a request (“{listening.wakePhrase}, open
              Spotify”) and Atlas does it straight away.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
