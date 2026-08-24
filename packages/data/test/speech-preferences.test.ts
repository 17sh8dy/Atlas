/**
 * Speech preferences, and the defensive read that keeps a hand-edited file
 * from reaching the synthesiser.
 *
 * The preferences file is plain JSON on a disk a person owns. A pace of
 * "fast" or a volume of "loud" has to become the default, not silence and
 * not a crash.
 */

import { test, assert } from 'vitest';
import type { Storage } from '@atlas/core';
import { DEFAULT_SPEECH } from '@atlas/core';
import { MemoryStore } from '../src/memory-store';
import { readSpeechPreferences, writeSpeechPreferences } from '../src/speech-preferences';

function makeStorage(): Storage {
  const data = new Map<string, unknown>();
  return {
    get: async (key) => data.get(key) as never,
    set: async (key, value) => void data.set(key, value),
    remove: async (key) => void data.delete(key),
  };
}

test('an untouched install gets the documented defaults', async () => {
  assert.deepEqual(await readSpeechPreferences(makeStorage()), DEFAULT_SPEECH);
});

test('volume round-trips', async () => {
  const storage = makeStorage();
  await writeSpeechPreferences(storage, { volume: 0.4 });
  assert.equal((await readSpeechPreferences(storage)).volume, 0.4);
});

test('silence is a choice a person is allowed to make', async () => {
  // 0 must survive the read. A falsy-check here instead of a Number.isFinite
  // one would quietly restore full volume for anyone who muted Atlas.
  const storage = makeStorage();
  await writeSpeechPreferences(storage, { volume: 0 });
  assert.equal((await readSpeechPreferences(storage)).volume, 0);
});

test('volume is clamped into range rather than trusted', async () => {
  for (const [written, expected] of [
    ['5', 1],
    ['-3', 0],
    ['1.0001', 1],
  ] as const) {
    const storage = makeStorage();
    await new MemoryStore(storage).remember('preference', 'speech.volume', written);
    assert.equal((await readSpeechPreferences(storage)).volume, expected, written);
  }
});

test('an unparseable volume falls back to the default, never to silence', async () => {
  for (const junk of ['loud', '', 'NaN', 'null']) {
    const storage = makeStorage();
    await new MemoryStore(storage).remember('preference', 'speech.volume', junk);
    const { volume } = await readSpeechPreferences(storage);
    assert.equal(volume, DEFAULT_SPEECH.volume, junk);
  }
});

test('the other preferences still round-trip alongside it', async () => {
  const storage = makeStorage();
  await writeSpeechPreferences(storage, {
    enabled: true,
    voiceId: 'male-yorkshire',
    pace: 1.2,
    volume: 0.75,
  });
  assert.deepEqual(await readSpeechPreferences(storage), {
    enabled: true,
    voiceId: 'male-yorkshire',
    pace: 1.2,
    volume: 0.75,
  });
});
