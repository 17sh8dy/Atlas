/**
 * Background — whether Atlas starts with Windows, what closing the window does, when it keeps quiet, and
 * whether anything starts listening by itself.
 *
 * Every control here makes Atlas more deliberate or quieter, except the two that are plainly named opt-ins
 * ("Start with Windows", "Speak reminders aloud"); all of them default to what Atlas has always done. The
 * start-with-Windows switch shows what Windows ACTUALLY holds (the platform reads the registry back after it
 * writes), so if it says on, it is on.
 */

import { useCallback, useEffect, useState } from 'react';
import type {
  Platform,
  PresenceMode,
  PresencePreferences,
  StartupStatus,
  Storage,
} from '@atlas/core';
import { DEFAULT_PRESENCE } from '@atlas/core';
import { readPresencePreferences, writePresencePreferences } from '@atlas/data';
import { SegmentedControl, Switch } from '@atlas/ui';
import { announcePresenceChanged } from '../../../atlas/presence';

interface Props {
  platform: Platform;
  storage: Storage;
}

const MODES: ReadonlyArray<{ value: PresenceMode; label: string }> = [
  { value: 'active', label: 'Normal' },
  { value: 'quiet', label: 'Quiet' },
  { value: 'privacy', label: 'Privacy' },
];

const MODE_HINT: Record<PresenceMode, string> = {
  active: 'Atlas behaves as configured.',
  quiet:
    'No spoken reminders and no chimes of its own. Alarms you set still sound, and notifications still appear.',
  privacy:
    'Quiet, and nothing starts listening by itself (no double clap). The microphone button still works when you press it.',
};

export function Background({ platform, storage }: Props) {
  const [prefs, setPrefs] = useState<PresencePreferences>(DEFAULT_PRESENCE);
  const [startup, setStartup] = useState<StartupStatus | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);

  useEffect(() => {
    void readPresencePreferences(storage)
      .then(setPrefs)
      .catch(() => {});
    void platform
      .startupStatus?.()
      .then(setStartup)
      .catch(() => {});
  }, [storage, platform]);

  const save = useCallback(
    (next: Parameters<typeof writePresencePreferences>[1]) => {
      void writePresencePreferences(storage, next)
        .then(() => readPresencePreferences(storage))
        .then((fresh) => {
          setPrefs(fresh);
          announcePresenceChanged();
        });
    },
    [storage],
  );

  const toggleStartup = useCallback(
    (enabled: boolean) => {
      setStartupError(null);
      platform.setStartup?.(enabled).then(setStartup, (e: unknown) => {
        setStartupError(e instanceof Error ? e.message : String(e));
        void platform
          .startupStatus?.()
          .then(setStartup)
          .catch(() => {});
      });
    },
    [platform],
  );

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-foreground text-sm font-medium">Background</h2>
        <p className="text-foreground-subtle mt-1 text-xs leading-relaxed">
          Atlas stays in the tray when its window is closed, and Ctrl+Space brings it back.
        </p>
      </div>

      {platform.setStartup && (
        <Row
          label="Start with Windows"
          hint={
            startup?.pointsElsewhere
              ? 'Windows is set to start a different copy of Atlas. Switching this on points it at this one.'
              : 'Starts hidden in the tray when you sign in. Off by default; this only adds an entry for your own account.'
          }
          extra={startupError}
        >
          <Switch
            checked={startup?.enabled === true}
            onCheckedChange={toggleStartup}
            aria-label="Start with Windows"
          />
        </Row>
      )}

      {platform.setQuitOnClose && (
        <Row
          label="Closing the window quits Atlas"
          hint="Off: closing the window puts Atlas away and it keeps running in the tray."
        >
          <Switch
            checked={prefs.quitOnClose}
            onCheckedChange={(quitOnClose) => save({ quitOnClose })}
            aria-label="Closing the window quits Atlas"
          />
        </Row>
      )}

      <div className="flex flex-col gap-2">
        <span className="text-foreground text-sm">How much Atlas makes itself heard</span>
        <SegmentedControl options={MODES} value={prefs.mode} onChange={(mode) => save({ mode })} />
        <p className="text-foreground-subtle text-xs leading-relaxed">{MODE_HINT[prefs.mode]}</p>
      </div>

      <Row
        label="Speak reminders aloud"
        hint="Reads a reminder, timer or watch result out when it goes off, if spoken replies are on. Never in Quiet or Privacy, or during quiet hours."
      >
        <Switch
          checked={prefs.speakReminders}
          onCheckedChange={(speakReminders) => save({ speakReminders })}
          aria-label="Speak reminders aloud"
        />
      </Row>

      <Row
        label="Quiet hours"
        hint="No spoken reminders and no chimes between these times. Alarms still sound."
      >
        <Switch
          checked={prefs.quietHours.enabled}
          onCheckedChange={(enabled) => save({ quietHours: { enabled } })}
          aria-label="Quiet hours"
        />
      </Row>
      {prefs.quietHours.enabled && (
        <div className="text-foreground-muted flex items-center gap-2 text-sm">
          <span>From</span>
          <TimeField
            value={prefs.quietHours.from}
            onChange={(from) => save({ quietHours: { from } })}
            label="Quiet hours start"
          />
          <span>to</span>
          <TimeField
            value={prefs.quietHours.to}
            onChange={(to) => save({ quietHours: { to } })}
            label="Quiet hours end"
          />
        </div>
      )}
    </section>
  );
}

function Row({
  label,
  hint,
  extra,
  children,
}: {
  label: string;
  hint: string;
  extra?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-foreground text-sm">{label}</div>
        <p className="text-foreground-subtle mt-0.5 text-xs leading-relaxed">{hint}</p>
        {extra && <p className="text-danger mt-1 text-xs">{extra}</p>}
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}

function TimeField({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange(value: string): void;
  label: string;
}) {
  return (
    <input
      type="time"
      value={value}
      aria-label={label}
      onChange={(e) => e.target.value && onChange(e.target.value)}
      className="border-border bg-surface text-foreground h-8 rounded-md border px-2 text-sm"
    />
  );
}
