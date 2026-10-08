/**
 * "Build me a clicker game", with no model.
 *
 * Three layers, each checked for real rather than by reading the code:
 *  - the template: written to an actual folder, every .js file syntax-checked by Node, and the
 *    generated project's own test.js run (so the game's maths is exercised, not assumed);
 *  - the skill: against an in-memory disk, including the refusals;
 *  - the grammar: the sentences Brandon actually typed, and the look-alikes that must not be claimed.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, expect, test } from 'vitest';
import type { PathInfo, Platform } from '@atlas/core';
import { APP_TEMPLATES, chooseTemplate, displayNameFor, idFor, templateById } from '../src/templates';
import { createAppScaffoldSkills } from '../src/skills/app-scaffold-skills';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { parseAgentBuildRequest, parseBuildRequest } from '../src/planner/app-grammar';
import { WorkingMemory } from '../src/working-memory';

// ---------------------------------------------------------------- the templates, on a real disk

function writeProject(templateId: string, name = 'Void Clicker') {
  const root = mkdtempSync(join(tmpdir(), 'atlas-template-'));
  const template = templateById(templateId)!;
  for (const file of template.files({ name, id: idFor(name) })) {
    const target = join(root, ...file.path.split('/'));
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, file.content, 'utf8');
  }
  return root;
}

test('every template writes files with no placeholder left in them', () => {
  for (const template of APP_TEMPLATES) {
    const files = template.files({ name: 'Void Clicker', id: 'void-clicker' });
    assert.isAbove(files.length, 1, template.id);
    for (const file of files) {
      assert.notMatch(file.content, /\{\{(?:NAME|ID)\}\}/, `${template.id}/${file.path}`);
      assert.isAbove(file.content.length, 10, `${template.id}/${file.path} is empty`);
    }
    // the launch target is one of the files that is written
    assert.include(
      files.map((f) => f.path),
      template.launch,
      `${template.id} launches a file it does not write`,
    );
  }
});

test('the clicker project is real JavaScript, and its own test passes', () => {
  const root = writeProject('clicker');
  try {
    for (const file of readdirSync(root).filter((f) => f.endsWith('.js'))) {
      // throws (and fails the test) on a syntax error in game.js, ui.js, main.js or test.js
      execFileSync(process.execPath, ['--check', join(root, file)]);
    }
    const out = execFileSync(process.execPath, ['test.js'], { cwd: root, encoding: 'utf8' });
    assert.match(out, /\d+ checks passed/);
    assert.notMatch(out, /fail|error/i);
    // package.json is valid JSON and wires up the two scripts the README promises
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts.test, 'node test.js');
    assert.equal(pkg.main, 'main.js');
    assert.equal(pkg.name, 'void-clicker');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the starters are valid too', () => {
  for (const id of ['desktop', 'website']) {
    const root = writeProject(id, 'My Thing');
    try {
      for (const file of readdirSync(root).filter((f) => f.endsWith('.js'))) {
        execFileSync(process.execPath, ['--check', join(root, file)]);
      }
      if (id === 'desktop') JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      assert.match(readFileSync(join(root, 'index.html'), 'utf8'), /My Thing/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('the game reaches trillions at a human pace, not instantly and not never', () => {
  // A cheap pacing check on the real game.js: buy greedily with a steady click rate and see
  // when 1 trillion lifetime essence arrives. Too fast (< 5 min) or too slow (> 6 h) is a bug in
  // the balance, not a matter of taste.
  const root = writeProject('clicker');
  try {
    const script = `
      const G = require('./game.js');
      const g = G.createGame({ now: 0 });
      let t = 0;
      const dt = 1;
      let reached = null;
      while (t < 6 * 3600) {
        // 4 clicks a second, and spend everything on the best-value generator or upgrade
        for (let c = 0; c < 4; c++) g.click(t * 1000);
        g.tick(dt, t * 1000);
        let bought = true;
        while (bought) {
          bought = false;
          for (const u of G.UPGRADES) { if (g.upgradeAvailable(u) && g.state.essence >= u.cost) { if (g.buyUpgrade(u.id)) bought = true; } }
          let best = -1, bestRatio = 0;
          for (let i = 0; i < G.GENERATORS.length; i++) {
            const price = g.price(i, 1);
            if (price <= g.state.essence) {
              const ratio = g.perUnit(i) / price;
              if (ratio > bestRatio) { bestRatio = ratio; best = i; }
            }
          }
          if (best >= 0 && g.buy(best, 1)) bought = true;
        }
        t += dt;
        if (reached === null && g.state.all >= 1e12) { reached = t; break; }
      }
      console.log(JSON.stringify({ reached }));
    `;
    const out = execFileSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8' });
    const { reached } = JSON.parse(out.trim().split('\n').pop()!);
    assert.isNotNull(reached, 'never reached 1 trillion in six hours');
    // Measured at about 1h50m with this player; the bounds leave room for retuning, not for a wall.
    assert.isAbove(reached, 3600, `1 trillion after only ${reached}s is too fast`);
    assert.isBelow(reached, 4 * 3600, `1 trillion took ${reached}s, which is a wall`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

// ---------------------------------------------------------------- the skill, on an in-memory disk

function memoryDisk(existing: Record<string, string[] | 'file'> = {}, failOn?: (path: string) => boolean) {
  const dirs = new Map<string, string[]>(); // folder -> child names
  const files = new Map<string, string>();
  const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
  for (const [p, v] of Object.entries(existing)) {
    if (v === 'file') files.set(norm(p), '');
    else dirs.set(norm(p), v);
  }
  const platform: Platform = {
    id: 'test',
    capabilities: async () => ['devtools'],
    pathInfo: async (p): Promise<PathInfo> => {
      const key = norm(p);
      if (dirs.has(key)) return { path: p, name: p, ext: '', isDirectory: true, sizeBytes: 0 };
      if (files.has(key)) return { path: p, name: p, ext: '', isDirectory: false, sizeBytes: 0 };
      throw new Error('no such path');
    },
    listDir: async (p) => (dirs.get(norm(p)) ?? []).map((n) => ({ name: n, path: p + '\\' + n, isDirectory: false, sizeBytes: 0 }) as never),
    createFolder: async (p) => {
      if (failOn?.(p)) throw new Error('That path is outside the folders Atlas can touch.');
      dirs.set(norm(p), []);
      return true;
    },
    createFile: async (p, content) => {
      if (failOn?.(p)) throw new Error('disk full');
      files.set(norm(p), content ?? '');
      return true;
    },
  };
  return { platform, files, dirs };
}

const sayCtx = () => ({ say: () => {}, confirm: async () => true });

test('app.scaffold writes the whole clicker project into a new folder', async () => {
  const { platform, files, dirs } = memoryDisk({ 'D:\\Dev': [] });
  const remembered: string[] = [];
  const skill = createAppScaffoldSkills(platform, { set: async (p) => void remembered.push(p) })[0]!;
  const result = await skill.run({ path: 'D:\\Dev\\Clicker', template: 'clicker' }, sayCtx());
  assert.isTrue(result.ok, result.error);
  assert.isTrue(dirs.has('d:\\dev\\clicker'));
  for (const f of ['index.html', 'game.js', 'ui.js', 'style.css', 'main.js', 'test.js', 'package.json', 'play.cmd']) {
    assert.isTrue(files.has(`d:\\dev\\clicker\\${f}`), f);
  }
  assert.include(files.get('d:\\dev\\clicker\\index.html')!, '<title>Clicker</title>');
  assert.deepEqual(remembered, ['D:\\Dev\\Clicker']);
  assert.equal((result.data as { launch: string }).launch, 'D:\\Dev\\Clicker\\Play.cmd');
});

test('app.scaffold takes a name, and a trailing slash does not matter', async () => {
  const { platform, files } = memoryDisk({ 'D:\\Dev': [] });
  const skill = createAppScaffoldSkills(platform)[0]!;
  const result = await skill.run({ path: 'D:\\Dev\\x\\', template: 'clicker', name: 'Night Orb' }, sayCtx());
  assert.isTrue(result.ok, result.error);
  assert.include(files.get('d:\\dev\\x\\index.html')!, 'Night Orb');
  assert.equal(JSON.parse(files.get('d:\\dev\\x\\package.json')!).name, 'night-orb');
});

test('app.scaffold refuses a folder that already has things in it, and writes nothing', async () => {
  const { platform, files } = memoryDisk({ 'D:\\Dev\\Mine': ['notes.txt'] });
  const skill = createAppScaffoldSkills(platform)[0]!;
  const result = await skill.run({ path: 'D:\\Dev\\Mine', template: 'clicker' }, sayCtx());
  assert.isFalse(result.ok);
  assert.match(result.error!, /already has files/);
  assert.equal(files.size, 0);
});

test('app.scaffold will use an existing EMPTY folder', async () => {
  const { platform, files } = memoryDisk({ 'D:\\Dev\\Empty': [] });
  const skill = createAppScaffoldSkills(platform)[0]!;
  const result = await skill.run({ path: 'D:\\Dev\\Empty', template: 'website' }, sayCtx());
  assert.isTrue(result.ok, result.error);
  assert.isTrue(files.has('d:\\dev\\empty\\index.html'));
});

test('app.scaffold refuses a path that is a file', async () => {
  const { platform } = memoryDisk({ 'D:\\Dev\\a.txt': 'file' });
  const skill = createAppScaffoldSkills(platform)[0]!;
  const result = await skill.run({ path: 'D:\\Dev\\a.txt', template: 'clicker' }, sayCtx());
  assert.isFalse(result.ok);
  assert.match(result.error!, /is a file/);
});

test('app.scaffold passes the "outside the folders" refusal through, so the Add It? card can appear', async () => {
  const { platform } = memoryDisk({}, () => true);
  const skill = createAppScaffoldSkills(platform)[0]!;
  const result = await skill.run({ path: 'E:\\Games\\Clicker', template: 'clicker' }, sayCtx());
  assert.isFalse(result.ok);
  // The executor's folder offer keys on exactly this sentence.
  assert.match(result.error!, /outside the folders Atlas can touch/i);
});

test('app.scaffold reports a half-written project honestly and deletes nothing', async () => {
  let n = 0;
  const { platform, files } = memoryDisk({ 'D:\\Dev': [] }, (p) => p.endsWith('.js') && ++n > 1);
  const skill = createAppScaffoldSkills(platform)[0]!;
  const result = await skill.run({ path: 'D:\\Dev\\Half', template: 'clicker' }, sayCtx());
  assert.isFalse(result.ok);
  assert.match(result.error!, /disk full/);
  assert.match(result.error!, /nothing was deleted/);
  assert.isAbove(files.size, 0);
});

test('app.scaffold asks like a confirm skill: it is never silent in Ask mode', () => {
  const skill = createAppScaffoldSkills({ id: 't', capabilities: async () => [] })[0]!;
  assert.equal(skill.risk, 'confirm');
  assert.match(skill.confirmAs!({ path: 'D:\\Dev\\Clicker', template: 'clicker' }), /clicker game .* in D:\\Dev\\Clicker/);
  assert.isTrue(skill.params!.path!.required);
});

// ---------------------------------------------------------------- the grammar

const g = new Grammar();
g.addMany(createCoreGrammar(new WorkingMemory()));
g.addMany(createExtraGrammar());
const skillsOf = (text: string) => g.parse(text)?.steps.map((s) => s.skill) ?? null;

test('Brandon\'s sentence builds a clicker game and asks where', () => {
  const text =
    'Build me a high quality clicker desktop app game, it must be a simple layout but it can get very heavy on math and with upgrades, etc';
  const plan = g.parse(text)!;
  expect(plan.intent).toBe('build-app');
  expect(plan.steps.map((s) => s.skill)).toEqual(['app.scaffold', 'dependency.installAll', 'project.check', 'project.play']);
  expect(plan.steps[0]!.args).toEqual({ template: 'clicker' }); // no path: the executor asks for it
});

test('the example Atlas prints for itself works without a model', () => {
  const plan = g.parse('build a simple black/purple clicker game with upgrades in D:\\Dev\\Clicker')!;
  expect(plan.intent).toBe('build-app');
  expect(plan.steps[0]!.args).toEqual({ template: 'clicker', path: 'D:\\Dev\\Clicker' });
});

test.each([
  ['make me a clicker game in D:\\Dev\\Orb', { template: 'clicker', path: 'D:\\Dev\\Orb' }],
  ['create an idle game called Night Orb in D:\\Dev\\Night', { template: 'clicker', path: 'D:\\Dev\\Night', name: 'Night Orb' }],
  ['Build me a cookie clicker in "D:\\My Games\\Cookie"', { template: 'clicker', path: 'D:\\My Games\\Cookie' }],
  ['build a website in D:\\Dev\\Site.', { template: 'website', path: 'D:\\Dev\\Site' }],
  ['make a landing page', { template: 'website' }],
  ['build me a blank desktop app in D:\\Dev\\Thing', { template: 'desktop', path: 'D:\\Dev\\Thing' }],
  ['build me a snake game in D:\\Dev\\Snake', { template: 'snake', path: 'D:\\Dev\\Snake' }],
  ['make me a clicker game in D:\\Dev\\Orb\\', { template: 'clicker', path: 'D:\\Dev\\Orb' }],
  ['make a pomodoro timer app in D:\\Dev\\Focus', { template: 'pomodoro', path: 'D:\\Dev\\Focus' }],
  ['create a budget tracker called My Money in D:\\Dev\\Money', { template: 'budget', name: 'My Money', path: 'D:\\Dev\\Money' }],
  ['build me a tic tac toe game', { template: 'tictactoe' }],
  ['write a scientific calculator in D:\\Dev\\Calc', { template: 'calculator', path: 'D:\\Dev\\Calc' }],
  // just "a game" / "an app": the kind is asked, not guessed
  ['build me a game in D:\\Dev\\Thing', { path: 'D:\\Dev\\Thing' }],
  ['make me a fun little game', {}],
  ['create a simple desktop app', {}],
  ['create an incremental game in D:\\Dev\\v1.0, then play it', { template: 'clicker', path: 'D:\\Dev\\v1.0' }],
])('%s', (text, expected) => {
  expect(parseBuildRequest(text)).toMatchObject(expected);
});

test('the long Tauri request is NOT silently turned into an Electron one: it goes to the developer agent', () => {
  const text =
    'Create a high quality Tauri desktop app named Clicker Game Test in D:\\Dev\\ClickerGameTest. It should start as a simple number clicker, then grow very complex with upgrades and heavy math, with numbers into the trillions.';
  expect(parseBuildRequest(text)).toBeNull();
  const plan = g.parse(text)!;
  expect(plan.intent).toBe('build-agent');
  // describe → build → check → open: the agent builds it, then the result is looked at and opened.
  expect(plan.steps.map((s) => s.skill)).toEqual(['devagent.run', 'project.check', 'project.play']);
  expect(plan.steps[1]!.args).toMatchObject({ path: String.raw`D:\Dev\ClickerGameTest`, built: 'agent' });
  expect(plan.steps[2]!.args).toEqual({ path: String.raw`D:\Dev\ClickerGameTest` });
  expect(plan.steps[0]!.args).toMatchObject({ path: 'D:\\Dev\\ClickerGameTest' });
  expect(String(plan.steps[0]!.args.goal)).toMatch(/Tauri desktop app named Clicker Game Test/);
});

test('a build with no template but a folder goes to the developer agent; with no folder it is left alone', () => {
  expect(parseAgentBuildRequest('build me a flight simulator game in D:\\Dev\\Sim')).toEqual({
    goal: 'build me a flight simulator game in D:\\Dev\\Sim',
    path: 'D:\\Dev\\Sim',
  });
  expect(g.parse('write me a python script that renames my photos in D:\\Dev\\Photos')?.steps[0]?.skill).toBe(
    'devagent.run',
  );
  // no folder: the planner / the honest fallback, never a guess at where
  expect(parseAgentBuildRequest('build me a flight simulator game')).toBeNull();
  // things that are not projects
  expect(parseAgentBuildRequest('make a folder called Games in D:\\Dev')).toBeNull();
  expect(parseAgentBuildRequest('create a note in D:\\Dev')).toBeNull();
  // a framework Atlas already scaffolds by name keeps its own route
  expect(parseAgentBuildRequest('create a react app called shop in D:\\Dev')).toBeNull();
  expect(g.parse('create a react app called shop in D:\\Dev')?.steps[0]?.skill).toBe('project.scaffold');
});

test.each([
  'build me a flight simulator game',
  'make a social network app',
  // everyday sentences that share a word with a template must not become projects
  'make notes.txt read only',
  'write a blog post about my trip',
  'make a budget for next month',
  'create a habit of reading',
  'make a note: buy milk',
  'build a memory of this',
  'create a react app called shop in D:\\Dev',
  'create a new project at D:\\Dev\\Thing',
  'make a note: buy milk',
  'create a folder called Games',
  'build D:\\Dev\\Atlas',
  'make a discord bot',
  'build me a python script',
])('%s is left to other rules', (text) => {
  expect(skillsOf(text)?.[0] ?? null).not.toBe('app.scaffold');
});

test('the helpers behave', () => {
  expect(displayNameFor('void-clicker')).toBe('Void Clicker');
  expect(displayNameFor('ClickerGame')).toBe('Clicker Game');
  expect(idFor("Night Orb's Edge!")).toBe('night-orb-s-edge');
  expect(chooseTemplate('a clicker app')?.id).toBe('clicker');
  expect(chooseTemplate('a flight simulator game')).toBeUndefined();
  expect(chooseTemplate('a snake game')?.id).toBe('snake');
  expect(chooseTemplate('play 2048 with me')?.id).toBe('2048');
  expect(statSync(tmpdir()).isDirectory()).toBe(true);
});
