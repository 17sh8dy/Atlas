import { test, assert } from 'vitest';

import type { Storage } from '@atlas/core';
import { MemoryStore } from '../src/memory-store';
import {
  DEFAULT_LOCAL_AI_SETTINGS,
  readActiveProvider,
  readLocalAiSettings,
  writeActiveProvider,
  writeLocalModelsBaseUrl,
  writeLocalModelsEnabled,
  writeNovaIntelligenceBaseUrl,
  writeNovaIntelligenceEnabled,
} from '../src/local-ai-settings';

function makeStorage(): Storage {
  const data = new Map<string, unknown>();
  return {
    get: async (key) => data.get(key) as never,
    set: async (key, value) => void data.set(key, value),
    remove: async (key) => void data.delete(key),
  };
}

test('everything is off, and pointed nowhere in particular, until asked', async () => {
  const storage = makeStorage();
  assert.deepEqual(await readLocalAiSettings(storage), DEFAULT_LOCAL_AI_SETTINGS);
});

test('local models and Nova Intelligence are independent switches', async () => {
  const storage = makeStorage();
  await writeLocalModelsEnabled(storage, true);
  let s = await readLocalAiSettings(storage);
  assert.isTrue(s.local.enabled);
  assert.isFalse(s.nova.enabled);

  await writeNovaIntelligenceEnabled(storage, true);
  await writeLocalModelsEnabled(storage, false);
  s = await readLocalAiSettings(storage);
  assert.isFalse(s.local.enabled);
  assert.isTrue(s.nova.enabled);
});

test('each endpoint round-trips, trimmed, without touching the other', async () => {
  const storage = makeStorage();
  await writeLocalModelsBaseUrl(storage, '  http://127.0.0.1:11500  ');
  await writeNovaIntelligenceBaseUrl(storage, 'http://127.0.0.1:9100');
  const s = await readLocalAiSettings(storage);
  assert.equal(s.local.baseUrl, 'http://127.0.0.1:11500');
  assert.equal(s.nova.baseUrl, 'http://127.0.0.1:9100');
});

test('anything that is not exactly "true" fails closed', async () => {
  // A half-written or hand-edited preference must not switch a connection on.
  for (const junk of ['TRUE', '1', 'yes', 'on', 'null', 'false']) {
    for (const subject of ['local.enabled', 'nova.enabled']) {
      const storage = makeStorage();
      await new MemoryStore(storage).remember('preference', subject, junk);
      const s = await readLocalAiSettings(storage);
      assert.isFalse(s.local.enabled, `${subject}=${junk}`);
      assert.isFalse(s.nova.enabled, `${subject}=${junk}`);
    }
  }
});

test('the active provider round-trips, and null clears it', async () => {
  const storage = makeStorage();
  assert.isUndefined(await readActiveProvider(storage));
  await writeActiveProvider(storage, 'local:qwen3-30b-a3b');
  assert.equal(await readActiveProvider(storage), 'local:qwen3-30b-a3b');
  await writeActiveProvider(storage, null);
  assert.notOk(await readActiveProvider(storage));
});

test('no key-shaped field can exist in these settings', async () => {
  // Cloud keys live in Credential Manager only; this store must never be a
  // place one could be written to by accident.
  const s = await readLocalAiSettings(makeStorage());
  for (const section of [s.local, s.nova]) {
    assert.deepEqual(Object.keys(section).sort(), ['baseUrl', 'enabled']);
  }
});
