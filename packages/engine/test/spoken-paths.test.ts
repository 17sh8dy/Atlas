/**
 * "delete atlas-secret-test.txt in documents", "move report.pdf to downloads",
 * "create a folder called Projects on my desktop" — the file skills taking what
 * people say, not just a full path.
 */

import { assert, test } from 'vitest';
import type { FileEntry, Platform, Skill } from '@atlas/core';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { WorkingMemory } from '../src/working-memory';
import { withSpokenPaths } from '../src/skills/spoken-paths';

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

// ---- understanding -----------------------------------------------------------------------

test('delete, rename, move, copy and read by name', () => {
  assert.deepEqual(plan('delete atlas-secret-test.txt in documents'), [['files.delete', { path: 'atlas-secret-test.txt in documents' }]]);
  assert.deepEqual(plan('rename notes.txt in documents to old notes.txt'), [
    ['files.rename', { path: 'notes.txt in documents', newName: 'old notes.txt' }],
  ]);
  assert.deepEqual(plan('move report.pdf to downloads'), [['files.move', { path: 'report.pdf', destDir: 'downloads' }]]);
  assert.deepEqual(plan('copy report.pdf in documents to my desktop'), [
    ['files.copy', { path: 'report.pdf in documents', destDir: 'my desktop' }],
  ]);
  assert.deepEqual(plan('read todo.txt in documents'), [['files.readText', { path: 'todo.txt in documents' }]]);
});

test('create a folder or a file by name and place', () => {
  assert.deepEqual(plan('create a folder called Projects on my desktop'), [['files.createFolder', { path: 'Projects in desktop' }]]);
  assert.deepEqual(plan('create a text file called todo in documents with buy milk'), [
    ['files.create', { path: 'todo.txt in documents', content: 'buy milk' }],
  ]);
});

test('words that are not a file are left alone', () => {
  assert.equal(grammar().parse('delete the last message'), null);
  assert.notEqual(grammar().parse('copy hello to the clipboard')?.steps[0]?.skill, 'files.copy');
  assert.notEqual(grammar().parse('move the window to the left')?.steps[0]?.skill, 'files.move');
});

// ---- behaviour ------------------------------------------------------------------------------

const file = (path: string, isDirectory = false): FileEntry =>
  ({ path, name: path.split(/[\\/]/).pop()!, ext: '', isDirectory }) as FileEntry;

function setup() {
  const docs = 'C:\\U\\Documents';
  const dl = 'C:\\U\\Downloads';
  const calls: Array<Record<string, unknown>> = [];
  const platform = {
    knownFolder: async (id: string) => ({ documents: docs, downloads: dl, desktop: 'C:\\U\\Desktop', home: 'C:\\U' })[id] ?? 'C:\\U',
    listDir: async (p: string) => (p === docs ? [file(`${docs}\\a.txt`), file(`${docs}\\b.txt`), file(`${docs}\\dup.txt`)] : p === dl ? [file(`${dl}\\dup.txt`)] : []),
    searchFiles: async () => [],
  } as unknown as Platform;
  const base = (id: string, risk: Skill['risk'] = 'confirm'): Skill => ({
    id,
    label: id,
    icon: 'x',
    domain: 'files',
    description: 'does a thing',
    risk,
    params: {},
    async run(args) {
      calls.push({ id, ...args });
      return { ok: true, message: 'done' };
    },
  });
  const skills = Object.fromEntries(
    withSpokenPaths(
      ['files.delete', 'files.rename', 'files.move', 'files.copy', 'files.readText', 'files.create', 'files.createFolder'].map((i) => base(i, i === 'files.readText' ? 'safe' : 'confirm')),
      platform,
    ).map((s) => [s.id, s]),
  ) as Record<string, Skill>;
  const run = (id: string, args: Record<string, unknown>) => skills[id]!.run(args, {} as never) as Promise<{ ok: boolean; error?: string }>;
  return { calls, run, skills, docs, dl };
}

test('a spoken name becomes the real path before anything is touched', async () => {
  const { run, calls, docs } = setup();
  await run('files.delete', { path: 'a.txt in documents' });
  assert.deepEqual(calls, [{ id: 'files.delete', path: `${docs}\\a.txt` }]);
});

test('a full path passes straight through, unresolved and unchanged', async () => {
  const { run, calls } = setup();
  await run('files.delete', { path: 'D:\\Anything\\x.txt' });
  assert.deepEqual(calls, [{ id: 'files.delete', path: 'D:\\Anything\\x.txt' }]);
});

test('an ambiguous or missing name touches nothing, and says why', async () => {
  const { run, calls } = setup();
  const amb = await run('files.delete', { path: 'dup.txt' });
  assert.equal(amb.ok, false);
  assert.match(String(amb.error), /more than one thing/);
  const none = await run('files.delete', { path: 'ghost.txt' });
  assert.equal(none.ok, false);
  assert.equal(calls.length, 0);
});

test('a destination in words resolves too', async () => {
  const { run, calls, docs, dl } = setup();
  await run('files.move', { path: 'a.txt in documents', destDir: 'downloads' });
  assert.deepEqual(calls, [{ id: 'files.move', path: `${docs}\\a.txt`, destDir: dl }]);
});

test('a new folder or file is a name inside a place', async () => {
  const { run, calls } = setup();
  await run('files.createFolder', { path: 'Projects in desktop' });
  await run('files.create', { path: 'todo.txt in documents', content: 'x' });
  assert.deepEqual(calls[0], { id: 'files.createFolder', path: 'C:\\U\\Desktop\\Projects' });
  assert.deepEqual(calls[1], { id: 'files.create', path: 'C:\\U\\Documents\\todo.txt', content: 'x' });
  const noPlace = await run('files.createFolder', { path: 'Projects' });
  assert.equal(noPlace.ok, false);
  const bad = await run('files.createFolder', { path: 'a<b in desktop' });
  assert.equal(bad.ok, false);
  assert.equal(calls.length, 2);
});

test('the cards say what will happen, in words', () => {
  const { skills } = setup();
  assert.equal(skills['files.delete']!.confirmAs?.({ path: 'a.txt in documents' }), 'send a.txt in documents to the Recycle Bin');
  assert.equal(skills['files.rename']!.confirmAs?.({ path: 'a.txt', newName: 'b.txt' }), 'rename a.txt to b.txt');
  assert.equal(skills['files.move']!.confirmAs?.({ path: 'a.txt', destDir: 'downloads' }), 'move a.txt into downloads');
  assert.equal(skills['files.readText']!.confirmAs, undefined, 'a safe skill has no card to word');
});
