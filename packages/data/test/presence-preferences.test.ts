/**
 * Presence settings round-trip, and a damaged or hand-edited file can only land on the quiet defaults.
 */
import { test, assert } from 'vitest';
import type { Storage } from '@atlas/core';
import { DEFAULT_PRESENCE } from '@atlas/core';
import { MemoryStore } from '../src/memory-store';
import { readPresencePreferences, writePresencePreferences } from '../src/presence-preferences';

function makeStorage(): Storage {
  const data = new Map<string, unknown>();
  return {
    get: async (key) => data.get(key) as never,
    set: async (key, value) => void data.set(key, value),
    remove: async (key) => void data.delete(key),
  };
}

test('an untouched install is exactly the defaults', async () => {
  assert.deepEqual(await readPresencePreferences(makeStorage()), DEFAULT_PRESENCE);
});

test('everything round-trips', async () => {
  const s = makeStorage();
  await writePresencePreferences(s, {
    mode: 'privacy',
    speakReminders: true,
    quitOnClose: true,
    quietHours: { enabled: true, from: '23:15', to: '06:30' },
  });
  assert.deepEqual(await readPresencePreferences(s), {
    mode: 'privacy',
    speakReminders: true,
    quitOnClose: true,
    quietHours: { enabled: true, from: '23:15', to: '06:30' },
  });
});

test('quiet hours are written one field at a time', async () => {
  const s = makeStorage();
  await writePresencePreferences(s, { quietHours: { enabled: true } });
  await writePresencePreferences(s, { quietHours: { from: '21:00' } });
  const p = await readPresencePreferences(s);
  assert.equal(p.quietHours.enabled, true);
  assert.equal(p.quietHours.from, '21:00');
  assert.equal(p.quietHours.to, DEFAULT_PRESENCE.quietHours.to);
});

test('a damaged file can never switch on speaking or quit-on-close', async () => {
  for (const bad of ['yes', '1', 'TRUE', '']) {
    const s = makeStorage();
    const m = new MemoryStore(s);
    await m.remember('preference', 'presence.speakReminders', bad);
    await m.remember('preference', 'presence.quitOnClose', bad);
    const p = await readPresencePreferences(s);
    assert.equal(p.speakReminders, false, `"${bad}"`);
    assert.equal(p.quitOnClose, false, `"${bad}"`);
  }
});

test('an unknown mode or a bad time falls back, and a bad time is never written', async () => {
  const s = makeStorage();
  const m = new MemoryStore(s);
  await m.remember('preference', 'presence.mode', 'stealth');
  await m.remember('preference', 'presence.quietHours.from', '99:99');
  const p = await readPresencePreferences(s);
  assert.equal(p.mode, 'active');
  assert.equal(p.quietHours.from, DEFAULT_PRESENCE.quietHours.from);
  await writePresencePreferences(s, { quietHours: { to: 'whenever' } });
  assert.equal((await readPresencePreferences(s)).quietHours.to, DEFAULT_PRESENCE.quietHours.to);
});
