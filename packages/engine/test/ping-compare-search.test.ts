/**
 * Ping, comparing two files, and searching inside files.
 */

import { assert, test } from 'vitest';
import type { FileEntry, Platform } from '@atlas/core';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { WorkingMemory } from '../src/working-memory';
import { createNetworkSkills } from '../src/skills/network-skills';
import { createFileToolsSkills } from '../src/skills/file-tools-skills';

function grammar(): Grammar {
  const g = new Grammar();
  g.addMany(createCoreGrammar(new WorkingMemory()));
  g.addMany(createExtraGrammar());
  return g;
}
const plan = (text: string) =>
  grammar()
    .parse(text)
    ?.steps.map((s) => [s.skill, s.args]);

test('ping, including as a question', () => {
  assert.deepEqual(plan('ping google.com'), [['net.ping', { host: 'google.com' }]]);
  assert.deepEqual(plan('ping 8.8.8.8'), [['net.ping', { host: '8.8.8.8' }]]);
  assert.deepEqual(plan('can you ping github.com'), [['net.ping', { host: 'github.com' }]]);
  assert.equal(grammar().parse('ping'), null, 'ping at nothing is not guessed');
});

test('compare two files', () => {
  assert.deepEqual(plan('compare notes.txt and notes backup.txt in documents'), [
    ['files.compare', { a: 'notes.txt in documents', place: 'documents', b: 'notes backup.txt' }],
  ]);
  assert.deepEqual(plan('diff a.txt b.txt'), [['files.compare', { a: 'a.txt', b: 'b.txt' }]]);
  assert.equal(grammar().parse('are a.txt and b.txt the same')?.steps[0]?.skill, 'files.compare');
  assert.equal(grammar().parse('compare prices and quality'), null, 'two ideas are not two files');
});

test('search inside files — and "find X in documents" is still a file search', () => {
  assert.deepEqual(plan('search inside documents for invoice'), [['code.search', { path: 'documents', query: 'invoice' }]]);
  assert.equal(grammar().parse('find TODO inside documents')?.steps[0]?.skill, 'code.search');
  assert.equal(grammar().parse('find notes.txt in documents')?.steps[0]?.skill, 'files.find');
  assert.equal(grammar().parse('search for cats')?.steps[0]?.skill, 'web.search');
});

// ---- behaviour -----------------------------------------------------------------------------

function pingWith(result: unknown) {
  const platform = { pingHost: async () => result } as unknown as Platform;
  const skill = createNetworkSkills(platform).find((s) => s.id === 'net.ping')!;
  return (host: string) => skill.run({ host }, {} as never) as Promise<{ ok: boolean; message?: string; error?: string }>;
}

test('ping reports what came back, how fast, and what was lost', async () => {
  const ok = await pingWith({ address: '142.250.1.1', sent: 4, received: 3, timesMs: [10, 12, 14] })('google.com');
  assert.match(String(ok.message), /google\.com \(142\.250\.1\.1\): 3 of 4 replied, about 12 ms \(10–14 ms\)\. 1 lost\./);
});

test('no reply is a plain answer, not an error', async () => {
  const r = await pingWith({ address: '1.2.3.4', sent: 4, received: 0, timesMs: [] })('1.2.3.4');
  assert.equal(r.ok, true);
  assert.match(String(r.message), /no reply from any of 4/);
});

test('a URL is reduced to its host, and a refusal from the machine is passed on', async () => {
  let seen = '';
  const platform = {
    pingHost: async (h: string) => {
      seen = h;
      throw 'I couldn\'t find “nope.invalid” — is the name right?';
    },
  } as unknown as Platform;
  const skill = createNetworkSkills(platform).find((s) => s.id === 'net.ping')!;
  const r = (await skill.run({ host: 'https://nope.invalid/path?x=1' }, {} as never)) as { ok: boolean; error?: string };
  assert.equal(seen, 'nope.invalid');
  assert.equal(r.ok, false);
  assert.match(String(r.error), /is the name right/);
});

const file = (path: string): FileEntry => ({ path, name: path.split(/[\\/]/).pop()!, ext: 'txt', isDirectory: false }) as FileEntry;

function comparer(texts: Record<string, string>, identical: boolean, sizes: [number, number] = [10, 10]) {
  const platform = {
    knownFolder: async () => 'C:\\U\\Documents',
    listDir: async () => Object.keys(texts).map(file),
    compareFiles: async () => ({ identical, sizeA: sizes[0], sizeB: sizes[1] }),
    readTextFile: async (p: string) => {
      if (texts[p] === undefined) throw new Error('not text');
      return texts[p]!;
    },
  } as unknown as Platform;
  const skill = createFileToolsSkills(platform).find((s) => s.id === 'files.compare')!;
  return (a: string, b: string, place?: string) =>
    skill.run({ a, b, ...(place ? { place } : {}) }, {} as never) as Promise<{ ok: boolean; message?: string; error?: string }>;
}

test('identical files say so', async () => {
  const r = await comparer({ 'C:\\U\\Documents\\a.txt': 'x', 'C:\\U\\Documents\\b.txt': 'x' }, true)('a.txt in documents', 'b.txt', 'documents');
  assert.match(String(r.message), /a\.txt and b\.txt are identical/);
});

test('different text files show where, not a wall', async () => {
  const a = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
  const b = a.replace('line 3', 'LINE THREE').replace('line 9', 'LINE NINE');
  const r = await comparer({ 'C:\\U\\Documents\\a.txt': a, 'C:\\U\\Documents\\b.txt': b }, false, [100, 104])('a.txt in documents', 'b.txt', 'documents');
  assert.match(String(r.message), /are different/);
  assert.match(String(r.message), /2 lines differ/);
  assert.match(String(r.message), /line 4: “line 3” → “LINE THREE”/);
});

test('comparing a file with itself is refused', async () => {
  const r = await comparer({ 'C:\\U\\Documents\\a.txt': 'x' }, true)('a.txt in documents', 'a.txt', 'documents');
  assert.equal(r.ok, false);
  assert.match(String(r.error), /same file twice/);
});

test('a binary pair falls back to the size comparison', async () => {
  const r = await comparer({}, false, [10, 12])('C:\\x\\a.bin', 'C:\\x\\b.bin');
  assert.match(String(r.message), /are different \(10 B vs 12 B\)\.$/);
});
