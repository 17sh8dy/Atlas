/**
 * The builder's foundation: describe → build → CHECK → open.
 *
 * The strongest test here builds EVERY ready-made template onto a real folder and checks it — if a
 * template ever ships a page that loads a file it didn't write, this is where it shows.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { Platform, SkillContext } from '@atlas/core';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { Executor } from '../src/planner/executor';
import { WorkingMemory } from '../src/working-memory';
import { SkillRegistry } from '../src/skills/registry';
import { createAppScaffoldSkills } from '../src/skills/app-scaffold-skills';
import { createBuilderSkills } from '../src/skills/builder-skills';
import { checkProject, formatCheck, localRefs, resolveRef } from '../src/skills/project-check';
import { allTemplates } from '../src/templates';
import { diskPlatform } from './helpers/disk-platform';

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-builder-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** The disk double, but `pathInfo` answers like the native one: an error for a path that isn't there. */
function nativeLike(): Platform {
  const base = diskPlatform();
  return {
    ...base,
    pathInfo: async (p: string) => {
      if (!existsSync(p)) throw new Error('No such path.');
      return (await (base.pathInfo as (p: string) => Promise<unknown>)(p)) as never;
    },
    gameEngines: async () => [],
  } as unknown as Platform;
}

function memoryStore() {
  const facts = new Map<string, string>();
  return {
    facts,
    memory: {
      fact: async (_k: string, subject: string) => (facts.has(subject) ? { value: facts.get(subject)! } : undefined),
      remember: async (_k: string, subject: string, value: string) => void facts.set(subject, value),
    } as never,
  };
}

function currentProject() {
  let path: string | null = null;
  return { get: async () => path, set: async (p: string) => void (path = p), now: () => path };
}

// ------------------------------------------------------------------ the pure check

describe('checkProject', () => {
  const input = (files: Record<string, string>, extra: { hasNodeModules?: boolean; allExtra?: string[] } = {}) => ({
    allFiles: [...Object.keys(files), ...(extra.allExtra ?? [])],
    texts: new Map(Object.entries(files)),
    hasNodeModules: extra.hasNodeModules ?? false,
  });

  test('an empty folder is a failure, not a pass', () => {
    const r = checkProject({ allFiles: [], texts: new Map(), hasNodeModules: false });
    expect(r.ok).toBe(false);
    expect(r.items[0]!.text).toMatch(/empty/);
  });

  test('a page whose files are all there passes, and says what it checked', () => {
    const r = checkProject(input({ 'index.html': '<!doctype html><html><link rel="stylesheet" href="style.css"><script src="./app.js"></script>', 'style.css': 'a{}', 'app.js': 'x' }));
    expect(r.ok).toBe(true);
    expect(r.entry).toBe('index.html');
    expect(r.items.map((i) => i.text).join('\n')).toMatch(/index\.html: all 2 files it loads are there/);
    expect(formatCheck('Site', r)).toMatch(/does not prove the program works/);
  });

  test('a page that loads a file nobody wrote is a failure that names the file', () => {
    const r = checkProject(input({ 'index.html': '<html><script src="game.js"></script><img src="img/logo.png">', 'app.js': 'x' }));
    expect(r.ok).toBe(false);
    expect(r.items.find((i) => i.level === 'fail')!.text).toMatch(/index\.html loads “game\.js”, “img\/logo\.png”, which aren't in the project/);
    expect(formatCheck('Site', r)).toMatch(/Nothing was changed/);
  });

  test('web addresses, anchors, data and mail links are not local files', () => {
    expect(localRefs('<script src="https://cdn.x/y.js"></script><a href="#top"></a><img src="data:image/png;base64,AA"><link href="//fonts.x/f.css"><script src="a.js?v=2#h">')).toEqual(['a.js']);
  });

  test('a reference that climbs out of the project is flagged, one that stays inside resolves', () => {
    expect(resolveRef('a/b/index.html', '../c.js')).toBe('a/c.js');
    expect(resolveRef('index.html', '../x.js')).toBeNull();
    expect(resolveRef('a/index.html', '/root.js')).toBe('root.js');
    const r = checkProject(input({ 'index.html': '<html><script src="../evil.js"></script>' }));
    expect(r.items.find((i) => i.level === 'fail')!.text).toMatch(/outside the project/);
  });

  test('broken JSON, a missing main file, and uninstalled dependencies are each reported', () => {
    const bad = checkProject(input({ 'package.json': '{ nope', 'x.json': '{}' }));
    expect(bad.ok).toBe(false);
    expect(bad.items.some((i) => i.text === 'package.json is not valid JSON.')).toBe(true);
    const main = checkProject(input({ 'package.json': JSON.stringify({ main: 'main.js', scripts: { start: 'electron .' }, devDependencies: { electron: '1' } }) }));
    expect(main.ok).toBe(false);
    expect(main.items.some((i) => /starts at main\.js, but that file isn't there/.test(i.text))).toBe(true);
    expect(main.items.some((i) => i.level === 'warn' && /dependencies are not installed/.test(i.text))).toBe(true);
    expect(main.scripts).toEqual(['start']);
    const installed = checkProject(input({ 'package.json': JSON.stringify({ main: 'main.js', devDependencies: { electron: '1' } }), 'main.js': 'x' }, { hasNodeModules: true }));
    expect(installed.items.some((i) => /not installed/.test(i.text))).toBe(false);
  });

  test('empty source files and a page with no <html> are warnings, not failures', () => {
    const r = checkProject(input({ 'index.html': '<div>hi</div>', 'app.js': '  ' }));
    expect(r.ok).toBe(true);
    expect(r.items.filter((i) => i.level === 'warn').map((i) => i.text).join(' ')).toMatch(/Empty file: app\.js/);
    expect(r.items.some((i) => /complete page/.test(i.text))).toBe(true);
  });

  test('nothing to open is said, not assumed fine', () => {
    const r = checkProject(input({ 'notes.txt': 'hi' }));
    expect(r.entry).toBeNull();
    expect(r.items.some((i) => i.level === 'warn' && /only open the folder/.test(i.text))).toBe(true);
  });
});

// ------------------------------------------------------------------ the skills

describe('project.check and builder.status', () => {
  function rig() {
    const platform = nativeLike();
    const ctxProject = currentProject();
    const store = memoryStore();
    const skills = createBuilderSkills(platform, ctxProject, store.memory);
    const byId = (id: string) => skills.find((s) => s.id === id)!;
    const run = async (id: string, args: Record<string, unknown>) => (await byId(id).run(args, {} as SkillContext)) as { ok: boolean; message?: string; error?: string; data?: { ok?: boolean; path?: string } };
    return { run, ctxProject, store, skills };
  }

  test('both are safe, and neither writes anything to the project', async () => {
    const { skills, run } = rig();
    for (const s of skills.filter((x) => x.id === 'project.check' || x.id === 'builder.status')) expect(s.risk).toBe('safe');
    expect(skills.filter((x) => x.risk !== 'safe').map((x) => x.id).sort()).toEqual(['builder.change', 'builder.revert']);
    const dir = tmp();
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html></html>');
    const before = JSON.stringify(readdirSync(dir));
    await run('project.check', { path: dir });
    expect(JSON.stringify(readdirSync(dir))).toBe(before);
  });

  test('a good project passes; its folder becomes the current project', async () => {
    const { run, ctxProject } = rig();
    const dir = tmp();
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><script src="app.js"></script></html>');
    writeFileSync(join(dir, 'app.js'), 'console.log(1)');
    const r = await run('project.check', { path: dir });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/hangs together/);
    expect(ctxProject.now()).toBe(dir);
  });

  test('a broken project is reported with the file at fault — as an answer, not an error', async () => {
    const { run } = rig();
    const dir = tmp();
    writeFileSync(join(dir, 'index.html'), '<html><script src="missing.js"></script></html>');
    const r = await run('project.check', { path: dir });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/has a problem/);
    expect(r.message).toMatch(/“missing\.js”/);
    expect(r.data!.ok).toBe(false);
  });

  test('bad input: no project, a missing folder, a file instead of a folder', async () => {
    const { run } = rig();
    expect((await run('project.check', {})).error).toMatch(/Which project/);
    expect((await run('project.check', { path: join(tmp(), 'nope') })).error).toMatch(/can't find/);
    const dir = tmp();
    writeFileSync(join(dir, 'a.txt'), 'x');
    expect((await run('project.check', { path: join(dir, 'a.txt') })).error).toMatch(/is a file/);
  });

  test('a build is remembered, and "what did you build" says how, and re-checks now', async () => {
    const { run, store } = rig();
    expect((await run('builder.status', {})).message).toMatch(/haven’t built anything/);
    const dir = tmp();
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html></html>');
    await run('project.check', { path: dir, built: 'agent', goal: 'a black and purple clicker with upgrades' });
    expect(JSON.parse(store.facts.get('builder.last')!)).toMatchObject({ path: dir, built: 'agent', checked: { ok: true } });
    const s = await run('builder.status', {});
    expect(s.message).toMatch(/step by step by the developer agent: “a black and purple clicker with upgrades”/);
    expect(s.message).toMatch(/It checks out now: 1 files, opens from index\.html/);
    // Break it afterwards: status tells the truth about now, not about the day it was built.
    writeFileSync(join(dir, 'index.html'), '<html><script src="gone.js"></script></html>');
    expect((await run('builder.status', {})).message).toMatch(/It has problems now: .*gone\.js/);
  });

  test('a re-check of a known project keeps how it was built', async () => {
    const { run, store } = rig();
    const dir = tmp();
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html></html>');
    await run('project.check', { path: dir, built: 'template', template: 'clicker' });
    await run('project.check', { path: dir });
    expect(JSON.parse(store.facts.get('builder.last')!)).toMatchObject({ built: 'template', template: 'clicker' });
  });
});

// ------------------------------------------------------------------ the whole flow

describe('every ready-made template builds into something that checks out', () => {
  test.each(allTemplates().map((t) => [t.id]))('%s', async (id) => {
    const platform = nativeLike();
    const proj = currentProject();
    const dir = join(tmp(), 'Built');
    const registry = new SkillRegistry({ capabilities: () => ['devtools', 'fs'] });
    registry.registerMany([...createAppScaffoldSkills(platform, proj), ...createBuilderSkills(platform, proj, memoryStore().memory)]);
    const ctx = { say() {}, confirm: async () => true } as unknown as SkillContext;
    const outcome = await new Executor(registry).run(
      { source: 'grammar', intent: 'build-app', confidence: 1, steps: [{ skill: 'app.scaffold', args: { template: id, path: dir } }, { skill: 'project.check', args: { built: 'template', template: id, path: dir } }] },
      ctx,
      { mode: 'doIt' },
    );
    expect(outcome.outcomes.map((o) => o.ok), JSON.stringify(outcome.outcomes.map((o) => o.error))).toEqual([true, true]);
    const report = outcome.outcomes[1]!.data as { ok: boolean; items: Array<{ level: string; text: string }> };
    const failures = report.items.filter((i) => i.level === 'fail').map((i) => i.text);
    expect(failures, `${id}: ${failures.join(' | ')}`).toEqual([]);
  });
});

describe('the plans', () => {
  const g = new Grammar();
  g.addMany(createCoreGrammar(new WorkingMemory()));
  g.addMany(createExtraGrammar());
  const steps = (text: string) => g.parse(text)?.steps.map((s) => s.skill);

  test('template route: build → install (desktop) → check → open', () => {
    expect(steps('build me a clicker game in D:\\Dev\\Clicker')).toEqual(['app.scaffold', 'dependency.installAll', 'project.check', 'project.play']);
    expect(steps('make a website in D:\\Dev\\MySite')).toEqual(['app.scaffold', 'project.check', 'project.play']);
  });

  test('agent route: build → check → open, and every step names the same folder', () => {
    const plan = g.parse('build me a flight simulator game in D:\\Dev\\Sim')!;
    expect(plan.steps.map((s) => s.skill)).toEqual(['devagent.run', 'project.check', 'project.play']);
    const dirs = plan.steps.map((s) => s.args.path);
    expect(new Set(dirs).size).toBe(1);
    expect(plan.steps[1]!.args).toMatchObject({ built: 'agent' });
  });

  test('an engine project is built and checked but never opened for you', () => {
    expect(steps('build me a godot project in D:\\Dev\\Orb')).toEqual(['app.scaffold', 'project.check']);
  });

  test('the check and the status have phrasings, and inspect/detect keep theirs', () => {
    expect(steps('check the project I just built')).toEqual(['project.check']);
    expect(steps('check my project')).toEqual(['project.check']);
    expect(steps('what did you build')).toEqual(['builder.status']);
    expect(steps("what's my current app")).toEqual(['builder.status']);
    expect(steps('inspect the project at D:\\Dev\\NovaEngine')).toEqual(['project.detect']);
  });
});

test('mkdirSync is imported for the cases that need a nested fixture', () => {
  const dir = tmp();
  mkdirSync(join(dir, 'a'));
  expect(existsSync(join(dir, 'a'))).toBe(true);
});
