/**
 * The application root.
 *
 * Two screens and no router. React Router earned its place in a browsable
 * catalogue; in a single-window assistant it would add a URL bar's worth of
 * concepts to a program with two destinations, one of which you visit twice a
 * year.
 *
 * Capabilities are resolved once, asynchronously, before the engine is built —
 * because the engine's whole model of what it can do is decided at construction
 * from that list, and a skill set that changed underneath it mid-session would
 * be worse than a moment's wait.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CapabilityName,
  CloudProviderConfig,
  ExecutionMode,
  ListeningPreferences,
  Platform,
  SpeechPreferences,
  SpeechVoice,
  Storage,
  VoiceProfile,
} from '@atlas/core';
import {
  DEFAULT_EXECUTION_MODE,
  DEFAULT_HALT_SHORTCUT,
  DEFAULT_LISTENING,
  DEFAULT_SPEECH,
  nextExecutionMode,
} from '@atlas/core';
import {
  readActiveProvider,
  readCloudProviders,
  readCortexSettings,
  readExecutionMode,
  readListeningPreferences,
  readSpeechPreferences,
  readVoiceProfile,
  writeExecutionMode,
  writeListeningPreferences,
  writeSpeechPreferences,
} from '@atlas/data';
import type { CortexSettings } from '@atlas/data';
import { Icons, Spinner, cn } from '@atlas/ui';
import { TitleBar } from '../components/TitleBar';
import { Conversation } from '../pages/Conversation';
import { Settings } from '../pages/Settings';
import { VoiceScreen, type VoicePhase } from '../pages/VoiceScreen';
import { useAtlas } from '../atlas/useAtlas';
import { useSpeech } from '../speech/useSpeech';
import { useListening } from '../speech/useListening';
import { ThemeToggle } from '../components/ThemeToggle';

type Screen = 'conversation' | 'settings' | 'voice';

interface Loaded {
  capabilities: CapabilityName[];
  voiceProfile: VoiceProfile;
  cortex: CortexSettings;
  activeProviderId: string | null;
  cloudProviders: CloudProviderConfig[];
  speech: SpeechPreferences;
  speechVoices: SpeechVoice[];
  listening: ListeningPreferences;
  executionMode: ExecutionMode;
}

export function AtlasApp({ platform, storage }: { platform: Platform; storage: Storage }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  const reload = useCallback(() => {
    let alive = true;
    Promise.all([
      // A platform that can't answer is treated as one that can do nothing,
      // which degrades to a conversational Atlas rather than a broken one.
      platform.capabilities().catch(() => [] as CapabilityName[]),
      readVoiceProfile(storage).catch(() => ({}) as VoiceProfile),
      readCortexSettings(storage).catch(() => ({ enabled: false, baseUrl: '' })),
      readActiveProvider(storage).catch(() => undefined),
      readCloudProviders(storage).catch(() => [] as CloudProviderConfig[]),
      readSpeechPreferences(storage).catch(() => DEFAULT_SPEECH),
      // An empty list is the honest answer for a build without the engine;
      // the Voice tab renders that case rather than pretending otherwise.
      platform.speechVoices?.().catch(() => [] as SpeechVoice[]) ?? Promise.resolve([]),
      readListeningPreferences(storage).catch(() => DEFAULT_LISTENING),
      readExecutionMode(storage).catch(() => DEFAULT_EXECUTION_MODE),
    ]).then(
      ([
        capabilities,
        voiceProfile,
        cortex,
        activeProviderId,
        cloudProviders,
        speech,
        speechVoices,
        listening,
        executionMode,
      ]) => {
        if (alive)
          setLoaded({
            capabilities,
            voiceProfile,
            cortex,
            activeProviderId: activeProviderId ?? null,
            cloudProviders,
            speech,
            speechVoices,
            listening,
            executionMode,
          });
      },
    );
    return () => {
      alive = false;
    };
  }, [platform, storage]);

  useEffect(() => reload(), [reload]);

  if (!loaded) {
    return (
      <div className="bg-background grid h-full place-items-center">
        <Spinner />
      </div>
    );
  }

  return (
    <Ready
      platform={platform}
      storage={storage}
      capabilities={loaded.capabilities}
      voiceProfile={loaded.voiceProfile}
      cortex={loaded.cortex}
      activeProviderId={loaded.activeProviderId}
      cloudProviders={loaded.cloudProviders}
      speech={loaded.speech}
      speechVoices={loaded.speechVoices}
      listening={loaded.listening}
      executionMode={loaded.executionMode}
      onVoiceProfileChange={reload}
      onProviderChange={reload}
      onPreferencesSaved={reload}
    />
  );
}

function Ready({
  platform,
  storage,
  capabilities,
  voiceProfile,
  cortex,
  activeProviderId,
  cloudProviders,
  speech,
  speechVoices,
  listening: listeningPrefs,
  executionMode,
  onVoiceProfileChange,
  onProviderChange,
  onPreferencesSaved,
}: {
  platform: Platform;
  storage: Storage;
  capabilities: CapabilityName[];
  voiceProfile: VoiceProfile;
  cortex: CortexSettings;
  activeProviderId: string | null;
  cloudProviders: CloudProviderConfig[];
  speech: SpeechPreferences;
  speechVoices: SpeechVoice[];
  listening: ListeningPreferences;
  executionMode: ExecutionMode;
  onVoiceProfileChange: () => void;
  onProviderChange: () => void;
  onPreferencesSaved: () => void;
}) {
  // One player for the whole app: Settings previews through it, replies speak
  // through it, and the voice screen's visualiser reads its analyser.
  const voice = useSpeech(platform, speech.volume);
  const [screen, setScreen] = useState<Screen>('conversation');
  // Settings has no conversation of its own, so opening it has to remember
  // which one it is covering — a voice session and a chat are not the same
  // "back", and before this existed Settings always returned to chat, quietly
  // dropping whoever had opened it from the voice screen.
  const [returnTo, setReturnTo] = useState<'conversation' | 'voice'>('conversation');
  const [homeFading, setHomeFading] = useState(false);
  const [heard, setHeard] = useState<string | null>(null);
  const [dictated, setDictated] = useState<{ text: string; at: number } | null>(null);

  const inVoiceScreen = screen === 'voice';

  /**
   * Inside the voice screen Atlas always speaks, whatever the preference says.
   *
   * The preference means "read your answers aloud while I am reading them",
   * and it is off by default because unasked-for talking is startling. Neither
   * of those applies on a screen whose entire purpose is a spoken exchange —
   * a silent reply there is just a broken one.
   */
  const speechForScreen = useMemo(
    () => (inVoiceScreen ? { ...speech, enabled: true } : speech),
    [inVoiceScreen, speech],
  );

  const atlas = useAtlas(
    platform,
    capabilities,
    storage,
    voiceProfile,
    cortex,
    activeProviderId,
    cloudProviders,
    speechForScreen,
    voice.speak,
    executionMode,
    // A halt silences Atlas too. Talking on about a task that was just
    // emergency-stopped would read as not having stopped.
    voice.stop,
  );

  /**
   * The stop key as Windows has it registered, for the composer's hint and
   * button label. Re-read whenever Settings closes, since that is where it
   * changes.
   */
  const [stopKey, setStopKey] = useState<string | null>(null);
  useEffect(() => {
    if (!platform.halt) {
      setStopKey(DEFAULT_HALT_SHORTCUT);
      return;
    }
    if (screen === 'settings') return;
    let alive = true;
    void platform.halt
      .status()
      .then((status) => alive && setStopKey(status.shortcut.active))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [platform, screen]);

  /**
   * Keep the shell told whether there is anything to stop.
   *
   * The stop key is registered system-wide: while Atlas runs, that key is
   * swallowed in every application. A press with nothing in flight must
   * therefore be a no-op — `halt.rs` checks this before it latches — and the
   * shell cannot work out the answer on its own, because a plan mid-flight,
   * an open confirm card and a model being waited on are all renderer state.
   *
   * Speaking counts. A reply read aloud is Atlas still doing something to the
   * room, and the stop is what silences it.
   *
   * Reported on every change and, because the effect runs on mount, `false`
   * as soon as the window loads — so a reload during a run cannot leave the
   * shell believing Atlas is still busy.
   */
  const speaking = voice.state === 'speaking' || voice.state === 'loading';
  const working = atlas.busy || speaking;
  useEffect(() => {
    void platform.halt?.setWorking(working).catch(() => {});
  }, [platform, working]);

  /**
   * The browser build has no native key, so the default one works while the
   * page has focus. The desktop build must not listen here: Windows delivers
   * the registered key to the shell, and a second handler would halt twice.
   */
  const requestHalt = atlas.requestHalt;
  const workingRef = useRef(working);
  workingRef.current = working;
  useEffect(() => {
    if (platform.halt) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== DEFAULT_HALT_SHORTCUT) return;
      e.preventDefault();
      // Same rule the shell applies: nothing to stop, nothing happens. Read
      // from a ref so the listener isn't re-bound on every change of it.
      if (!workingRef.current) return;
      requestHalt();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [platform, requestHalt]);

  /**
   * Written and reloaded rather than mirrored in local state — same reasoning
   * as `onSpeechChange`: one source of truth for the setting.
   */
  const onExecutionModeChange = useCallback(
    (next: ExecutionMode) => {
      void writeExecutionMode(storage, next).then(onPreferencesSaved);
    },
    [storage, onPreferencesSaved],
  );

  const cycleExecutionMode = useCallback(
    () => onExecutionModeChange(nextExecutionMode(executionMode)),
    [onExecutionModeChange, executionMode],
  );

  /**
   * Extra vocabulary for the transcriber: the names of apps you actually have.
   *
   * Fetched the first time the microphone is wanted rather than at startup —
   * enumerating installed applications is not free, and an app that never
   * listens should never pay for it. Bounded because whisper's initial prompt
   * shares the model's context window with the audio; a hundred app names
   * would crowd out the sentence they were meant to help.
   */
  const [appHints, setAppHints] = useState('');
  const hintsRequested = useRef(false);
  const wantHints = useCallback(() => {
    if (hintsRequested.current || !platform.listApps) return;
    hintsRequested.current = true;
    void platform
      .listApps()
      .then((apps) => {
        let hint = '';
        for (const app of apps) {
          const next = hint ? `${hint}, ${app.name}` : app.name;
          if (next.length > 380) break;
          hint = next;
        }
        setAppHints(hint);
      })
      .catch(() => {
        // A missing app list costs accuracy on app names, nothing else.
      });
  }, [platform]);

  // Refs, because the recorder's callbacks outlive the render that created
  // them and must never act on a stale idea of what Atlas is doing.
  const speakingRef = useRef(false);
  speakingRef.current = voice.state === 'speaking' || voice.state === 'loading';
  const prefsRef = useRef(listeningPrefs);
  prefsRef.current = listeningPrefs;
  const screenRef = useRef(screen);
  screenRef.current = screen;

  const listening = useListening(platform, {
    silenceMs: listeningPrefs.silenceMs,
    hints: appHints,
    /**
     * Barge-in. This fires on the first loud frame, not on a finished
     * sentence, because the whole point is not waiting: an answer you have
     * already decided against should stop when you start talking over it, not
     * a second and a half later when the transcriber catches up.
     */
    onSpeechStart: () => {
      if (speakingRef.current && prefsRef.current.bargeIn) voice.stop();
    },
    onTranscript: (text) => {
      // Heard while Atlas was talking, with interruption switched off: that is
      // his own voice leaking past the echo canceller, or the room. Either
      // way it is not a question.
      if (speakingRef.current && !prefsRef.current.bargeIn) return;

      if (screenRef.current === 'voice') {
        setHeard(text);
        atlas.ask(text);
        // One turn at a time when hands-free is off: the microphone closes and
        // waits to be asked again.
        if (!prefsRef.current.handsFree) listening.stop();
        return;
      }

      // Dictation from the composer: the words land in the box for you to look
      // at before they are sent. A transcriber that acts on what it *thinks*
      // it heard is a transcriber that eventually deletes something.
      setDictated({ text, at: Date.now() });
      listening.stop();
    },
  });

  // While Atlas talks the speech gate is raised rather than the microphone
  // closed, so barge-in can still hear you over him.
  useEffect(() => {
    listening.setDucked(voice.state === 'speaking');
  }, [voice.state, listening]);

  /** The one status the voice screen shows, derived rather than tracked. */
  const phase: VoicePhase = listening.transcribing
    ? 'transcribing'
    : voice.state === 'speaking' || voice.state === 'loading'
      ? 'speaking'
      : atlas.busy
        ? 'thinking'
        : listening.state === 'hearing'
          ? 'hearing'
          : listening.state === 'waiting'
            ? 'listening'
            : 'off';

  /**
   * The amplitude the visualiser draws, from whichever side is making sound.
   *
   * One function rather than two, because the screen shows one circle: whose
   * voice it is belongs to the label, not to the geometry.
   */
  const voiceLevel = useCallback(
    () => (speakingRef.current ? voice.level() : listening.level()),
    [voice, listening],
  );

  /** The spectrum the orb draws, from whichever side is making sound. */
  const voiceBands = useCallback(
    (out: Float32Array) => (speakingRef.current ? voice.bands(out) : listening.bands(out)),
    [voice, listening],
  );

  /**
   * Ask, having first opened the audio device.
   *
   * Sending a message is a gesture, and if replies are being read aloud it is
   * the gesture immediately before speech. Priming here means the device-open
   * cost is paid while the answer is still being worked out, instead of after
   * it — where it would be pure added silence. Costs nothing when the device
   * is already open, and nothing at all when Atlas is not going to speak.
   */
  const askAloud = useCallback(
    (text: string) => {
      if (speechForScreen.enabled) voice.prime();
      atlas.ask(text);
    },
    [atlas, voice, speechForScreen.enabled],
  );

  /** The last thing Atlas actually said, for the screen to show in text. */
  const lastReply = useMemo(() => {
    for (let i = atlas.entries.length - 1; i >= 0; i--) {
      const entry = atlas.entries[i];
      if (entry?.kind === 'atlas' && entry.text) return entry.text;
    }
    return null;
  }, [atlas.entries]);

  const onListeningChange = useCallback(
    (next: Partial<ListeningPreferences>) => {
      void writeListeningPreferences(storage, next).then(onPreferencesSaved);
    },
    [storage, onPreferencesSaved],
  );

  const toggleMic = useCallback(() => {
    wantHints();
    if (listening.state === 'idle') void listening.start();
    else listening.stop();
  }, [listening, wantHints]);

  /**
   * Changing screens closes the microphone.
   *
   * Not politeness — it is the promise the voice screen makes. The device has
   * to close when you leave, including when you leave because the logo was
   * clicked or the window was summoned back to the conversation.
   *
   * ⚠️ Keyed on `screen` alone, and that is the entire fix for a bug worth
   * remembering. This was written as "if the screen isn't `voice` and the mic
   * is open, close it", which re-ran every time the listening state changed —
   * so pressing the composer's dictation button opened the microphone, changed
   * the state, re-ran this, and closed it again in the same breath. The button
   * did nothing, visibly and repeatably, while every part of it worked.
   */
  const stopListening = listening.stop;
  useEffect(() => () => stopListening(), [screen, stopListening]);

  /**
   * A settings change is written and then reloaded rather than mirrored in
   * local state. One source of truth for a preference — the stored file —
   * means the Voice tab and the code that actually speaks can never disagree
   * about which voice is selected, which is exactly the bug a local copy
   * invites.
   */
  const onSpeechChange = useCallback(
    (next: Partial<SpeechPreferences>) => {
      void writeSpeechPreferences(storage, next).then(onPreferencesSaved);
    },
    [storage, onPreferencesSaved],
  );

  /**
   * Preview speaks in the voice being *auditioned*, not the saved one —
   * demonstrating the wrong voice is the one thing this button must never do.
   * It uses the current pace, so a preview is what you will actually hear.
   */
  const onSpeechPreview = useCallback(
    (voiceId: string) => {
      voice.stop();
      void voice.speak('Good evening. All systems are online.', {
        voiceId,
        pace: speech.pace,
      });
    },
    [voice, speech.pace],
  );

  const onSpeechStop = useCallback(() => voice.stop(), [voice]);

  // Clicking the logo is "go home," the way it is on a website — back to the
  // welcome screen, not just back to the conversation tab. An instant swap
  // would feel like a glitch; fading out, swapping, then fading back in
  // reads as a deliberate transition. Matches `--duration-base` (see
  // packages/tokens) rather than a one-off value, and — since that token
  // collapses to 0ms under prefers-reduced-motion — the fade already
  // respects it for free.
  /**
   * Clearing the conversation stops Atlas talking about it.
   *
   * Wiping the transcript while the voice carries on reading a message that
   * is no longer on screen is a small thing that makes the app feel like two
   * programs sharing a window.
   */
  const clearConversation = useCallback(() => {
    voice.stop();
    atlas.clear();
  }, [voice, atlas]);

  const openSettings = useCallback(() => {
    setReturnTo(screen === 'voice' ? 'voice' : 'conversation');
    setScreen('settings');
  }, [screen]);

  const closeSettings = useCallback(() => {
    setScreen(returnTo);
  }, [returnTo]);

  const goHome = useCallback(() => {
    if (screen === 'conversation' && atlas.entries.length === 0) return; // already home
    voice.stop();
    setHomeFading(true);
    window.setTimeout(() => {
      setScreen('conversation');
      atlas.clear();
      setHomeFading(false);
    }, 200);
  }, [screen, atlas, voice]);

  // The desktop shell emits this when the global shortcut summons the window.
  // Returning to the conversation is almost always what someone who just hit
  // Ctrl+Space wants, whatever screen they left it on.
  useEffect(() => {
    if (platform.id !== 'tauri') return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen('atlas://summoned', () => setScreen('conversation'));
    })();
    return () => unlisten?.();
  }, [platform.id]);

  /**
   * F11 toggles fullscreen — nothing did before this.
   *
   * `decorations: false` (see `TitleBar`'s doc comment) buys app-drawn chrome
   * but gives up everything the OS used to wire up for free, and this key was
   * one of them: a decorated window gets it from the shell, a borderless one
   * gets nothing unless something asks for it. `getCurrentWindow` already
   * exposes exactly the pair needed (`isFullscreen`/`setFullscreen`) — the
   * same module `TitleBar`'s own maximise button already imports — so this is
   * wiring, not a new capability.
   *
   * A plain `window` listener rather than a Tauri event: no Rust side needs
   * to know this happened, and every other keyboard shortcut in this app
   * (Shift+Tab, Escape) is handled the same way, in the renderer.
   */
  useEffect(() => {
    if (platform.id !== 'tauri') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'F11') return;
      e.preventDefault();
      void (async () => {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        const fullscreen = await win.isFullscreen();
        await win.setFullscreen(!fullscreen);
      })();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [platform.id]);

  return (
    <div className="bg-background text-foreground flex h-full flex-col">
      <TitleBar
        onLogoClick={goHome}
        back={
          screen === 'settings'
            ? {
                label: returnTo === 'voice' ? 'Back to voice' : 'Back to your conversation',
                onClick: closeSettings,
              }
            : undefined
        }
        right={
          <>
            <ThemeToggle />
            {atlas.entries.length > 0 && screen === 'conversation' && (
              <ChromeButton label="Clear conversation" onClick={clearConversation}>
                <Icons.Trash2 className="h-3.5 w-3.5" />
              </ChromeButton>
            )}
            {/*
              Speech has a switch where it can be reached, not only three
              screens deep in Settings. Two jobs in one control on purpose:
              while Atlas is talking it stops him mid-sentence, and otherwise
              it turns speaking off altogether. Wanting one almost always
              means wanting the other, and a separate "stop" button that only
              appears while a voice is playing is a target that moves.
            */}
            {speechVoices.length > 0 && (
              <ChromeButton
                label={
                  voice.state === 'speaking'
                    ? 'Stop talking'
                    : speech.enabled
                      ? 'Turn off speaking'
                      : 'Read replies aloud'
                }
                active={speech.enabled}
                onClick={() => {
                  if (voice.state === 'speaking' || voice.state === 'loading') {
                    voice.stop();
                    // Pressing it mid-sentence means "be quiet now", not
                    // "never speak again" — the preference is left alone.
                    return;
                  }
                  onSpeechChange({ enabled: !speech.enabled });
                }}
              >
                {speech.enabled ? (
                  <Icons.Volume2 className="h-3.5 w-3.5" />
                ) : (
                  <Icons.VolumeX className="h-3.5 w-3.5" />
                )}
              </ChromeButton>
            )}
            {/* Listening is a place, so it gets a door in the chrome next to
                Settings rather than a control in the composer. The button is
                absent — not disabled — in a build that cannot listen or with
                the microphone switched off in Settings: an affordance that
                explains why it does nothing is still an affordance that does
                nothing. */}
            {listening.supported && listeningPrefs.enabled && (
              <ChromeButton
                label={screen === 'voice' ? 'Back to Atlas' : 'Talk to Atlas'}
                active={screen === 'voice'}
                onClick={() => {
                  // Opening the voice screen is a gesture, and it is followed
                  // within seconds by speech. Both costs that would otherwise
                  // land in front of the first sentence are paid here instead:
                  // opening the audio device, and loading the voice model.
                  voice.prime();
                  // Deliberately not awaited and deliberately not surfaced. A
                  // warm-up that fails costs a slower first sentence and
                  // nothing else, and a screen that refused to open because a
                  // model could not be preloaded would be far worse than one
                  // that is briefly slow.
                  void platform.warmSpeech?.().catch(() => {});
                  setScreen(screen === 'voice' ? 'conversation' : 'voice');
                }}
              >
                <Icons.AudioLines className="h-3.5 w-3.5" />
              </ChromeButton>
            )}
            <ChromeButton
              label={screen === 'settings' ? 'Back to Atlas' : 'Settings'}
              active={screen === 'settings'}
              spin
              onClick={() => (screen === 'settings' ? closeSettings() : openSettings())}
            >
              <Icons.Settings className="h-3.5 w-3.5" />
            </ChromeButton>
          </>
        }
      />

      <div
        className={cn(
          'duration-base flex min-h-0 flex-1 flex-col transition-opacity',
          homeFading && 'opacity-0',
        )}
      >
        {screen === 'voice' ? (
          <VoiceScreen
            phase={phase}
            level={voiceLevel}
            bands={voiceBands}
            heard={heard}
            reply={lastReply}
            greeting={atlas.greeting}
            handsFree={listeningPrefs.handsFree}
            error={listening.error}
            onToggle={toggleMic}
            onClose={() => setScreen('conversation')}
          />
        ) : screen === 'conversation' ? (
          <Conversation
            entries={atlas.entries}
            busy={atlas.busy}
            awaitingAnswer={atlas.awaitingAnswer}
            memory={atlas.memory}
            greeting={atlas.greeting}
            atlasName={atlas.atlasName}
            onAsk={askAloud}
            onRunAction={atlas.runAction}
            onAnswerConfirm={atlas.answerConfirm}
            onCopy={atlas.copy}
            onAskAgain={askAloud}
            executionMode={executionMode}
            onCycleExecutionMode={cycleExecutionMode}
            dictation={
              listening.supported && listeningPrefs.enabled
                ? {
                    active: listening.state !== 'idle',
                    transcribing: listening.transcribing,
                    onToggle: toggleMic,
                  }
                : undefined
            }
            dictated={dictated}
            onStop={atlas.requestHalt}
            stopKey={stopKey}
            halted={atlas.halt !== null}
            onResume={() => void atlas.resume()}
          />
        ) : (
          <Settings
            platform={platform}
            storage={storage}
            capabilities={capabilities}
            skills={atlas.skills}
            memory={atlas.memory}
            executionMode={executionMode}
            onExecutionModeChange={onExecutionModeChange}
            voiceProfile={voiceProfile}
            onVoiceProfileChange={onVoiceProfileChange}
            cortex={cortex}
            activeProviderId={activeProviderId}
            cloudProviders={cloudProviders}
            onProviderChange={onProviderChange}
            speech={speech}
            speechVoices={speechVoices}
            onSpeechChange={onSpeechChange}
            onSpeechPreview={onSpeechPreview}
            onSpeechStop={onSpeechStop}
            speechError={voice.lastError}
            listening={listeningPrefs}
            listeningSupported={listening.supported}
            onListeningChange={onListeningChange}
          />
        )}
      </div>
    </div>
  );
}

function ChromeButton({
  children,
  label,
  onClick,
  active,
  spin,
}: {
  children: React.ReactNode;
  label: string;
  onClick(): void;
  active?: boolean;
  /** Turn the glyph a full revolution on each press (the gear). */
  spin?: boolean;
}) {
  // Counting presses rather than toggling a class is what lets the third press
  // spin as far as the first: the transform target keeps moving, so there is
  // never a state to animate *back* from mid-turn.
  const [turns, setTurns] = useState(0);

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        if (spin) setTurns((t) => t + 1);
        onClick();
      }}
      className={cn(
        'duration-fast grid h-7 w-7 place-items-center rounded-md transition',
        active
          ? 'bg-surface-raised text-foreground'
          : 'text-foreground-subtle hover:bg-surface hover:text-foreground',
      )}
    >
      {spin ? (
        // The rotation lives on an inner span so it composes with the button's
        // own colour transition instead of fighting it. The duration is a
        // token, so reduced-motion users get the state change with no spin.
        <span
          className="duration-slow grid place-items-center transition-transform ease-out"
          style={{ transform: `rotate(${turns * 360}deg)` }}
        >
          {children}
        </span>
      ) : (
        children
      )}
    </button>
  );
}
