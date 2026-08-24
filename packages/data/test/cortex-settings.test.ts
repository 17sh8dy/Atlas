import { test, assert } from 'vitest';

import type { Storage } from '@atlas/core';
import { MemoryStore } from '../src/memory-store';
import {
  readActiveProvider,
  readCortexSettings,
  writeActiveProvider,
  writeCortexBaseUrl,
  writeCortexEnabled,
} from '../src/cortex-settings';

function makeStorage(): Storage {
  const data = new Map<string, unknown>();
  return {
    get: async (key) => data.get(key) as never,
    set: async (key, value) => void data.set(key, value),
    remove: async (key) => void data.delete(key),
  };
}

test('Cortex is off, and pointed nowhere in particular, until asked', async () => {
  const storage = makeStorage();
  assert.deepEqual(await readCortexSettings(storage), { enabled: false, baseUrl: '' });
});

test('enabling Cortex round-trips', async () => {
  const storage = makeStorage();
  await writeCortexEnabled(storage, true);
  assert.isTrue((await readCortexSettings(storage)).enabled);

  await writeCortexEnabled(storage, false);
  assert.isFalse((await readCortexSettings(storage)).enabled);
});

test('a custom endpoint round-trips, trimmed', async () => {
  const storage = makeStorage();
  await writeCortexBaseUrl(storage, '  http://127.0.0.1:9000  ');
  assert.equal((await readCortexSettings(storage)).baseUrl, 'http://127.0.0.1:9000');
});

test('anything that is not exactly "true" fails closed', async () => {
  // A half-written or hand-edited preference must not switch an outbound
  // call on. Only the string this module itself writes counts as enabled.
  for (const junk of ['TRUE', '1', 'yes', 'on', 'null', 'false']) {
    const storage = makeStorage();
    await new MemoryStore(storage).remember('preference', 'cortex.enabled', junk);
    assert.isFalse((await readCortexSettings(storage)).enabled, junk);
  }
});

test('the active provider round-trips, and null clears it', async () => {
  const storage = makeStorage();
  await writeActiveProvider(storage, 'cortex');
  assert.equal(await readActiveProvider(storage), 'cortex');

  await writeActiveProvider(storage, null);
  assert.isUndefined(await readActiveProvider(storage));
});
