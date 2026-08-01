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

import { useEffect, useState } from 'react';
import type { CapabilityName, Platform } from '@atlas/core';
import { Icons, Spinner, cn } from '@atlas/ui';
import { TitleBar } from '../components/TitleBar';
import { Conversation } from '../pages/Conversation';
import { Settings } from '../pages/Settings';
import { useAtlas } from '../atlas/useAtlas';
import { ThemeToggle } from '../components/ThemeToggle';

type Screen = 'conversation' | 'settings';

export function AtlasApp({ platform }: { platform: Platform }) {
  const [capabilities, setCapabilities] = useState<CapabilityName[] | null>(null);

  useEffect(() => {
    let alive = true;
    platform
      .capabilities()
      .then((caps) => alive && setCapabilities(caps))
      // A platform that can't answer is treated as one that can do nothing,
      // which degrades to a conversational Atlas rather than a broken one.
      .catch(() => alive && setCapabilities([]));
    return () => {
      alive = false;
    };
  }, [platform]);

  if (!capabilities) {
    return (
      <div className="grid h-full place-items-center bg-background">
        <Spinner />
      </div>
    );
  }

  return <Ready platform={platform} capabilities={capabilities} />;
}

function Ready({
  platform,
  capabilities,
}: {
  platform: Platform;
  capabilities: CapabilityName[];
}) {
  const [screen, setScreen] = useState<Screen>('conversation');
  const atlas = useAtlas(platform, capabilities);

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
    <div className="flex h-full flex-col bg-background text-foreground">
      <TitleBar
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
              onClick={() => setScreen(screen === 'settings' ? 'conversation' : 'settings')}
            >
              <Icons.Settings className="h-3.5 w-3.5" />
            </ChromeButton>
          </>
        }
      />

      {screen === 'conversation' ? (
        <Conversation
          entries={atlas.entries}
          busy={atlas.busy}
          skills={atlas.skills}
          onAsk={atlas.ask}
          onRunAction={atlas.runAction}
          onAnswerConfirm={atlas.answerConfirm}
        />
      ) : (
        <Settings platform={platform} capabilities={capabilities} skills={atlas.skills} />
      )}
    </div>
  );
}

function ChromeButton({
  children,
  label,
  onClick,
  active,
}: {
  children: React.ReactNode;
  label: string;
  onClick(): void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'grid h-7 w-7 place-items-center rounded-md transition duration-fast',
        active
          ? 'bg-surface-raised text-foreground'
          : 'text-foreground-subtle hover:bg-surface hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}
