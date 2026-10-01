/**
 * Notifications — how Atlas gets your attention: a Windows notification, a
 * sound, or both.
 *
 * What reaches you this way: reminders and alarms ("remind me to call mom at
 * 5"), timers, and anything Atlas was watching for that finished. Both switches
 * are honoured for all of them (see `atlas/alerts.ts`, which wraps the
 * platform's `notify`); this page only edits the settings.
 *
 * The two are independent: a sound with no popup, or a popup with no sound, are
 * both ordinary things to want.
 */

import { useEffect, useState } from 'react';
import type { CapabilityName, Platform, Storage } from '@atlas/core';
import { Button, SegmentedControl, Switch } from '@atlas/ui';
import {
  ALERT_SOUNDS,
  SOUND_LABELS,
  readAlerts,
  writeAlerts,
  DEFAULT_ALERTS,
  type AlertSettings,
  type AlertSound,
} from '../../atlas/alerts';

interface Props {
  platform: Platform;
  capabilities: readonly CapabilityName[];
  storage: Storage;
}

export function Notifications({ platform, capabilities, storage }: Props) {
  const supported = capabilities.includes('notifications');
  const canSound = Boolean(platform.playSound);
  const [s, setS] = useState<AlertSettings>(DEFAULT_ALERTS);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void readAlerts(storage).then((v) => alive && setS(v));
    return () => {
      alive = false;
    };
  }, [storage]);

  const change = (patch: Partial<AlertSettings>) => {
    setS((cur) => ({ ...cur, ...patch }));
    void writeAlerts(storage, patch);
  };

  const preview = async (kind: AlertSound, volume = s.volume) => {
    const ok = await platform.playSound?.(kind, volume).catch(() => false);
    setStatus(ok ? null : "Couldn't play that sound.");
  };

  return (
    <section className="space-y-3">
      <div className="border-border flex items-center justify-between gap-4 rounded-xl border px-4 py-3.5">
        <div>
          <h2 className="text-foreground text-sm font-medium">Show notifications</h2>
          <p className="text-foreground-subtle mt-0.5 text-xs leading-relaxed">
            {supported
              ? 'A Windows notification for reminders, alarms, timers, and things Atlas was watching for.'
              : "This build can't send OS notifications."}
          </p>
        </div>
        <Switch
          checked={s.notify}
          disabled={!supported}
          onCheckedChange={(v) => change({ notify: v })}
          aria-label="Show notifications"
        />
      </div>

      <div className="border-border rounded-xl border px-4 py-3.5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-foreground text-sm font-medium">Play a sound</h2>
            <p className="text-foreground-subtle mt-0.5 text-xs leading-relaxed">
              {canSound
                ? 'A tone when a reminder, alarm or timer goes off. Alarms always use the alarm tone.'
                : "This build can't play sounds."}
            </p>
          </div>
          <Switch
            checked={s.sound}
            disabled={!canSound}
            onCheckedChange={(v) => change({ sound: v })}
            aria-label="Play a sound"
          />
        </div>

        {s.sound && canSound && (
          <div className="mt-4 space-y-3">
            <div>
              <p className="text-foreground-subtle mb-1.5 text-xs">Reminder and timer sound</p>
              <SegmentedControl<AlertSound>
                options={ALERT_SOUNDS.map((k) => ({ value: k, label: SOUND_LABELS[k] }))}
                value={s.kind}
                onChange={(kind) => {
                  change({ kind });
                  void preview(kind);
                }}
              />
            </div>
            <label className="flex items-center gap-3">
              <span className="text-foreground-subtle w-14 text-xs">Volume</span>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={s.volume}
                aria-label="Alert volume"
                onChange={(e) => setS((cur) => ({ ...cur, volume: Number(e.target.value) }))}
                onPointerUp={() => {
                  change({ volume: s.volume });
                  void preview(s.kind, s.volume);
                }}
                onKeyUp={() => change({ volume: s.volume })}
                className="accent-accent h-1.5 flex-1 cursor-pointer"
              />
              <span className="text-foreground-subtle w-9 text-right text-xs tabular-nums">{s.volume}%</span>
            </label>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          disabled={!supported && !canSound}
          onClick={async () => {
            // Through the same path a real reminder takes, so it tests the settings too.
            const ok = await platform.notify?.('Reminder', 'This is how a reminder will look and sound.');
            setStatus(ok ? 'Sent.' : "Couldn't send — check your OS notification settings.");
          }}
        >
          Send a test reminder
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={!canSound}
          onClick={async () => {
            const ok = await platform.playSound?.('alarm', s.volume).catch(() => false);
            setStatus(ok ? 'Playing the alarm tone.' : "Couldn't play that sound.");
          }}
        >
          Test the alarm sound
        </Button>
        {status && <p className="text-foreground-subtle text-xs">{status}</p>}
      </div>
    </section>
  );
}
