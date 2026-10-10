/**
 * The request Atlas refused in several wordings: "In D:\Dev\Nova.Play Create a Src - Tauri desktop
 * app … a clean Glass Box with a clickable game called Infinite Clicker …". Checked the way the
 * app reaches it: through the whole grammar, not the one rule, and the template written to disk.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assert, expect, test } from 'vitest';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { liftLeadingPath, parseBuildRequest } from '../src/planner/app-grammar';
import { idFor, templateById } from '../src/templates';
import { checkProject } from '../src/skills/project-check';

const g = new Grammar();
for (const rule of createCoreGrammar()) g.add(rule);
for (const rule of createExtraGrammar()) g.add(rule);

const REQUEST =
  'In D:\\Dev\\Nova.Play Create a Src  - Tauri desktop app with a clean modern UI look. In that App create a clean Glass Box that has a clickable game called Infinite Clicker. When they click on the game it should open in the app, start with a fancy button that says click me! and each click goes up by 1. let the number go to 1000000';

test('the folder-first sentence is rewritten to the shape every rule expects', () => {
  expect(liftLeadingPath('In D:\\Dev\\Game, create a clicker')).toBe('create a clicker in D:\\Dev\\Game');
  expect(liftLeadingPath('in "D:\\My Games\\One" make an app.')).toBe('make an app in "D:\\My Games\\One"');
  // not folder-first: untouched
  expect(liftLeadingPath('create a clicker in D:\\Dev\\Game')).toBe('create a clicker in D:\\Dev\\Game');
  expect(liftLeadingPath('in the morning remind me')).toBe('in the morning remind me');
});

test("Brandon's exact sentence builds the Tauri launcher in D:\\Dev\\Nova.Play\\Src, with no model", () => {
  expect(parseBuildRequest(REQUEST)).toEqual({
    template: 'tauri-launcher',
    path: 'D:\\Dev\\Nova.Play\\Src',
    name: 'Nova.Play',
  });
  const plan = g.parse(REQUEST)!;
  expect(plan.intent).toBe('build-app');
  expect(plan.steps.map((s) => s.skill)).toEqual(['app.scaffold', 'dependency.installAll', 'project.check']);
  expect(plan.steps[0]!.args).toMatchObject({ template: 'tauri-launcher', path: 'D:\\Dev\\Nova.Play\\Src', name: 'Nova.Play' });
  // A Rust compile of minutes is never started by the plan itself.
  expect(plan.steps.map((s) => s.skill)).not.toContain('project.play');
});

test.each([
  'Create a Tauri desktop app in D:\\Dev\\Shiny',
  'in D:\\Dev\\Shiny, build me a tauri app',
  'make a tauri game launcher in D:\\Dev\\Shiny',
])('other ways of asking for the same thing: %s', (text) => {
  const plan = g.parse(text)!;
  expect(plan.steps[0]!.skill).toBe('app.scaffold');
  expect(plan.steps[0]!.args).toMatchObject({ template: 'tauri-launcher' });
});

test('a Tauri app of some OTHER kind is never answered with the launcher or an Electron template', () => {
  expect(parseBuildRequest('make a tauri todo app in D:\\Dev\\Todo')).toBeNull();
  expect(g.parse('make a tauri todo app in D:\\Dev\\Todo')?.steps[0]?.skill).toBe('devagent.run');
});

test("Atlas's own post-build check accepts the written project", () => {
  const files = templateById('tauri-launcher')!.files({ name: 'Nova.Play', id: 'nova-play' });
  const texts = new Map(files.map((f) => [f.path, f.content] as const));
  const check = checkProject({ allFiles: files.map((f) => f.path), texts, hasNodeModules: false });
  const failures = check.items.filter((i) => i.level === 'fail').map((i) => i.text);
  expect(failures).toEqual([]);
  expect(check.ok).toBe(true);
});

test('the template is a complete Tauri project that passes its own checks', () => {
  const template = templateById('tauri-launcher')!;
  const files = template.files({ name: 'Nova.Play', id: idFor('Nova.Play') });
  const root = mkdtempSync(join(tmpdir(), 'atlas-tauri-'));
  try {
    for (const f of files) {
      assert.notMatch(f.content, /\{\{[A-Z]+\}\}/, `${f.path} still has a placeholder`);
      const target = join(root, ...f.path.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, f.content, 'utf8');
    }
    const names = files.map((f) => f.path);
    for (const needed of ['package.json', 'Play.cmd', 'ui/index.html', 'src-tauri/Cargo.toml', 'src-tauri/tauri.conf.json', 'src-tauri/src/lib.rs']) {
      assert.include(names, needed);
    }
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'nova-play');
    assert.equal(pkg.devDependencies['@tauri-apps/cli'].startsWith('^2'), true);
    const conf = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
    assert.equal(conf.productName, 'Nova.Play');
    assert.equal(conf.build.frontendDist, '../ui');
    const cargo = readFileSync(join(root, 'src-tauri', 'Cargo.toml'), 'utf8');
    assert.include(cargo, 'name = "nova-play"');
    assert.include(cargo, 'name = "nova_play_lib"');
    assert.include(readFileSync(join(root, 'src-tauri', 'src', 'main.rs'), 'utf8'), 'nova_play_lib::run()');
    // The exe name Play.cmd looks for is the crate name.
    assert.include(readFileSync(join(root, 'Play.cmd'), 'utf8'), 'release\\nova-play.exe');

    // The page only references files that exist and loads nothing from the internet.
    const html = readFileSync(join(root, 'ui', 'index.html'), 'utf8');
    assert.notMatch(html, /(?:src|href)="https?:/);
    assert.notMatch(html, /\sstyle="/);
    for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) assert.include(names, `ui/${m[1]}`);
    assert.include(html, 'Click me!');

    // The game's own test runs: one click adds 1, and the count stops at 1,000,000.
    for (const f of names.filter((n) => n.endsWith('.js') || n.endsWith('.mjs'))) {
      execFileSync(process.execPath, ['--check', join(root, f)]);
    }
    const out = execFileSync(process.execPath, [join(root, 'ui', 'game.test.mjs')], { encoding: 'utf8' });
    assert.include(out, 'all passed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
