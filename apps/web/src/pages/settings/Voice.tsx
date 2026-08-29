/**
 * Voice — what Atlas sounds like, and whether he can hear you.
 *
 * Both directions live on one tab because they are one idea to a person: "can
 * I talk to this thing." Underneath they are two engines and two different
 * kinds of consent, and the page keeps that visible — speaking is a
 * preference, listening is a permission, and they are switched on separately.
 *
 * ── Four controls, then a door ──────────────────────────────────────────────
 * The previous version of this page was correct and unreadable: eleven
 * surfaces, each with a switch and a paragraph, all at the same level. Every
 * paragraph was worth writing and none of them was worth reading on the way
 * to turning the voice on.
 *
 * So the four things anyone actually wants — on, which voice, how fast, how
 * loud — are visible, and everything that is a considered adjustment rather
 * than a first choice sits behind "Advanced". Nothing was removed; the
 * explanations moved to where they are read, which is next to the control
 * being explained, in one line, after the reader has already decided to care.
 *
 * ── Preview is still the whole design ───────────────────────────────────────
 * A voice cannot be chosen from a name. "Yorkshire" tells you almost nothing
 * about whether you want to listen to it for the next year, so every option
 * previews in place with one click and the list stays short enough to audition
 * end to end in under a minute. The male options are five different *regions*
 * rather than five shades of received pronunciation — options that sound
 * alike are not options.
 *
 * ── The microphone switch is the one that matters ───────────────────────────
 * Everything under it stays hidden until it is on. A column of greyed-out
 * microphone settings invites the reading that some of them might already be
 * doing something, and that is not a doubt worth leaving in someone's head.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Icons, Surface, Switch, cn } from '@atlas/ui';
import { DEFAULT_SPEECH } from '@atlas/core';
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
    { key: 'refined' as const, title: 'Refined', note: 'Fuller, a moment slower to start.' },
    { key: 'male' as const, title: 'British male', note: '' },
    { key: 'female' as const, title: 'British female', note: '' },
  ];

  /**
   * Which row to show as chosen, when the saved voice is not one that can be
   * spoken on this machine.
   *
   * A preference outlives the files it names: the refined voices are a
   * separate download, so a saved `kokoro-` id is perfectly normal on a
   * machine where that model has been removed or was never fetched. The
   * engine already handles this — an id it cannot speak falls back to the
   * piper default rather than failing — but the picker did not, and rendered
   * a list with *nothing* selected while Atlas talked away in a voice the
   * page never named. No selection reads as "no voice", which is the one
   * thing that is not happening.
   *
   * ⚠️ This mirrors the engine's fallback and must keep mirroring it: for any
   * id it cannot speak, `synthesize_speech` ends up at piper's `DEFAULT_VOICE`
   * — which is what `DEFAULT_SPEECH.voiceId` holds. Deliberately *not*
   * `voices[0]`: that is the first refined voice whenever the refined model is
   * installed, so it would point at a voice the engine is not using and make
   * the picker wrong in a new way rather than an old one.
   *
   * Display only. Storage is left exactly as it is, so re-fetching the model
   * with `pnpm voices` brings the original choice back rather than finding it
   * quietly overwritten with a substitute.
   */
  const speakable = voices.some((v) => v.id === preferences.voiceId);
  const effectiveVoiceId = speakable
    ? preferences.voiceId
    : (voices.find((v) => v.id === DEFAULT_SPEECH.voiceId)?.id ?? voices[0]?.id);

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <Surface className="border-warning/40 bg-warning/5 flex items-start gap-3 p-3.5">
          <Icons.Info className="text-warning mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0">
            <p className="text-foreground text-sm font-medium">That made no sound</p>
            <p className="text-foreground-subtle mt-0.5 break-words text-xs leading-relaxed">
              {error}
            </p>
          </div>
        </Surface>
      )}

      {/* ---- Speaking ---------------------------------------------------- */}
      <Section title="Speaking">
        {voices.length === 0 ? (
          <Unavailable
            icon={Icons.VolumeX}
            title="Speaking isn't available in this build"
            detail="A voice needs the speech engine, which ships with the desktop app."
          />
        ) : (
          <>
            <Row
              label="Speak replies"
              hint="Runs on this machine. Nothing is sent anywhere."
              control={
                <Switch
                  checked={preferences.enabled}
                  onCheckedChange={(enabled) => {
                    // Turning it off should also stop the sentence in the air.
                    if (!enabled) onStop();
                    onChange({ enabled });
                  }}
                  aria-label="Speak replies"
                />
              }
            />

            {preferences.enabled && (
              <>
                <Field label="Voice">
                  <Surface className="divide-border divide-y !p-0">
                    {groups.map((group) => {
                      const inGroup = voices.filter((v) => v.group === group.key);
                      if (!inGroup.length) return null;
                      return (
                        <div key={group.key}>
                          <div className="text-foreground-subtle flex items-baseline gap-2 px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide">
                            <span>{group.title}</span>
                            {group.note && (
                              <span className="normal-case tracking-normal">{group.note}</span>
                            )}
                          </div>
                          {inGroup.map((voice) => {
                            const selected = voice.id === effectiveVoiceId;
                            const playing = previewing === voice.id;
                            return (
                              <div key={voice.id} className="flex items-center gap-2 px-3 py-1.5">
                                <button
                                  type="button"
                                  onClick={() => onChange({ voiceId: voice.id })}
                                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                                  aria-pressed={selected}
                                >
                                  <span
                                    className={cn(
                                      'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border',
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
                                  className="text-foreground-subtle hover:text-foreground hover:bg-surface-raised duration-fast flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition"
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
                        </div>
                      );
                    })}
                  </Surface>
                </Field>

                <Slider
                  label="Speed"
                  value={preferences.pace}
                  display={paceLabel(preferences.pace)}
                  min={0.8}
                  max={1.4}
                  step={0.02}
                  onChange={(pace) => onChange({ pace })}
                  hint="Re-spoken at the new speed, not stretched."
                />

                <Slider
                  label="Volume"
                  value={preferences.volume}
                  display={`${Math.round(preferences.volume * 100)}%`}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={(volume) => onChange({ volume })}
                />
              </>
            )}
          </>
        )}
      </Section>

      {/* ---- Listening --------------------------------------------------- */}
      <Section title="Listening">
        {!listeningSupported ? (
          <Unavailable
            icon={Icons.MicOff}
            title="Listening isn't available in this build"
            detail="Hearing you needs the transcription engine, which ships with the desktop app."
          />
        ) : (
          <>
            <Row
              label="Use the microphone"
              hint="Transcribed here, like the voice. While this is off Atlas never opens it."
              control={
                <Switch
                  checked={listening.enabled}
                  onCheckedChange={(enabled) => onListeningChange({ enabled })}
                  aria-label="Use the microphone"
                />
              }
            />

            {listening.enabled && (
              <Advanced>
                <Row
                  label="Keep listening after an answer"
                  hint="Carry a conversation without pressing anything between turns."
                  control={
                    <Switch
                      checked={listening.handsFree}
                      onCheckedChange={(handsFree) => onListeningChange({ handsFree })}
                      aria-label="Keep listening after an answer"
                    />
                  }
                />
                <Row
                  label="Talking over Atlas stops him"
                  hint="Turn off if the room is loud enough that he keeps cutting himself off."
                  control={
                    <Switch
                      checked={listening.bargeIn}
                      onCheckedChange={(bargeIn) => onListeningChange({ bargeIn })}
                      aria-label="Talking over Atlas stops him"
                    />
                  }
                />
                <Slider
                  label="Pause before answering"
                  value={listening.silenceMs}
                  display={`${(listening.silenceMs / 1000).toFixed(1)}s`}
                  min={400}
                  max={2500}
                  step={100}
                  onChange={(silenceMs) => onListeningChange({ silenceMs })}
                  hint="How long a silence means you have finished talking."
                />
              </Advanced>
            )}
          </>
        )}
      </Section>
    </div>
  );
}

/**
 * The pace number, as a word.
 *
 * "1.06" is the model's length scale, which is a fact about the synthesiser
 * and not an answer to "how fast will it talk". The number stays available to
 * anyone dragging the slider, but the label is what it means.
 */
function paceLabel(pace: number): string {
  if (pace <= 0.9) return 'Faster';
  if (pace <= 1.02) return 'Brisk';
  if (pace < 1.14) return 'Natural';
  if (pace < 1.3) return 'Relaxed';
  return 'Slow';
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-foreground-subtle text-[11px] font-medium uppercase tracking-wide">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A label, one line of why, and a control. The page's basic unit. */
function Row({ label, hint, control }: { label: string; hint?: string; control: ReactNode }) {
  return (
    <Surface className="flex items-center justify-between gap-4 px-3.5 py-3">
      <div className="min-w-0">
        <p className="text-foreground text-sm font-medium">{label}</p>
        {hint && <p className="text-foreground-subtle mt-0.5 text-xs leading-relaxed">{hint}</p>}
      </div>
      <div className="shrink-0">{control}</div>
    </Surface>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-foreground-subtle px-0.5 text-xs font-medium">{label}</p>
      {children}
    </div>
  );
}

function Slider({
  label,
  value,
  display,
  min,
  max,
  step,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onChange(value: number): void;
  hint?: string;
}) {
  return (
    <Surface className="px-3.5 py-3">
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-foreground text-sm font-medium">{label}</p>
        <span className="text-foreground-subtle text-xs tabular-nums">{display}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="accent-primary mt-2 w-full"
        aria-label={label}
      />
      {hint && <p className="text-foreground-subtle mt-1 text-xs leading-relaxed">{hint}</p>}
    </Surface>
  );
}

/**
 * The door.
 *
 * Closed by default and remembered nowhere: these are settings someone
 * adjusts once, and reopening the page to find it as they left it would be
 * remembering the wrong thing.
 */
function Advanced({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="text-foreground-subtle hover:text-foreground duration-fast flex items-center gap-1.5 self-start rounded-md py-1 text-xs font-medium transition"
      >
        <Icons.ChevronRight
          className={cn('duration-fast h-3.5 w-3.5 transition-transform', open && 'rotate-90')}
        />
        Advanced
      </button>
      {open && <div className="flex flex-col gap-2">{children}</div>}
    </div>
  );
}

function Unavailable({
  icon: Icon,
  title,
  detail,
}: {
  icon: Icons.LucideIcon;
  title: string;
  detail: string;
}) {
  return (
    <Surface className="flex items-start gap-3 p-3.5">
      <Icon className="text-foreground-subtle mt-0.5 h-4 w-4 shrink-0" />
      <div>
        <p className="text-foreground text-sm font-medium">{title}</p>
        <p className="text-foreground-subtle mt-0.5 text-xs leading-relaxed">
          {detail} Everything else works without it.
        </p>
      </div>
    </Surface>
  );
}
