/**
 * How Atlas starts listening without a button (double clap): off by default, and a damaged or hand-edited
 * preferences file can never switch it on — the same rule the microphone switch itself follows.
 */

import { test, assert } from 'vitest';
import type { Storage } from '@atlas/core';
import { DEFAULT_LISTENING } from '@atlas/core';
import { MemoryStore } from '../src/memory-store';
import { readListeningPreferences, writeListeningPreferences } from '../src/listening-preferences';

function makeStorage(): Storage {
  const data = new Map<string, unknown>();
  return {
    get: async (key) => data.get(key) as never,
    set: async (key, value) => void data.set(key, value),
    remove: async (key) => void data.delete(key),
  };
}

test('an untouched install does not listen for anything', async () => {
  const p = await readListeningPreferences(makeStorage());
  assert.equal(p.activation, 'off');
  assert.equal(p.clapSensitivity, DEFAULT_LISTENING.clapSensitivity);
  assert.equal(p.enabled, false);
});

test('the clap trigger and its sensitivity round-trip', async () => {
  const storage = makeStorage();
  await writeListeningPreferences(storage, { activation: 'clap', clapSensitivity: 4 });
  const p = await readListeningPreferences(storage);
  assert.equal(p.activation, 'clap');
  assert.equal(p.clapSensitivity, 4);
});

test('anything but an exact "clap" leaves it off', async () => {
  for (const bad of ['true', 'Clap ', 'yes', '1', '']) {
    const storage = makeStorage();
    await new MemoryStore(storage).remember('preference', 'listening.activation', bad);
    assert.equal((await readListeningPreferences(storage)).activation, 'off', `"${bad}"`);
  }
});

test('a silly sensitivity is pulled back into 1 to 5', async () => {
  const storage = makeStorage();
  const memory = new MemoryStore(storage);
  await memory.remember('preference', 'listening.clapSensitivity', '99');
  assert.equal((await readListeningPreferences(storage)).clapSensitivity, 5);
  await memory.remember('preference', 'listening.clapSensitivity', '-3');
  assert.equal((await readListeningPreferences(storage)).clapSensitivity, 1);
  await memory.remember('preference', 'listening.clapSensitivity', 'loud');
  assert.equal(
    (await readListeningPreferences(storage)).clapSensitivity,
    DEFAULT_LISTENING.clapSensitivity,
  );
});

test('every activation mode round-trips, and nothing else is accepted', async () => {
  for (const mode of ['off', 'clap', 'wake', 'both'] as const) {
    const storage = makeStorage();
    await writeListeningPreferences(storage, { activation: mode });
    assert.equal((await readListeningPreferences(storage)).activation, mode);
  }
  const storage = makeStorage();
  await writeListeningPreferences(storage, { activation: 'clap' });
  await writeListeningPreferences(storage, { activation: 'always' as never });
  assert.equal((await readListeningPreferences(storage)).activation, 'clap');
});

test('the wake phrase: any valid words, tidied; an invalid one is never saved or read', async () => {
  const storage = makeStorage();
  assert.equal((await readListeningPreferences(storage)).wakePhrase, DEFAULT_LISTENING.wakePhrase);
  await writeListeningPreferences(storage, { wakePhrase: '  Wake   up   Jarvis ' });
  assert.equal((await readListeningPreferences(storage)).wakePhrase, 'Wake up Jarvis');
  await writeListeningPreferences(storage, { wakePhrase: 'hey' });
  assert.equal((await readListeningPreferences(storage)).wakePhrase, 'Wake up Jarvis');
  await new MemoryStore(storage).remember('preference', 'listening.wakePhrase', '<script>');
  assert.equal((await readListeningPreferences(storage)).wakePhrase, DEFAULT_LISTENING.wakePhrase);
});
