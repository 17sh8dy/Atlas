/** The saved switch: off for everyone until they turn it on, including people upgrading with nothing saved. */
import { expect, test } from 'vitest';
import type { Storage } from '@atlas/core';
import { readUniversalAgent, writeUniversalAgent } from '../../data/src/routing-preference';

const mem = (): Storage & { data: Map<string, unknown> } => {
  const data = new Map<string, unknown>();
  return { data, get: async <T,>(k: string) => data.get(k) as T | undefined, set: async (k: string, v: unknown) => void data.set(k, JSON.parse(JSON.stringify(v))), remove: async (k: string) => void data.delete(k) };
};

test('nothing saved (a fresh install, or an upgrade from 2.0.1) reads as OFF', async () => {
  expect(await readUniversalAgent(mem())).toBe(false);
});

test('an existing user whose storage already has other preferences is still OFF', async () => {
  const s = mem();
  await s.set('atlas.memory', { facts: [{ kind: 'preference', key: 'routing.cloudPlanning', value: 'true' }] });
  expect(await readUniversalAgent(s)).toBe(false);
});

test('only an explicit on turns it on, and off turns it off again', async () => {
  const s = mem();
  await writeUniversalAgent(s, true);
  expect(await readUniversalAgent(s)).toBe(true);
  await writeUniversalAgent(s, false);
  expect(await readUniversalAgent(s)).toBe(false);
});
