/**
 * How Atlas gets your attention — a notification, a sound, or both.
 *
 * One place decides it. Everything that wants to tell you something (a
 * reminder, an alarm, a timer, a watch that finished) goes through
 * `platform.notify`, so wrapping `notify` here covers all of them without each
 * having to know the settings exist.
 *
 * Two independent switches, on purpose:
 *  - **Notifications** — the Windows toast. Off = no toast.
 *  - **Sound** — a tone. Independent of the toast: some people want a sound
 *    with no popup, some a popup with no sound.
 *
 * An alarm uses the alarm tone whatever the chosen sound is, because an alarm
 * that makes a polite chime is an alarm that does not wake anyone.
 *
 * Storage keys are lowercase (storage.rs refuses anything else).
 */

import type { Platform, Storage } from '@atlas/core';

export const ALERT_SOUNDS = ['chime', 'bell', 'beep', 'soft', 'alarm', 'system'] as const;
export type AlertSound = (typeof ALERT_SOUNDS)[number];

export const SOUND_LABELS: Record<AlertSound, string> = {
  chime: 'Chime',
  bell: 'Bell',
  beep: 'Beep',
  soft: 'Soft',
  alarm: 'Alarm',
  system: 'Windows',
};

export interface AlertSettings {
  /** Show a Windows notification. */
  notify: boolean;
  /** Play a sound. */
  sound: boolean;
  /** Which sound, for reminders and timers. */
  kind: AlertSound;
  /** 0–100. */
  volume: number;
}

export const DEFAULT_ALERTS: AlertSettings = { notify: true, sound: true, kind: 'chime', volume: 70 };

/** The existing on/off key, kept so a saved "off" still means off. */
export const NOTIFY_KEY = 'atlas.settings.notifications-enabled';
const NOTIFY_LEGACY_KEY = 'atlas.settings.notificationsEnabled'; // storage-key-legacy
export const ALERTS_KEY = 'atlas.settings.alerts';
export const ALERTS_CHANGED = 'atlas:alerts-changed';

function clean(raw: unknown): Partial<AlertSettings> {
  const r = (raw ?? {}) as Partial<AlertSettings>;
  const out: Partial<AlertSettings> = {};
  if (typeof r.sound === 'boolean') out.sound = r.sound;
  if (typeof r.kind === 'string' && (ALERT_SOUNDS as readonly string[]).includes(r.kind)) out.kind = r.kind as AlertSound;
  if (typeof r.volume === 'number' && Number.isFinite(r.volume)) out.volume = Math.min(100, Math.max(0, Math.round(r.volume)));
  return out;
}

export async function readAlerts(storage: Storage): Promise<AlertSettings> {
  const saved = clean(await storage.get(ALERTS_KEY).catch(() => undefined));
  let notify = await storage.get<boolean>(NOTIFY_KEY).catch(() => undefined);
  if (notify === undefined) notify = await storage.get<boolean>(NOTIFY_LEGACY_KEY).catch(() => undefined);
  return { ...DEFAULT_ALERTS, ...saved, notify: notify ?? DEFAULT_ALERTS.notify };
}

export async function writeAlerts(storage: Storage, patch: Partial<AlertSettings>): Promise<AlertSettings> {
  const next = { ...(await readAlerts(storage)), ...patch };
  await storage.set(ALERTS_KEY, { sound: next.sound, kind: next.kind, volume: next.volume });
  await storage.set(NOTIFY_KEY, next.notify);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(ALERTS_CHANGED));
  return next;
}

/** Which tone a notification gets: alarms are always the alarm. */
export function soundFor(title: string, chosen: AlertSound): AlertSound {
  return /^alarm\b/i.test(title) ? 'alarm' : chosen;
}

/**
 * The same platform, with `notify` honouring the settings. Everything else is
 * passed through untouched.
 */
export function withAlerts(base: Platform, storage: Storage): Platform {
  if (!base.notify) return base;
  return {
    ...base,
    notify: async (title: string, body?: string) => {
      const s = await readAlerts(storage);
      if (s.sound && base.playSound) {
        void base.playSound(soundFor(title, s.kind), s.volume).catch(() => false);
      }
      if (!s.notify) return s.sound; // the sound was the notification
      return base.notify!(title, body);
    },
  };
}
