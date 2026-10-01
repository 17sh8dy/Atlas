/**
 * "What is the largest folder in D:\Dev?" — a question Atlas can answer from the
 * disk, and which used to be sent to a language model that was not needed.
 */

import { assert, test } from 'vitest';
import type { Platform } from '@atlas/core';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { WorkingMemory } from '../src/working-memory';
import { createStorageSkills } from '../src/skills/storage-skills';

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

test('the question, in the words it was asked', () => {
  assert.deepEqual(plan('What is the largest folder in: D:\\Dev?'), [['storage.largestFolders', { path: 'D:\\Dev' }]]);
  assert.deepEqual(plan('biggest folder in my downloads'), [['storage.largestFolders', { path: 'downloads' }]]);
  assert.deepEqual(plan('which folder in documents takes the most space'), [['storage.largestFolders', { path: 'documents' }]]);
  assert.deepEqual(plan('what is taking up the most space in D:\\Dev'), [['storage.largestFolders', { path: 'D:\\Dev' }]]);
  // files are still files
  assert.equal(grammar().parse('what are the largest files in my downloads folder')?.steps[0]?.skill, 'storage.largestFiles');
});

function run(result: unknown) {
  const shown: unknown[] = [];
  const platform = {
    knownFolder: async () => 'C:\\U\\Downloads',
    largestSubfolders: async () => result,
  } as unknown as Platform;
  const skill = createStorageSkills(platform).find((s) => s.id === 'storage.largestFolders')!;
  return skill.run({ path: 'D:\\Dev' }, { showResults: (r: unknown) => shown.push(r) } as never).then((r) => ({ r: r as { ok: boolean; message?: string }, shown }));
}

const GB = 1024 ** 3;

test('it names the biggest and its share, and lists the rest', async () => {
  const { r, shown } = await run({
    folders: [
      { name: 'Atlas', path: 'D:\\Dev\\Atlas', sizeBytes: 6 * GB, fileCount: 120_000 },
      { name: 'NovaCut', path: 'D:\\Dev\\NovaCut', sizeBytes: 2 * GB, fileCount: 40_000 },
    ],
    looseBytes: 0,
    totalBytes: 8 * GB,
    truncated: false,
  });
  assert.equal(r.ok, true);
  assert.match(String(r.message), /largest folder in D:\\Dev is Atlas: 6\.0 GB \(75% of 8\.0 GB\)/);
  assert.equal(shown.length, 1);
});

test('a scan that was cut short says the answer is a lower bound', async () => {
  const { r } = await run({ folders: [{ name: 'Big', path: 'D:\\Dev\\Big', sizeBytes: GB, fileCount: 1 }], looseBytes: 0, totalBytes: GB, truncated: true });
  assert.match(String(r.message), /at least that/);
});

test('a folder with no subfolders says so', async () => {
  const { r } = await run({ folders: [], looseBytes: 5, totalBytes: 5, truncated: false });
  assert.match(String(r.message), /no subfolders/);
});
