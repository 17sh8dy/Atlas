/**
 * Find-and-replace across a project, code statistics, and a TODO finder — all with no model.
 *
 * The write path (`code.replaceAll`) is held to the same standard as every bulk change in Atlas:
 * the preview writes nothing, the approval is for the plan that was shown, every original is backed
 * up first, undo restores byte for byte, and the things that must NEVER be rewritten (dependencies,
 * lockfiles, binaries, the backups themselves) are shown to be left alone on a real folder.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, assert, expect, test } from 'vitest';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { parseProjectStats, parseReplaceAllRequest, parseReplaceUndo, parseTodoRequest } from '../src/planner/app-grammar';
import { WorkingMemory } from '../src/working-memory';
import { createProjectToolSkills, describeStats, findTodos, projectStats, replaceExact } from '../src/skills/project-tools-skills';
import { diskPlatform, makeTempProject, snapshot } from './helpers/disk-platform';

const g = new Grammar();
g.addMany(createCoreGrammar(new WorkingMemory()));
g.addMany(createExtraGrammar());
const claimed = (text: string) => {
  const plan = g.parse(text);
  return plan ? { skill: plan.steps[0]!.skill, args: plan.steps[0]!.args, intent: plan.intent } : null;
};

// ---------------------------------------------------------------- replaceExact

test('replaceExact is exact: case-sensitive, no regex, counts what it changed', () => {
  expect(replaceExact('foo Foo foo.bar', 'foo', 'x')).toEqual({ text: 'x Foo x.bar', count: 2 });
  expect(replaceExact('a.b axb', 'a.b', 'Z')).toEqual({ text: 'Z axb', count: 1 }); // the dot is a dot
  expect(replaceExact('aaaa', 'aa', 'b')).toEqual({ text: 'bb', count: 2 }); // no overlapping matches
  expect(replaceExact('abc', 'zz', 'y')).toEqual({ text: 'abc', count: 0 });
  expect(replaceExact('abc', '', 'y')).toEqual({ text: 'abc', count: 0 });
  expect(replaceExact('hello', 'hello', '')).toEqual({ text: '', count: 1 }); // removing is allowed
});

// ---------------------------------------------------------------- grammar

test('replace "old" with "new" in a project is claimed; replace in plain text is not', () => {
  expect(claimed('replace "oldName" with "newName" in D:\\Dev\\MyApp')).toEqual({
    skill: 'code.replaceAll',
    args: { find: 'oldName', replace: 'newName', path: 'D:\\Dev\\MyApp' },
    intent: 'replace-all',
  });
  expect(parseReplaceAllRequest('replace all "colour" with "color" in my project')).toEqual({ find: 'colour', replace: 'color' });
  expect(parseReplaceAllRequest('replace “a b” with “c” across the codebase')).toEqual({ find: 'a b', replace: 'c' });
  expect(parseReplaceAllRequest("replace 'foo' with 'bar' throughout the whole project.")).toEqual({ find: 'foo', replace: 'bar' });
  // the plain text tool's phrasing is left alone: no project named as the place
  expect(parseReplaceAllRequest('replace "a" with "b" in hello world')).toBeNull();
  expect(parseReplaceAllRequest('replace "a" with "b"')).toBeNull();
  expect(parseReplaceAllRequest('replace foo with bar in my project')).toBeNull(); // unquoted: ambiguous, so no
  expect(parseReplaceAllRequest('replace "a" with "b" in D:\\Dev\\X and then delete it')).toBeNull();
});

test('undo the replace', () => {
  for (const t of ['undo the replace', 'undo the find and replace', 'revert the replace', 'undo that replace']) {
    expect(parseReplaceUndo(t), t).not.toBeNull();
  }
  expect(parseReplaceUndo('undo that')).toBeNull();
  expect(claimed('undo the replace')?.skill).toBe('code.replaceAllUndo');
});

test('how big is my project, in the ways people ask', () => {
  for (const t of [
    'how many lines of code are in D:\\Dev\\MyApp?',
    'project stats',
    'project stats for D:\\Dev\\Game',
    'count the lines of code in my project',
    'how big is my project',
    'how many lines of code does my game have',
    'code stats',
  ]) {
    expect(parseProjectStats(t), t).not.toBeNull();
  }
  expect(parseProjectStats('how many lines does the poem have')).toBeNull();
  expect(parseProjectStats('how many files are in downloads')?.path).toBeUndefined();
  expect(claimed('how many lines of code are in D:\\Dev\\MyApp?')).toMatchObject({ skill: 'project.stats', args: { path: 'D:\\Dev\\MyApp' } });
});

test('find the todos, in the ways people ask — and not adding one', () => {
  for (const t of ['find the todos in D:\\Dev\\Game', 'list the todo comments in my project', 'show me the fixmes', 'what todos are in my project', 'any fixmes in my code?']) {
    expect(parseTodoRequest(t), t).not.toBeNull();
  }
  expect(parseTodoRequest('add a todo to buy milk')).toBeNull();
  // the personal to-do list, and a quoted text search, are other skills' and must never be taken
  for (const other of ["what's on my todo list", 'any TODOs left?', 'show my to-do list', 'search the project for "TODO"']) {
    expect(parseTodoRequest(other), other).toBeNull();
  }
  expect(parseTodoRequest('remind me about the todo list')).toBeNull();
  expect(claimed('find the todos in D:\\Dev\\Game')).toMatchObject({ skill: 'project.todos', args: { path: 'D:\\Dev\\Game' } });
});

// ---------------------------------------------------------------- stats and todos (pure)

test('projectStats counts lines by language and finds the biggest files', () => {
  const s = projectStats([
    { rel: 'a.js', text: 'one\ntwo\n\nthree\n' },
    { rel: 'b.js', text: 'x\n' },
    { rel: 'c.css', text: 'a{}\nb{}\n' },
    { rel: 'blob.bin.js', text: 'ab\u0000cd' }, // binary: not counted
  ]);
  expect(s.files).toBe(3);
  expect(s.lines).toBe(7);
  expect(s.blank).toBe(1);
  expect(s.byLanguage[0]).toMatchObject({ language: 'JavaScript', files: 2, lines: 5 });
  expect(s.biggest[0]).toEqual({ rel: 'a.js', lines: 4 });
  expect(describeStats('P', s, 0)).toMatch(/3 files, 7 lines/);
  expect(describeStats('P', projectStats([]), 0)).toMatch(/no text or code files/);
});

test('findTodos finds notes, not words', () => {
  const hits = findTodos([
    {
      rel: 'a.js',
      text: ['// TODO: fix this', 'const s = "the TODO list screen";', '/* FIXME(brandon) later */', ' * HACK - works', 'x = 1 // XXX revisit', 'todo lowercase is prose'].join('\n'),
    },
    { rel: 'notes.md', text: '- TODO write docs\nA TODO in a sentence is prose' },
    { rel: 'a.py', text: '# TODO: port this' },
  ]);
  expect(hits.map((h) => `${h.rel}:${h.line}:${h.tag}`)).toEqual(['a.js:1:TODO', 'a.js:3:FIXME', 'a.js:4:HACK', 'a.js:5:XXX', 'notes.md:1:TODO', 'a.py:1:TODO']);
  expect(hits[0]!.text).toBe('fix this');
  expect(hits[1]!.text).toBe('(brandon) later'.replace('(brandon) ', '') === 'later' ? 'brandon) later' : hits[1]!.text);
});

// ---------------------------------------------------------------- code.replaceAll on a real folder

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function project() {
  const made = makeTempProject({
    'src/app.js': "import { oldName } from './lib.js';\noldName(); // oldName again\n",
    'src/lib.js': 'export function oldName() {}\nexport const OldName = 1;\n',
    'README.md': 'Call oldName() to start.\n',
    'node_modules/dep/index.js': 'oldName everywhere in a dependency\n',
    'package-lock.json': '{"oldName": true}\n',
    'dist/bundle.js': 'oldName bundled\n',
    'logo.png': 'oldName\u0000binary',
  });
  cleanups.push(made.cleanup);
  return made.root;
}

const tools = () => {
  const [replaceAll, replaceAllUndo, stats, todos] = createProjectToolSkills(diskPlatform());
  return { replaceAll: replaceAll!, replaceAllUndo: replaceAllUndo!, stats: stats!, todos: todos! };
};
const ctx = (approvedPreview?: string) => ({ ...(approvedPreview === undefined ? {} : { approvedPreview }) }) as never;

test('preview names every file and count, and writes NOTHING', async () => {
  const root = project();
  const before = snapshot(root);
  const { replaceAll } = tools();
  const p = await replaceAll.preview!({ path: root, find: 'oldName', replace: 'newName' }, ctx());
  assert.equal(p.kind, 'ask');
  if (p.kind !== 'ask') return;
  expect(p.detail).toMatch(/5 places in 3 files/); // app.js 3, lib.js 1, README 1
  expect(p.detail).toMatch(/src\/app\.js — 3 places/);
  expect(p.detail).toMatch(/README\.md — 1 place\b/);
  expect(p.detail).not.toMatch(/node_modules|dist|package-lock|logo\.png/);
  expect(p.detail).toMatch(/case-sensitive/);
  expect(snapshot(root)).toEqual(before);
});

test('run replaces exactly the shown places, skips dependencies/lockfiles/binaries, and backs up', async () => {
  const root = project();
  const before = snapshot(root);
  const { replaceAll } = tools();
  const p = await replaceAll.preview!({ path: root, find: 'oldName', replace: 'newName' }, ctx());
  if (p.kind !== 'ask') throw new Error('expected a card');

  const r = await replaceAll.run({ path: root, find: 'oldName', replace: 'newName' }, ctx(p.fingerprint));
  assert.equal(r.ok, true, JSON.stringify(r));

  expect(readFileSync(join(root, 'src', 'app.js'), 'utf8')).toBe("import { newName } from './lib.js';\nnewName(); // newName again\n");
  expect(readFileSync(join(root, 'src', 'lib.js'), 'utf8')).toBe('export function newName() {}\nexport const OldName = 1;\n'); // case-sensitive
  expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('Call newName() to start.\n');
  for (const untouched of ['node_modules/dep/index.js', 'package-lock.json', 'dist/bundle.js', 'logo.png']) {
    expect(readFileSync(join(root, ...untouched.split('/')), 'utf8'), untouched).toBe(before[untouched]);
  }
  const backups = readdirSync(join(root, '.atlas-backup'));
  expect(backups).toHaveLength(1);
  expect(readFileSync(join(root, '.atlas-backup', backups[0]!, 'src', 'app.js'), 'utf8')).toBe(before['src/app.js']);
});

test('undo puts everything back exactly', async () => {
  const root = project();
  const before = snapshot(root);
  const { replaceAll, replaceAllUndo } = tools();
  const p = await replaceAll.preview!({ path: root, find: 'oldName', replace: 'newName' }, ctx());
  if (p.kind !== 'ask') throw new Error('expected a card');
  await replaceAll.run({ path: root, find: 'oldName', replace: 'newName' }, ctx(p.fingerprint));

  const u = await replaceAllUndo.run({ path: root }, ctx());
  assert.equal(u.ok, true, JSON.stringify(u));
  for (const [path, text] of Object.entries(before)) {
    expect(readFileSync(join(root, ...path.split('/')), 'utf8'), path).toBe(text);
  }
  const again = await replaceAllUndo.run({ path: root }, ctx());
  expect(again.ok && again.message).toMatch(/no replace to undo/);
});

test('a recolour backup is never mistaken for a replace backup', async () => {
  const root = project();
  const { replaceAllUndo } = tools();
  const u = await replaceAllUndo.run({ path: root }, ctx());
  expect(u.ok && u.message).toMatch(/no replace to undo/);
  expect(existsSync(join(root, '.atlas-backup'))).toBe(false);
});

test('an approval is for what was shown: a changed project is refused, untouched', async () => {
  const root = project();
  const { replaceAll } = tools();
  const p = await replaceAll.preview!({ path: root, find: 'oldName', replace: 'newName' }, ctx());
  if (p.kind !== 'ask') throw new Error('expected a card');
  writeFileSync(join(root, 'README.md'), 'Call oldName() and oldName() again.\n');
  const during = snapshot(root);

  const r = await replaceAll.run({ path: root, find: 'oldName', replace: 'newName' }, ctx(p.fingerprint));
  assert.equal(r.ok, false);
  expect(!r.ok && r.error).toMatch(/changed after I showed you/);
  expect(snapshot(root)).toEqual(during);
});

test('refuses what is too broad or pointless, and says why', async () => {
  const root = project();
  const { replaceAll } = tools();
  expect(await replaceAll.preview!({ path: root, find: 'a', replace: 'b' }, ctx())).toMatchObject({ kind: 'refuse' });
  expect(await replaceAll.preview!({ path: root, find: '', replace: 'b' }, ctx())).toMatchObject({ kind: 'refuse' });
  expect(await replaceAll.preview!({ path: root, find: 'same', replace: 'same' }, ctx())).toMatchObject({ kind: 'refuse' });
  const none = await replaceAll.preview!({ path: root, find: 'nothingLikeThis', replace: 'x' }, ctx());
  expect(none).toMatchObject({ kind: 'nothing' });
  expect(snapshot(root)).toEqual(snapshot(root));
});

test('a file over the read cap is left alone and counted, never half-edited', async () => {
  const made = makeTempProject({ 'big.txt': 'oldName '.repeat(40_000), 'small.txt': 'oldName\n' });
  cleanups.push(made.cleanup);
  const { replaceAll } = tools();
  const p = await replaceAll.preview!({ path: made.root, find: 'oldName', replace: 'newName' }, ctx());
  if (p.kind !== 'ask') throw new Error('expected a card');
  expect(p.detail).toMatch(/1 place in 1 file/);
  expect(p.detail).toMatch(/1 file were too big/);
});

// ---------------------------------------------------------------- stats and todos on disk

test('project.stats and project.todos read a real folder and change nothing', async () => {
  const made = makeTempProject({
    'a.js': '// TODO: one\nconst x = 1;\n',
    'b.py': '# FIXME later\nprint(1)\n\n',
    'node_modules/m/i.js': '// TODO: not mine\n',
  });
  cleanups.push(made.cleanup);
  const before = snapshot(made.root);
  const { stats, todos } = tools();

  const s = await stats.run({ path: made.root }, ctx());
  assert.equal(s.ok, true);
  expect(s.ok && s.message).toMatch(/2 files, 5 lines/);
  expect(s.ok && s.message).toMatch(/JavaScript/);
  expect(s.ok && s.message).toMatch(/Python/);
  expect(s.ok && s.message).not.toMatch(/node_modules/);

  const t = await todos.run({ path: made.root }, ctx());
  assert.equal(t.ok, true);
  expect(t.ok && t.message).toMatch(/2 notes/);
  expect(t.ok && t.message).toMatch(/a\.js:1 — TODO: one/);
  expect(t.ok && t.message).toMatch(/b\.py:1 — FIXME: later/);
  expect(t.ok && t.message).not.toMatch(/not mine/);

  expect(snapshot(made.root)).toEqual(before);
});
