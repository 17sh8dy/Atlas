/**
 * The VoiceProfile store — what Atlas calls you, what it calls itself, how it
 * greets you, and its role. The role field is the newest and the one with a
 * defensive read worth pinning: a hand-edited or stale value must fall back
 * to `undefined` (which `Phrasing` then reads as the default role) rather
 * than reaching `ATLAS_ROLE_META` as a key it doesn't have.
 */

import { test, assert } from 'vitest';
import type { Storage } from '@atlas/core';
import { ATLAS_ROLES } from '@atlas/core';
import { MemoryStore } from '../src/memory-store';
import { readVoiceProfile, writePreference } from '../src/preferences';

function makeStorage(): Storage {
  const data = new Map<string, unknown>();
  return {
    get: async (key) => data.get(key) as never,
    set: async (key, value) => void data.set(key, value),
    remove: async (key) => void data.delete(key),
  };
}

test('an untouched install has every field unset', async () => {
  const profile = await readVoiceProfile(makeStorage());
  assert.deepEqual(profile, {
    userName: undefined,
    atlasName: undefined,
    greeting: undefined,
    role: undefined,
  });
});

test('each field round-trips independently', async () => {
  const storage = makeStorage();
  await writePreference(storage, 'user.name', 'Shady');
  await writePreference(storage, 'atlas.name', 'JARVIS');
  await writePreference(storage, 'greeting', 'Yo.');
  await writePreference(storage, 'role', 'pilot');

  const profile = await readVoiceProfile(storage);
  assert.equal(profile.userName, 'Shady');
  assert.equal(profile.atlasName, 'JARVIS');
  assert.equal(profile.greeting, 'Yo.');
  assert.equal(profile.role, 'pilot');
});

test('every real role round-trips', async () => {
  for (const role of ATLAS_ROLES) {
    const storage = makeStorage();
    await writePreference(storage, 'role', role);
    assert.equal((await readVoiceProfile(storage)).role, role);
  }
});

test('a hand-edited or stale role falls back to undefined rather than reaching ATLAS_ROLE_META', async () => {
  for (const junk of ['', 'jarvis', 'HAL9000', 'null']) {
    const storage = makeStorage();
    await new MemoryStore(storage).remember('preference', 'role', junk);
    assert.isUndefined((await readVoiceProfile(storage)).role, junk);
  }
});
