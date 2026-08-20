/**
 * Voice — what Atlas sounds like.
 *
 * The tab that used to say "coming soon". Half of that note is now built and
 * half is still deliberately not: this is speaking only. Speech *recognition*
 * was the part that wanted a network round trip, and that tension hasn't been
 * resolved, so it isn't half-built here either.
 *
 * ── Preview is the whole design ─────────────────────────────────────────────
 * A voice cannot be chosen from a name. "Yorkshire" tells you almost nothing
 * about whether you want to listen to it for the next year, so every option
 * previews in place with one click and the list stays short enough to audition
 * end to end in under a minute. The five male options are five different
 * *regions* rather than five shades of received pronunciation — options that
 * sound alike are not options.
 */

import { useCallback, useEffect, useState } from 'react';
import { Icons, Surface, Switch, cn } from '@atlas/ui';
import type { SpeechPreferences, SpeechVoice } from '@atlas/core';

interface Props {
  /** Empty when this build has no speech engine. */
  voices: SpeechVoice[];
  preferences: SpeechPreferences;
  onChange(next: Partial<SpeechPreferences>): void;
  onPreview(voiceId: string): void;
  onStop(): void;
}

export function Voice({ voices, preferences, onChange, onPreview, onStop }: Props) {
  const [previewing, setPreviewing] = useState<string | null>(null);

  // The engine reports no completion event, so the label returns on a timer
  // rather than pretending to know when a sentence ended.
  useEffect(() => {
    if (!previewing) return;
    const t = setTimeout(() => setPreviewing(null), 2800);
    return () => clearTimeout(t);
  }, [previewing]);

  const preview = useCallback(
    (voiceId: string) => {
      setPreviewing(voiceId);
      onPreview(voiceId);
    },
    [onPreview],
  );

  if (!voices.length) {
    return (
      <Surface className="flex items-start gap-3 p-4">
        <Icons.VolumeX className="text-foreground-subtle mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <h2 className="text-foreground text-sm font-medium">Not available in this build</h2>
          <p className="text-foreground-subtle mt-1 text-xs leading-relaxed">
            Speaking needs the voice engine, which ships with the desktop app. Everything else
            works without it.
          </p>
        </div>
      </Surface>
    );
  }

  const groups = [
    {
      key: 'male' as const,
      title: 'British male',
      note: 'Five regions, not five takes on the same accent.',
    },
    { key: 'female' as const, title: 'British female', note: '' },
  ];

  return (
    <div className="flex flex-col gap-5">
      <Surface className="flex items-start justify-between gap-4 p-4">
        <div className="min-w-0">
          <h2 className="text-foreground text-sm font-medium">Speak replies</h2>
          <p className="text-foreground-subtle mt-1 text-xs leading-relaxed">
            Atlas reads its answers aloud. Synthesis runs on this machine — nothing is sent
            anywhere, and it works with no connection at all.
          </p>
        </div>
        <Switch
          checked={preferences.enabled}
          onCheckedChange={(enabled) => {
            // Turning it off should also stop the sentence already in the air.
            if (!enabled) onStop();
            onChange({ enabled });
          }}
          aria-label="Speak replies"
        />
      </Surface>

      {groups.map((group) => {
        const inGroup = voices.filter((v) => v.group === group.key);
        if (!inGroup.length) return null;

        return (
          <div key={group.key} className="flex flex-col gap-2">
            <div>
              <h3 className="text-foreground text-xs font-medium">{group.title}</h3>
              {group.note && <p className="text-foreground-subtle mt-0.5 text-xs">{group.note}</p>}
            </div>

            <Surface className="divide-border divide-y !p-0">
              {inGroup.map((voice) => {
                const selected = voice.id === preferences.voiceId;
                const playing = previewing === voice.id;
                return (
                  <div key={voice.id} className="flex items-center gap-3 px-4 py-2.5">
                    <button
                      type="button"
                      onClick={() => onChange({ voiceId: voice.id })}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                      aria-pressed={selected}
                    >
                      <span
                        className={cn(
                          'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                          selected ? 'border-primary bg-primary' : 'border-border',
                        )}
                      >
                        {selected && (
                          <span className="bg-background h-1.5 w-1.5 rounded-full" />
                        )}
                      </span>
                      <span className="text-foreground min-w-0 truncate text-sm">
                        {voice.region}
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => preview(voice.id)}
                      className="text-foreground-subtle hover:text-foreground hover:bg-surface duration-fast flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition"
                      aria-label={`Preview ${voice.label}`}
                    >
                      {playing ? (
                        <Icons.Volume2 className="h-3.5 w-3.5" />
                      ) : (
                        <Icons.Play className="h-3.5 w-3.5" />
                      )}
                      {playing ? 'Playing' : 'Preview'}
                    </button>
                  </div>
                );
              })}
            </Surface>
          </div>
        );
      })}

      <Surface className="p-4">
        <div className="flex items-baseline justify-between gap-4">
          <h3 className="text-foreground text-sm font-medium">Pace</h3>
          <span className="text-foreground-subtle text-xs tabular-nums">
            {preferences.pace.toFixed(2)}
          </span>
        </div>
        <p className="text-foreground-subtle mt-1 text-xs leading-relaxed">
          Higher is slower — this is the model&apos;s length scale, not a playback rate, so the
          words are re-spoken rather than stretched.
        </p>
        <input
          type="range"
          min={0.8}
          max={1.4}
          step={0.02}
          value={preferences.pace}
          onChange={(e) => onChange({ pace: Number(e.target.value) })}
          className="accent-primary mt-3 w-full"
          aria-label="Speaking pace"
        />
      </Surface>

      <Surface className="flex items-start gap-3 p-4">
        <Icons.Info className="text-foreground-subtle mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <h3 className="text-foreground text-sm font-medium">Listening isn&apos;t built</h3>
          <p className="text-foreground-subtle mt-1 text-xs leading-relaxed">
            Talking <em>to</em> Atlas is a separate question. Speech recognition in this engine
            wants a network round trip, which sits badly beside working with nothing connected —
            deferred rather than half-built.
          </p>
        </div>
      </Surface>
    </div>
  );
}
