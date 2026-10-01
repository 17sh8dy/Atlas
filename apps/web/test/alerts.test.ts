/**
 * Notifications and sound: which of the two reaches you, and which tone.
 */

import { assert, test } from 'vitest';
import type { Platform, Storage } from '@atlas/core';
import { ALERTS_KEY, NOTIFY_KEY, readAlerts, soundFor, withAlerts, writeAlerts } from '../src/atlas/alerts';

function store(initial: Record<string, unknown> = {}): Storage {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    async get<T>(k: string) {
      return data.get(k) as T | undefined;
    },
    async set(k: string, v: unknown) {
      data.set(k, JSON.parse(JSON.stringify(v)));
    },
    async remove(k: string) {
      data.delete(k);
    },
  };
}

function platform() {
  const log: string[] = [];
  const p = {
    notify: async (t: string, b?: string) => {
      log.push(`toast ${t}: ${b}`);
      return true;
    },
    playSound: async (k: string, v?: number) => {
      log.push(`sound ${k} ${v}`);
      return true;
    },
  } as unknown as Platform;
  return { p, log };
}

test('by default a reminder shows a notification and plays the chosen sound', async () => {
  const { p, log } = platform();
  await withAlerts(p, store()).notify!('Reminder', 'call mom');
  assert.deepEqual(log, ['sound chime 70', 'toast Reminder: call mom']);
});

test('an alarm is always the alarm tone, however polite the chosen one', async () => {
  const { p, log } = platform();
  const s = store({ [ALERTS_KEY]: { sound: true, kind: 'soft', volume: 40 } });
  await withAlerts(p, s).notify!('Alarm', 'wake up');
  assert.equal(log[0], 'sound alarm 40');
  assert.equal(soundFor('Reminder', 'soft'), 'soft');
});

test('the two switches are independent', async () => {
  const noSound = platform();
  await withAlerts(noSound.p, store({ [ALERTS_KEY]: { sound: false } })).notify!('Reminder', 'x');
  assert.deepEqual(noSound.log, ['toast Reminder: x']);

  const noToast = platform();
  const r = await withAlerts(noToast.p, store({ [NOTIFY_KEY]: false })).notify!('Reminder', 'x');
  assert.deepEqual(noToast.log, ['sound chime 70'], 'a sound with no popup');
  assert.equal(r, true);

  const neither = platform();
  await withAlerts(neither.p, store({ [NOTIFY_KEY]: false, [ALERTS_KEY]: { sound: false } })).notify!('Reminder', 'x');
  assert.deepEqual(neither.log, [], 'both off means silence');
});

test('a "notifications off" saved by the old toggle is still honoured', async () => {
  const s = store({ 'atlas.settings.notificationsEnabled': false }); // storage-key-legacy
  assert.equal((await readAlerts(s)).notify, false);
});

test('junk in storage falls back to the defaults instead of breaking the alert', async () => {
  const s = store({ [ALERTS_KEY]: { sound: 'yes', kind: 'klaxon', volume: 9000 } });
  const a = await readAlerts(s);
  assert.equal(a.kind, 'chime');
  assert.equal(a.sound, true);
  assert.equal(a.volume, 100, 'clamped, not trusted');
});

test('saving keeps the old key in step and does not lose the other settings', async () => {
  const s = store();
  await writeAlerts(s, { kind: 'bell' });
  await writeAlerts(s, { notify: false });
  const a = await readAlerts(s);
  assert.deepEqual(a, { notify: false, sound: true, kind: 'bell', volume: 70 });
  assert.equal(await s.get(NOTIFY_KEY), false);
});

test('a platform with no notifications is returned as it is', () => {
  const bare = {} as Platform;
  assert.equal(withAlerts(bare, store()), bare);
});
