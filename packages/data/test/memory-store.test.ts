import { test, assert } from 'vitest';

import type { Storage } from '@atlas/core';
import { MemoryStore } from '../src/memory-store';

function makeStorage(): Storage {
  const data = new Map<string, unknown>();
  return {
    get: async (key) => data.get(key) as never,
    set: async (key, value) => void data.set(key, value),
    remove: async (key) => void data.delete(key),
  };
}

// ---- facts -------------------------------------------------------------

test('remember writes a fact, retrievable by kind and subject', async () => {
  const store = new MemoryStore(makeStorage());
  await store.remember('alias', 'work folder', 'D:\\Dev');
  const fact = await store.fact('alias', 'work folder');
  assert.equal(fact?.value, 'D:\\Dev');
});

test('facts of different kinds coexist under the same subject', async () => {
  const store = new MemoryStore(makeStorage());
  await store.remember('preference', 'name', 'Brandon');
  await store.remember('alias', 'name', 'not a real alias, just distinct kind');
  assert.equal((await store.facts('preference')).length, 1);
  assert.equal((await store.facts('alias')).length, 1);
  assert.equal((await store.facts()).length, 2);
});

test('remembering the same kind+subject again replaces, not duplicates', async () => {
  const store = new MemoryStore(makeStorage());
  await store.remember('alias', 'work folder', 'D:\\Dev');
  await store.remember('alias', 'work folder', 'D:\\Dev\\Atlas');
  const all = await store.facts('alias');
  assert.equal(all.length, 1);
  assert.equal(all[0].value, 'D:\\Dev\\Atlas');
});

test('remembering an empty value forgets it instead of storing blank', async () => {
  const store = new MemoryStore(makeStorage());
  await store.remember('alias', 'work folder', 'D:\\Dev');
  await store.remember('alias', 'work folder', '   ');
  assert.isUndefined(await store.fact('alias', 'work folder'));
});

test('forget removes only the matching kind+subject', async () => {
  const store = new MemoryStore(makeStorage());
  await store.remember('alias', 'work folder', 'D:\\Dev');
  await store.remember('preference', 'work folder', 'unrelated');
  await store.forget('alias', 'work folder');
  assert.isUndefined(await store.fact('alias', 'work folder'));
  assert.equal((await store.fact('preference', 'work folder'))?.value, 'unrelated');
});

// ---- episodes ------------------------------------------------------------

test('record appends a new episode', async () => {
  const store = new MemoryStore(makeStorage());
  await store.record('app.launched', 'Opened Steam');
  const events = await store.episodes();
  assert.equal(events.length, 1);
  assert.equal(events[0].label, 'Opened Steam');
  assert.isUndefined(events[0].count);
});

test('consecutive identical episodes collapse into a count', async () => {
  const store = new MemoryStore(makeStorage());
  await store.record('app.launched', 'Opened Steam');
  await store.record('app.launched', 'Opened Steam');
  await store.record('app.launched', 'Opened Steam');
  const events = await store.episodes();
  assert.equal(events.length, 1);
  assert.equal(events[0].count, 3);
});

test('a different episode in between breaks the collapse', async () => {
  const store = new MemoryStore(makeStorage());
  await store.record('app.launched', 'Opened Steam');
  await store.record('app.launched', 'Opened Discord');
  await store.record('app.launched', 'Opened Steam');
  const events = await store.episodes();
  assert.equal(events.length, 3);
  assert.isUndefined(events[0].count);
});

test('episodes are capped at 200, oldest dropped first', async () => {
  const store = new MemoryStore(makeStorage());
  for (let i = 0; i < 205; i++) {
    await store.record('app.launched', `Opened app ${i}`);
  }
  const events = await store.episodes();
  assert.equal(events.length, 200);
  assert.equal(events[0].label, 'Opened app 5');
  assert.equal(events[events.length - 1].label, 'Opened app 204');
});

test('forgetEpisode removes only the episode with that timestamp', async () => {
  const store = new MemoryStore(makeStorage());
  await store.record('app.launched', 'Opened Steam');
  await store.record('app.launched', 'Opened Discord');
  const [first, second] = await store.episodes();
  await store.forgetEpisode(first.at);
  const remaining = await store.episodes();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].label, second.label);
});

test('clearEpisodes empties the timeline without touching facts', async () => {
  const store = new MemoryStore(makeStorage());
  await store.remember('alias', 'work folder', 'D:\\Dev');
  await store.record('app.launched', 'Opened Steam');
  await store.clearEpisodes();
  assert.deepEqual(await store.episodes(), []);
  assert.equal((await store.fact('alias', 'work folder'))?.value, 'D:\\Dev');
});
