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

import { useCallback, useEffect, useState } from 'react';
import type { CapabilityName, Platform, Storage, VoiceProfile } from '@atlas/core';
import { readActiveProvider, readProviderKeys, readVoiceProfile } from '@atlas/data';
import type { ProviderKeyId } from '@atlas/data';
import { Icons, Spinner, cn } from '@atlas/ui';
import { TitleBar } from '../components/TitleBar';
import { Conversation } from '../pages/Conversation';
import { Settings } from '../pages/Settings';
import { useAtlas } from '../atlas/useAtlas';
import { ThemeToggle } from '../components/ThemeToggle';

type Screen = 'conversation' | 'settings';

interface Loaded {
  capabilities: CapabilityName[];
  voiceProfile: VoiceProfile;
  providerKeys: Partial<Record<ProviderKeyId, string>>;
  activeProviderId: string | null;
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
    ]).then(([capabilities, voiceProfile, providerKeys, activeProviderId]) => {
      if (alive)
        setLoaded({
          capabilities,
          voiceProfile,
          providerKeys,
          activeProviderId: activeProviderId ?? null,
        });
    });
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
      onVoiceProfileChange={reload}
      onProviderChange={reload}
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
  onVoiceProfileChange,
  onProviderChange,
}: {
  platform: Platform;
  storage: Storage;
  capabilities: CapabilityName[];
  voiceProfile: VoiceProfile;
  providerKeys: Partial<Record<ProviderKeyId, string>>;
  activeProviderId: string | null;
  onVoiceProfileChange: () => void;
  onProviderChange: () => void;
}) {
  const [screen, setScreen] = useState<Screen>('conversation');
  const [homeFading, setHomeFading] = useState(false);
  const atlas = useAtlas(
    platform,
    capabilities,
    storage,
    voiceProfile,
    providerKeys,
    activeProviderId,
  );

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
        {screen === 'conversation' ? (
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
