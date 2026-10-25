/**
 * Presence settings (see core `models/presence.ts`): the mode, quiet hours, spoken reminders, and what the
 * close button does. Same `MemoryStore` preference facts as everything else, read defensively: a hand-edited or
 * damaged file falls back to the default, and the only way to the "speaks on its own" and "quits on close"
 * behaviours is an exact `true`.
 */

import type { Storage, PresencePreferences, PresenceMode } from '@atlas/core';
import { DEFAULT_PRESENCE, PRESENCE_MODES, isValidTime } from '@atlas/core';
import { MemoryStore } from './memory-store';

const MODE = 'presence.mode';
const QUIET_ON = 'presence.quietHours.enabled';
const QUIET_FROM = 'presence.quietHours.from';
const QUIET_TO = 'presence.quietHours.to';
const SPEAK = 'presence.speakReminders';
const QUIT = 'presence.quitOnClose';

export async function readPresencePreferences(storage: Storage): Promise<PresencePreferences> {
  const memory = new MemoryStore(storage);
  const [mode, on, from, to, speak, quit] = await Promise.all(
    [MODE, QUIET_ON, QUIET_FROM, QUIET_TO, SPEAK, QUIT].map((k) => memory.fact('preference', k)),
  );
  const asMode = (PRESENCE_MODES as readonly string[]).includes(mode?.value ?? '')
    ? (mode!.value as PresenceMode)
    : DEFAULT_PRESENCE.mode;
  return {
    mode: asMode,
    quietHours: {
      enabled: on?.value === 'true',
      from: from && isValidTime(from.value) ? from.value : DEFAULT_PRESENCE.quietHours.from,
      to: to && isValidTime(to.value) ? to.value : DEFAULT_PRESENCE.quietHours.to,
    },
    speakReminders: speak?.value === 'true',
    quitOnClose: quit?.value === 'true',
  };
}

export async function writePresencePreferences(
  storage: Storage,
  next: Partial<Omit<PresencePreferences, 'quietHours'>> & {
    quietHours?: Partial<PresencePreferences['quietHours']>;
  },
): Promise<void> {
  const memory = new MemoryStore(storage);
  const put = (key: string, value: string) => memory.remember('preference', key, value);
  if (next.mode !== undefined && (PRESENCE_MODES as readonly string[]).includes(next.mode))
    await put(MODE, next.mode);
  if (next.speakReminders !== undefined) await put(SPEAK, String(next.speakReminders));
  if (next.quitOnClose !== undefined) await put(QUIT, String(next.quitOnClose));
  const q = next.quietHours;
  if (q?.enabled !== undefined) await put(QUIET_ON, String(q.enabled));
  if (q?.from !== undefined && isValidTime(q.from)) await put(QUIET_FROM, q.from);
  if (q?.to !== undefined && isValidTime(q.to)) await put(QUIET_TO, q.to);
}
