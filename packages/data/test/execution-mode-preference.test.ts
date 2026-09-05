/**
 * Which execution mode Atlas is in, and the defensive read that keeps a
 * hand-edited or stale value from reaching the executor as something that
 * isn't a real mode.
 */

import { test, assert } from 'vitest';
import type { Storage } from '@atlas/core';
import { DEFAULT_EXECUTION_MODE } from '@atlas/core';
import { MemoryStore } from '../src/memory-store';
import { readExecutionMode, writeExecutionMode } from '../src/execution-mode-preference';

function makeStorage(): Storage {
  const data = new Map<string, unknown>();
  return {
    get: async (key) => data.get(key) as never,
    set: async (key, value) => void data.set(key, value),
    remove: async (key) => void data.delete(key),
  };
}

test('an untouched install gets the documented default', async () => {
  assert.equal(await readExecutionMode(makeStorage()), DEFAULT_EXECUTION_MODE);
});

test('each mode round-trips', async () => {
  for (const mode of ['doIt', 'planFirst', 'confirmActions'] as const) {
    const storage = makeStorage();
    await writeExecutionMode(storage, mode);
    assert.equal(await readExecutionMode(storage), mode);
  }
});

test('a hand-edited or stale value falls back to the default rather than reaching the executor', async () => {
  for (const junk of ['', 'plan-first', 'YOLO', 'null']) {
    const storage = makeStorage();
    await new MemoryStore(storage).remember('preference', 'execution.mode', junk);
    assert.equal(await readExecutionMode(storage), DEFAULT_EXECUTION_MODE, junk);
  }
});
