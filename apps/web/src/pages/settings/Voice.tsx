/**
 * Voice — what Atlas sounds like, and whether he can hear you.
 *
 * Both directions live on one tab because they are one idea to a person: "can
 * I talk to this thing." Underneath they are two engines and two different
 * kinds of consent, and the page keeps that visible — speaking is a
 * preference, listening is a permission, and they are switched on separately.
 *
 * ── Preview is the whole design ─────────────────────────────────────────────
 * A voice cannot be chosen from a name. "Yorkshire" tells you almost nothing
 * about whether you want to listen to it for the next year, so every option
 * previews in place with one click and the list stays short enough to audition
 * end to end in under a minute. The five male options are five different
 * *regions* rather than five shades of received pronunciation — options that
 * sound alike are not options.
 *
 * ── The microphone switch is the one that matters ───────────────────────────
 * Everything under it stays hidden until it is on. A column of greyed-out
 * microphone settings invites the reading that some of them might already be
 * doing something, and that is not a doubt worth leaving in someone's head.
 */

import { useCallback, useEffect, useState } from 'react';
import { Icons, Surface, Switch, cn } from '@atlas/ui';
import type { ListeningPreferences, SpeechPreferences, SpeechVoice } from '@atlas/core';

interface Props {
  /** Empty when this build has no speech engine. */
  voices: SpeechVoice[];
  preferences: SpeechPreferences;
  onChange(next: Partial<SpeechPreferences>): void;
  onPreview(voiceId: string): void;
  onStop(): void;
  /** Why the last attempt made no sound. Shown rather than swallowed. */
  error: string | null;
  listening: ListeningPreferences;
  /** False in a build without the transcription engine. */
  listeningSupported: boolean;
  onListeningChange(next: Partial<ListeningPreferences>): void;
}

export function Voice({
  voices,
  preferences,
  onChange,
  onPreview,
  onStop,
  error,
  listening,
  listeningSupported,
  onListeningChange,
}: Props) {
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

  // Refined first, because it is the better answer when it is installed, and a
  // list's order is a recommendation whether or not it is meant as one. The
  // group renders nothing at all when the model is absent — `speech_voices`
  // simply does not return them — so this is never a row of dead options.
  const groups = [
    {
      key: 'refined' as const,
      title: 'Refined',
      // Says what the difference is in terms of what you would *hear*. "A
      // larger neural model" is true and useless; the reason to pick one of
      // these is that it reads a sentence rather than a row of words.
      note: 'A larger voice that carries a whole sentence, not just its words. A moment slower to start.',
    },
    {
      key: 'male' as const,
      title: 'British male',
      note: 'Five regions, not five takes on the same accent.',
    },
    { key: 'female' as const, title: 'British female', note: '' },
  ];

  return (
    <div className="flex flex-col gap-5">
      {error && (
        <Surface className="border-warning/40 bg-warning/5 flex items-start gap-3 p-4">
          <Icons.Info className="text-warning mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0">
            <h2 className="text-foreground text-sm font-medium">That made no sound</h2>
            <p className="text-foreground-subtle mt-1 break-words text-xs leading-relaxed">
              {error}
            </p>
          </div>
        </Surface>
      )}

      {voices.length === 0 ? (
        <Surface className="flex items-start gap-3 p-4">
          <Icons.VolumeX className="text-foreground-subtle mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <h2 className="text-foreground text-sm font-medium">
              Speaking isn&apos;t available in this build
            </h2>
            <p className="text-foreground-subtle mt-1 text-xs leading-relaxed">
              A voice needs the speech engine, which ships with the desktop app. Everything else
              works without it.
            </p>
          </div>
        </Surface>
      ) : (
        <>
          <Surface className="flex items-start justify-between gap-4 p-4">
            <div className="min-w-0">
              <h2 className="text-foreground text-sm font-medium">Speak replies</h2>
              <p className="text-foreground-subtle mt-1 text-xs leading-relaxed">
                Atlas reads his answers aloud. Synthesis runs on this machine — nothing is sent
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
                  {group.note && (
                    <p className="text-foreground-subtle mt-0.5 text-xs">{group.note}</p>
                  )}
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
        </>
      )}

      <Listening
        supported={listeningSupported}
        preferences={listening}
        onChange={onListeningChange}
      />
    </div>
  );
}

/** Talking to Atlas. */
function Listening({
  supported,
  preferences,
  onChange,
}: {
  supported: boolean;
  preferences: ListeningPreferences;
  onChange(next: Partial<ListeningPreferences>): void;
}) {
  if (!supported) {
    return (
      <Surface className="flex items-start gap-3 p-4">
        <Icons.MicOff className="text-foreground-subtle mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <h3 className="text-foreground text-sm font-medium">
            Listening isn&apos;t available in this build
          </h3>
          <p className="text-foreground-subtle mt-1 text-xs leading-relaxed">
            Hearing you needs the transcription engine, which ships with the desktop app. Everything
            else works without it.
          </p>
        </div>
      </Surface>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-foreground text-xs font-medium">Listening</h3>

      <Surface className="flex items-start justify-between gap-4 p-4">
        <div className="min-w-0">
          <h2 className="text-foreground text-sm font-medium">Let Atlas use the microphone</h2>
          <p className="text-foreground-subtle mt-1 text-xs leading-relaxed">
            Transcription runs on this machine, like the voice does — nothing you say is sent
            anywhere. While this is off Atlas never opens the microphone for any reason, and the
            button for talking to him is not there at all.
          </p>
        </div>
        <Switch
          checked={preferences.enabled}
          onCheckedChange={(enabled) => onChange({ enabled })}
          aria-label="Let Atlas use the microphone"
        />
      </Surface>

      {preferences.enabled && (
        <>
          <Surface className="flex items-start justify-between gap-4 p-4">
            <div className="min-w-0">
              <h2 className="text-foreground text-sm font-medium">
                Keep listening after an answer
              </h2>
              <p className="text-foreground-subtle mt-1 text-xs leading-relaxed">
                On the talking screen, carry a conversation without pressing anything between turns.
                Off, each turn starts with a press.
              </p>
            </div>
            <Switch
              checked={preferences.handsFree}
              onCheckedChange={(handsFree) => onChange({ handsFree })}
              aria-label="Keep listening after an answer"
            />
          </Surface>

          <Surface className="flex items-start justify-between gap-4 p-4">
            <div className="min-w-0">
              <h2 className="text-foreground text-sm font-medium">Talking over Atlas stops him</h2>
              <p className="text-foreground-subtle mt-1 text-xs leading-relaxed">
                Waiting out an answer you have already decided against is the worst part of talking
                to a machine. Turn this off if the room is loud enough that he keeps cutting himself
                off.
              </p>
            </div>
            <Switch
              checked={preferences.bargeIn}
              onCheckedChange={(bargeIn) => onChange({ bargeIn })}
              aria-label="Talking over Atlas stops him"
            />
          </Surface>

          <Surface className="p-4">
            <div className="flex items-baseline justify-between gap-4">
              <h3 className="text-foreground text-sm font-medium">Pause before answering</h3>
              <span className="text-foreground-subtle text-xs tabular-nums">
                {(preferences.silenceMs / 1000).toFixed(1)}s
              </span>
            </div>
            <p className="text-foreground-subtle mt-1 text-xs leading-relaxed">
              How long a silence means you have finished talking. Short and it cuts you off
              mid-thought; long and every sentence ends with a wait.
            </p>
            <input
              type="range"
              min={400}
              max={2500}
              step={100}
              value={preferences.silenceMs}
              onChange={(e) => onChange({ silenceMs: Number(e.target.value) })}
              className="accent-primary mt-3 w-full"
              aria-label="Pause before answering"
            />
          </Surface>
        </>
      )}
    </div>
  );
}
