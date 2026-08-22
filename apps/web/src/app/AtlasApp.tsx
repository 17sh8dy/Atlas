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
  ListeningPreferences,
  Platform,
  SpeechPreferences,
  SpeechVoice,
  Storage,
  VoicePreferences,
  VoiceProfile,
} from '@atlas/core';
import { DEFAULT_LISTENING, DEFAULT_SPEECH, DEFAULT_VOICE_SERVICE } from '@atlas/core';
import {
  readActiveProvider,
  readListeningPreferences,
  readProviderKeys,
  readSpeechPreferences,
  readVoicePreferences,
  readVoiceProfile,
  writeListeningPreferences,
  writeSpeechPreferences,
  writeVoicePreferences,
} from '@atlas/data';
import type { ProviderKeyId } from '@atlas/data';
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
  providerKeys: Partial<Record<ProviderKeyId, string>>;
  activeProviderId: string | null;
  speech: SpeechPreferences;
  speechVoices: SpeechVoice[];
  listening: ListeningPreferences;
  voiceService: VoicePreferences;
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
      readProviderKeys(storage).catch(() => ({}) as Partial<Record<ProviderKeyId, string>>),
      readActiveProvider(storage).catch(() => undefined),
      readSpeechPreferences(storage).catch(() => DEFAULT_SPEECH),
      // An empty list is the honest answer for a build without the engine;
      // the Voice tab renders that case rather than pretending otherwise.
      platform.speechVoices?.().catch(() => [] as SpeechVoice[]) ?? Promise.resolve([]),
      readListeningPreferences(storage).catch(() => DEFAULT_LISTENING),
      readVoicePreferences(storage).catch(() => DEFAULT_VOICE_SERVICE),
    ]).then(
      ([
        capabilities,
        voiceProfile,
        providerKeys,
        activeProviderId,
        speech,
        speechVoices,
        listening,
        voiceService,
      ]) => {
        if (alive)
          setLoaded({
            capabilities,
            voiceProfile,
            providerKeys,
            activeProviderId: activeProviderId ?? null,
            speech,
            speechVoices,
            listening,
            voiceService,
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
      providerKeys={loaded.providerKeys}
      activeProviderId={loaded.activeProviderId}
      speech={loaded.speech}
      speechVoices={loaded.speechVoices}
      listening={loaded.listening}
      voiceService={loaded.voiceService}
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
  providerKeys,
  activeProviderId,
  speech,
  speechVoices,
  listening: listeningPrefs,
  voiceService,
  onVoiceProfileChange,
  onProviderChange,
  onPreferencesSaved,
}: {
  platform: Platform;
  storage: Storage;
  capabilities: CapabilityName[];
  voiceProfile: VoiceProfile;
  providerKeys: Partial<Record<ProviderKeyId, string>>;
  activeProviderId: string | null;
  speech: SpeechPreferences;
  speechVoices: SpeechVoice[];
  listening: ListeningPreferences;
  voiceService: VoicePreferences;
  onVoiceProfileChange: () => void;
  onProviderChange: () => void;
  onPreferencesSaved: () => void;
}) {
  // One player for the whole app: Settings previews through it, replies speak
  // through it, and the voice screen's visualiser reads its analyser.
  /**
   * Where voice work happens. Two independent conditions, both required, so
   * neither a switch left on nor a key left saved can send audio on its own.
   */
  const route = useMemo(
    () => ({ online: voiceService.online, apiKey: providerKeys.openai ?? null }),
    [voiceService.online, providerKeys.openai],
  );

  const voice = useSpeech(platform, route);
  const [screen, setScreen] = useState<Screen>('conversation');
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
    providerKeys,
    activeProviderId,
    speechForScreen,
    voice.speak,
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
    route,
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

  /** The last thing Atlas actually said, for the screen to show in text. */
  const lastReply = useMemo(() => {
    for (let i = atlas.entries.length - 1; i >= 0; i--) {
      const entry = atlas.entries[i];
      if (entry?.kind === 'atlas' && entry.text) return entry.text;
    }
    return null;
  }, [atlas.entries]);

  const onVoiceServiceChange = useCallback(
    (next: Partial<VoicePreferences>) => {
      void writeVoicePreferences(storage, next).then(onPreferencesSaved);
    },
    [storage, onPreferencesSaved],
  );

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
  const goHome = useCallback(() => {
    if (screen === 'conversation' && atlas.entries.length === 0) return; // already home
    setHomeFading(true);
    window.setTimeout(() => {
      setScreen('conversation');
      atlas.clear();
      setHomeFading(false);
    }, 200);
  }, [screen, atlas]);

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

  return (
    <div className="bg-background text-foreground flex h-full flex-col">
      <TitleBar
        onLogoClick={goHome}
        right={
          <>
            <ThemeToggle />
            {atlas.entries.length > 0 && screen === 'conversation' && (
              <ChromeButton label="Clear conversation" onClick={atlas.clear}>
                <Icons.Trash2 className="h-3.5 w-3.5" />
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
                onClick={() => setScreen(screen === 'voice' ? 'conversation' : 'voice')}
              >
                <Icons.AudioLines className="h-3.5 w-3.5" />
              </ChromeButton>
            )}
            <ChromeButton
              label={screen === 'settings' ? 'Back to Atlas' : 'Settings'}
              active={screen === 'settings'}
              spin
              onClick={() => setScreen(screen === 'settings' ? 'conversation' : 'settings')}
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
            handsFree={listeningPrefs.handsFree}
            error={listening.error}
            onToggle={toggleMic}
            onClose={() => setScreen('conversation')}
          />
        ) : screen === 'conversation' ? (
          <Conversation
            entries={atlas.entries}
            busy={atlas.busy}
            skills={atlas.skills}
            greeting={atlas.greeting}
            personalized={atlas.personalized}
            atlasName={atlas.atlasName}
            onAsk={atlas.ask}
            onRunAction={atlas.runAction}
            onAnswerConfirm={atlas.answerConfirm}
            onCopy={atlas.copy}
            onAskAgain={atlas.ask}
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
          />
        ) : (
          <Settings
            platform={platform}
            storage={storage}
            capabilities={capabilities}
            skills={atlas.skills}
            voiceProfile={voiceProfile}
            onVoiceProfileChange={onVoiceProfileChange}
            providerKeys={providerKeys}
            activeProviderId={activeProviderId}
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
            voiceService={voiceService}
            hasVoiceKey={Boolean(providerKeys.openai)}
            onVoiceServiceChange={onVoiceServiceChange}
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
