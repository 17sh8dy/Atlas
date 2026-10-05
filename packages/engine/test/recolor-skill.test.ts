/**
 * "Switch up the entire app look to red. D:\Dev\ClickerGameTest" — with no model.
 *
 * Three layers, each against something real: the grammar (Brandon's own sentence and the look-alikes
 * that must NOT be claimed as a recolour), the skill on a real folder on disk (preview writes
 * nothing, run backs up then rewrites, undo restores byte for byte), and the safety rails
 * (approval is for the plan that was shown; a project that moved on is refused).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, assert, expect, test } from 'vitest';
import type { Platform } from '@atlas/core';
import { diskPlatform, snapshot } from './helpers/disk-platform';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { parseEditRequest, parseRecolorRequest, parseRecolorUndo } from '../src/planner/app-grammar';
import { WorkingMemory } from '../src/working-memory';
import { createRecolorSkills } from '../src/skills/recolor-skills';
import { parseHex, rgbToHsl, hueGap } from '../src/skills/recolor-plan';
import { templateById } from '../src/templates';

// ---------------------------------------------------------------- the grammar

const g = new Grammar();
g.addMany(createCoreGrammar(new WorkingMemory()));
g.addMany(createExtraGrammar());
const claimed = (text: string) => {
  const plan = g.parse(text);
  return plan ? { skills: plan.steps.map((s) => s.skill), args: plan.steps[0]!.args, intent: plan.intent } : null;
};

test("Brandon's sentence, word for word, is a recolour of that folder", () => {
  const out = claimed('Switch up the entire app look to red. D:\\Dev\\ClickerGameTest');
  expect(out).toMatchObject({ skills: ['project.recolor'], intent: 'recolor' });
  expect(out!.args).toEqual({ color: 'red', path: 'D:\\Dev\\ClickerGameTest' });
});

test('the ways people actually say it', () => {
  const cases: Array<[string, { color: string; path?: string }]> = [
    ['make the whole app red', { color: 'red' }],
    ['make the app blue', { color: 'blue' }],
    ['change the theme to green', { color: 'green' }],
    ['recolor my project purple', { color: 'purple' }],
    ['recolour D:\\Dev\\Game to dark blue', { color: 'blue', path: 'D:\\Dev\\Game' }],
    ['switch the look of the game to orange', { color: 'orange' }],
    ['turn the whole UI pink', { color: 'pink' }],
    ['change the colour scheme to teal in D:\\Dev\\Site', { color: 'teal', path: 'D:\\Dev\\Site' }],
    ['make D:\\Dev\\Game look red', { color: 'red', path: 'D:\\Dev\\Game' }],
  ];
  for (const [text, want] of cases) {
    expect(parseRecolorRequest(text), text).toEqual(want);
  }
});

test('things that are NOT a recolour of the whole project are left alone', () => {
  for (const text of [
    'make me a red clicker game', // a build
    'build a blue app in D:\\Dev\\X', // a build
    'make the button red', // one part
    'change the background to blue', // one part
    'make the title text green in D:\\Dev\\Game', // one part
    'what colour is the sky', // a question
    'is the app red?', // a question
    'open the red app', // no recolour verb with a colour target
    'set my wallpaper to blue', // not a project
  ]) {
    expect(parseRecolorRequest(text), text).toBeNull();
  }
});

test('undo phrasings', () => {
  for (const text of ['undo the recolor', 'undo the recolour', 'put the old colours back', 'revert the colour change', 'restore the original colors']) {
    expect(parseRecolorUndo(text), text).not.toBeNull();
  }
  expect(parseRecolorUndo('undo that')).toBeNull();
  expect(claimed('undo the recolor')).toMatchObject({ skills: ['project.recolorUndo'] });
});

test('an edit that is not a recolour goes to the developer agent, and only with a folder named', () => {
  expect(parseEditRequest('add a shop to D:\\Dev\\ClickerGameTest')).toEqual({
    goal: 'add a shop to D:\\Dev\\ClickerGameTest',
    path: 'D:\\Dev\\ClickerGameTest',
  });
  expect(parseEditRequest('fix the score bug in D:\\Dev\\Game.')?.path).toBe('D:\\Dev\\Game');
  expect(parseEditRequest('add a shop to my game')).toBeNull(); // no folder to point the agent at
  expect(parseEditRequest('edit D:\\notes\\todo.txt')).toBeNull(); // a file, not a project
  expect(parseEditRequest('why is D:\\Dev\\Game slow?')).toBeNull();
  // …and it never steals what a more specific rule already handles
  expect(claimed('open D:\\Dev\\Game')?.skills).not.toContain('devagent.run');
  expect(claimed('add a shop to D:\\Dev\\ClickerGameTest')).toMatchObject({ skills: ['devagent.run'], intent: 'edit-project' });
});

// ---------------------------------------------------------------- the skill, on a real folder

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'atlas-recolor-'));
  roots.push(root);
  const t = templateById('clicker')!;
  for (const f of t.files({ name: 'Clicker Game Test', id: 'clicker-game-test', pascal: 'ClickerGameTest', engines: [] })) {
    const target = join(root, ...f.path.split('/'));
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, f.content, 'utf8');
  }
  return root;
}

const skills = (p: Platform) => {
  const [recolor, undo] = createRecolorSkills(p);
  return { recolor: recolor!, undo: undo! };
};

const ctx = (approvedPreview?: string) => ({ ...(approvedPreview === undefined ? {} : { approvedPreview }) }) as never;

test('preview says what it will do and writes NOTHING', async () => {
  const root = project();
  const before = snapshot(root);
  const { recolor } = skills(diskPlatform());

  const p = await recolor.preview!({ path: root, color: 'red' }, ctx());
  assert.equal(p.kind, 'ask');
  if (p.kind !== 'ask') return;
  expect(p.question).toMatch(/Recolour .+ to red\?/);
  expect(p.detail).toMatch(/purple → red/);
  expect(p.detail).toMatch(/style\.css/);
  expect(p.detail).toMatch(/Left as they are/); // gold and green stay
  expect(p.detail).toMatch(/\.atlas-backup/);
  expect(p.fingerprint).toBeTruthy();

  expect(snapshot(root)).toEqual(before);
  expect(existsSync(join(root, '.atlas-backup'))).toBe(false);
});

test('run backs the originals up, rewrites the theme, and keeps the project working', async () => {
  const root = project();
  const before = snapshot(root);
  const { recolor } = skills(diskPlatform());
  const p = await recolor.preview!({ path: root, color: 'red' }, ctx());
  if (p.kind !== 'ask') throw new Error('expected a card');

  const r = await recolor.run({ path: root, color: 'red' }, ctx(p.fingerprint));
  assert.equal(r.ok, true, JSON.stringify(r));

  const css = readFileSync(join(root, 'style.css'), 'utf8');
  expect(css).not.toMatch(/#a855f7/i);
  // the accent is now red-hued, at the same lightness
  const accent = parseHex(/--purple:\s*(#[0-9a-f]{6})/i.exec(css)![1]!)!;
  expect(hueGap(rgbToHsl(accent).h, 0)).toBeLessThan(12);
  expect(rgbToHsl(accent).l).toBeGreaterThan(0.6);
  // semantic colours survive
  expect(css).toMatch(/--gold:\s*#fbbf24/i);
  expect(css).toMatch(/--good:\s*#34d399/i);
  // non-colour files were not touched, byte for byte
  expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(before['package.json']);
  expect(readFileSync(join(root, 'game.js'), 'utf8')).toBe(before['game.js']);

  // the originals are in the backup, exactly as they were
  const backups = readdirSync(join(root, '.atlas-backup'));
  expect(backups).toHaveLength(1);
  expect(readFileSync(join(root, '.atlas-backup', backups[0]!, 'style.css'), 'utf8')).toBe(before['style.css']);
});

test('undo puts every file back exactly, once; a second undo finds nothing', async () => {
  const root = project();
  const before = snapshot(root);
  const { recolor, undo } = skills(diskPlatform());
  const p = await recolor.preview!({ path: root, color: 'blue' }, ctx());
  if (p.kind !== 'ask') throw new Error('expected a card');
  await recolor.run({ path: root, color: 'blue' }, ctx(p.fingerprint));
  expect(snapshot(root)['style.css']).not.toBe(before['style.css']);

  const u = await undo.run({ path: root }, ctx());
  assert.equal(u.ok, true, JSON.stringify(u));
  for (const [path, text] of Object.entries(before)) {
    expect(readFileSync(join(root, ...path.split('/')), 'utf8'), path).toBe(text);
  }
  const again = await undo.run({ path: root }, ctx());
  expect(again.ok && again.message).toMatch(/no recolour to undo/);
});

test('two recolours, two undos, back to the original', async () => {
  const root = project();
  const before = snapshot(root);
  const { recolor, undo } = skills(diskPlatform());
  for (const color of ['red', 'green']) {
    const p = await recolor.preview!({ path: root, color }, ctx());
    if (p.kind !== 'ask') throw new Error('expected a card');
    await new Promise((r) => setTimeout(r, 1100)); // a backup folder per second
    await recolor.run({ path: root, color }, ctx(p.fingerprint));
  }
  await undo.run({ path: root }, ctx());
  await undo.run({ path: root }, ctx());
  expect(readFileSync(join(root, 'style.css'), 'utf8')).toBe(before['style.css']);
}, 15000);

test('an approval is for the plan that was shown: a project that changed is refused, untouched', async () => {
  const root = project();
  const { recolor } = skills(diskPlatform());
  const p = await recolor.preview!({ path: root, color: 'red' }, ctx());
  if (p.kind !== 'ask') throw new Error('expected a card');

  // the stylesheet changes between the card and the yes
  writeFileSync(join(root, 'style.css'), readFileSync(join(root, 'style.css'), 'utf8') + '\n.extra { color: #a855f7; }\n');
  const during = snapshot(root);

  const r = await recolor.run({ path: root, color: 'red' }, ctx(p.fingerprint));
  assert.equal(r.ok, false);
  expect(!r.ok && r.error).toMatch(/changed after I showed you/);
  expect(snapshot(root)).toEqual(during);
  expect(existsSync(join(root, '.atlas-backup'))).toBe(false);
});

test('honest about what it cannot do', async () => {
  const root = project();
  const { recolor } = skills(diskPlatform());
  // already that colour
  const p1 = await recolor.preview!({ path: root, color: 'purple' }, ctx());
  expect(p1).toMatchObject({ kind: 'nothing' });
  // a colour it does not know
  const p2 = await recolor.preview!({ path: root, color: 'chartreuse-ish' }, ctx());
  expect(p2).toMatchObject({ kind: 'refuse' });
  // a folder with no colours in it
  const empty = mkdtempSync(join(tmpdir(), 'atlas-recolor-empty-'));
  roots.push(empty);
  writeFileSync(join(empty, 'a.css'), 'a { margin: 0 }');
  const p3 = await recolor.preview!({ path: empty, color: 'red' }, ctx());
  expect(p3).toMatchObject({ kind: 'nothing' });
  expect(p3.kind === 'nothing' && p3.message).toMatch(/needs a model/);
});
