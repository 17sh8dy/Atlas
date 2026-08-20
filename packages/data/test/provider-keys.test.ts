import { test, assert } from 'vitest';

import type { Storage } from '@atlas/core';
import {
  readActiveProvider,
  readProviderKey,
  readProviderKeys,
  writeActiveProvider,
  writeProviderKey,
} from '../src/provider-keys';

function makeStorage(): Storage {
  const data = new Map<string, unknown>();
  return {
    get: async (key) => data.get(key) as never,
    set: async (key, value) => void data.set(key, value),
    remove: async (key) => void data.delete(key),
  };
}

test('a key round-trips through write and read', async () => {
  const storage = makeStorage();
  await writeProviderKey(storage, 'claude', 'sk-ant-test123');
  assert.equal(await readProviderKey(storage, 'claude'), 'sk-ant-test123');
});

test('claude and openai keys are independent', async () => {
  const storage = makeStorage();
  await writeProviderKey(storage, 'claude', 'sk-ant-aaa');
  await writeProviderKey(storage, 'openai', 'sk-oai-bbb');
  const keys = await readProviderKeys(storage);
  assert.deepEqual(keys, { claude: 'sk-ant-aaa', openai: 'sk-oai-bbb' });
});

test('an unset key is simply absent, not an error', async () => {
  const storage = makeStorage();
  assert.isUndefined(await readProviderKey(storage, 'claude'));
  assert.deepEqual(await readProviderKeys(storage), {});
});

test('the active provider round-trips, and null clears it', async () => {
  const storage = makeStorage();
  await writeActiveProvider(storage, 'claude');
  assert.equal(await readActiveProvider(storage), 'claude');

  await writeActiveProvider(storage, null);
  assert.isUndefined(await readActiveProvider(storage));
});
