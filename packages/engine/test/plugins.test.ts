/**
 * Plugins are data from outside Atlas, so the tests here are mostly about what must be REFUSED:
 * a plugin that tries to write a program, climb out of its folder, take a built-in's name or turn
 * into an npm project. Then that the Unreal template writes a project Unreal will open, that the
 * engine questions are answered from what is really installed, and that "make me an AAA game" gets
 * the honest answer instead of a toy.
 */

import { assert, expect, test, beforeEach } from 'vitest';
import type { EngineInfo, Platform, PluginFolder } from '@atlas/core';
import { LIMITS, manifestTemplates, parseManifest, pathProblem } from '../src/plugins/manifest';
import { loadPlugins, pluginReport } from '../src/plugins/host';
import { allTemplates, chooseTemplate, templateById, unregisterTemplates } from '../src/templates';
import { newestUnreal, pascalFor, unrealProject } from '../src/templates/unreal';
import { createPluginSkills, engineAdvice } from '../src/skills/plugin-skills';
import { createAppScaffoldSkills, unsafeFilePath } from '../src/skills/app-scaffold-skills';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { parseBuildRequest } from '../src/planner/app-grammar';
import { WorkingMemory } from '../src/working-memory';

const goodTemplate = {
  id: 'company-site',
  label: 'a company website',
  summary: 'the company website skeleton',
  group: 'starter',
  words: ['company website', 'company site'],
  launch: 'index.html',
  tip: 'Edit index.html.',
  files: [
    { path: 'index.html', content: '<!doctype html><title>{{NAME}}</title><h1>{{NAME}}</h1>' },
    { path: 'css/site.css', content: 'body { margin: 0 }' },
  ],
};
const manifest = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ id: 'acme-kit', name: 'Acme Kit', version: '1.0.0', description: 'Acme starters', author: 'Acme', templates: [goodTemplate], ...over });

// ---------------------------------------------------------------- the manifest

test('a good plugin parses, and its template writes the files with the name filled in', () => {
  const r = parseManifest(manifest(), 'acme-kit');
  assert.isTrue(r.ok, JSON.stringify(r));
  if (!r.ok) return;
  const [t] = manifestTemplates(r.manifest);
  assert.equal(t!.source, 'acme-kit');
  assert.isFalse(t!.desktop);
  const files = t!.files({ name: 'Acme', id: 'acme', pascal: 'Acme' });
  assert.deepEqual(files.map((f) => f.path), ['index.html', 'css/site.css']);
  assert.include(files[0]!.content, '<h1>Acme</h1>');
});

test('broken JSON and the wrong shape are refused politely', () => {
  assert.deepEqual(parseManifest('{nope', 'x'), { ok: false, errors: ['plugin.json is not valid JSON.'] });
  assert.isFalse(parseManifest('[]', 'x').ok);
  assert.isFalse(parseManifest('"text"', 'x').ok);
  assert.isFalse(parseManifest('null', 'x').ok);
});

test('the id must be well formed and match the folder', () => {
  assert.isFalse(parseManifest(manifest({ id: 'Bad Id' }), 'Bad Id').ok);
  assert.isFalse(parseManifest(manifest({ id: 'a' }), 'a').ok);
  const mismatch = parseManifest(manifest(), 'some-other-folder');
  assert.isFalse(mismatch.ok);
  if (!mismatch.ok) assert.match(mismatch.errors.join(' '), /must match the folder/);
});

const withFile = (path: string, content = 'x') => manifest({ templates: [{ ...goodTemplate, files: [{ path: 'index.html', content: 'x' }, { path, content }] }] });
const errorsOf = (json: string, folder = 'acme-kit') => {
  const r = parseManifest(json, folder);
  return r.ok ? [] : r.errors;
};

test.each([
  ['../outside.txt', /"\.\."/],
  ['a/../../b.txt', /"\.\."/],
  ['/etc/passwd', /not relative/],
  ['C:/Windows/x.txt', /not relative/],
  ['a\\b.txt', /backslash/],
  ['a//b.txt', /empty/],
  ['con.txt', /reserves/],
  ['docs/NUL', /reserves/],
  ['name.', /dot or space/],
  ['bad<name>.txt', /character Windows/],
  ['{{NAME}}/x.txt', /\{\{NAME\}\}/],
  ['{other}/x.txt', /\{ or \}/],
  ['a/b/c/d/e/f/g/h/i.txt', /nested too deeply/],
  ['x'.repeat(130) + '.txt', /too long/],
])('a plugin cannot write %s', (path, why) => {
  const errs = errorsOf(withFile(path));
  assert.isAbove(errs.length, 0, path);
  assert.match(errs.join(' '), why);
});

test.each(['run.exe', 'setup.msi', 'go.bat', 'go.cmd', 'x.ps1', 'x.vbs', 'link.lnk', 'a.dll', 'k.reg', 'app.jar', 'run.sh', 'Content/Python/init_unreal.py', 'package.json', 'Play.cmd'])(
  'a plugin cannot write a program or something that runs by itself: %s',
  (path) => {
    assert.match(errorsOf(withFile(path)).join(' '), /program or shortcut|runs by itself/);
  },
);

test('and ordinary files, including scripts for a web page, are fine', () => {
  for (const p of ['style.css', 'app.js', 'data/levels.json', 'README.md', '{{PASCAL}}.uproject', 'Config/DefaultEngine.ini', 'Scripts/build.py', 'notes.txt', 'img/logo.svg']) {
    assert.deepEqual(errorsOf(withFile(p)), [], p);
  }
});

test('the same file twice, a file that is too big, and too many files are refused', () => {
  assert.match(errorsOf(withFile('INDEX.html')).join(' '), /listed twice/);
  assert.match(errorsOf(withFile('big.txt', 'x'.repeat(LIMITS.fileBytes + 1))).join(' '), /larger than/);
  const many = Array.from({ length: LIMITS.filesPerTemplate + 1 }, (_, i) => ({ path: `f${i}.txt`, content: 'x' }));
  many.unshift({ path: 'index.html', content: 'x' });
  assert.match(errorsOf(manifest({ templates: [{ ...goodTemplate, files: many }] })).join(' '), /at most 60 files/);
});

test('a template cannot be an npm project, cannot open a program, and must open one of its own files', () => {
  assert.match(errorsOf(manifest({ templates: [{ ...goodTemplate, desktop: true }] })).join(' '), /desktop project/);
  assert.match(errorsOf(manifest({ templates: [{ ...goodTemplate, launch: 'run.exe', files: [{ path: 'run.exe', content: 'x' }] }] })).join(' '), /launch|program/);
  assert.match(errorsOf(manifest({ templates: [{ ...goodTemplate, launch: 'other.html' }] })).join(' '), /not one of its files/);
});

test('words must be plain text a person would say', () => {
  assert.match(errorsOf(manifest({ templates: [{ ...goodTemplate, words: ['.*'] }] })).join(' '), /word/);
  assert.match(errorsOf(manifest({ templates: [{ ...goodTemplate, words: [] }] })).join(' '), /words/);
  assert.match(errorsOf(manifest({ templates: [{ ...goodTemplate, words: Array(13).fill('okay word') }] })).join(' '), /at most 12/);
});

test('two templates with one id, an unknown group, and a missing label are refused', () => {
  assert.match(errorsOf(manifest({ templates: [goodTemplate, goodTemplate] })).join(' '), /used twice/);
  assert.match(errorsOf(manifest({ templates: [{ ...goodTemplate, group: 'weapon' }] })).join(' '), /group/);
  assert.match(errorsOf(manifest({ templates: [{ ...goodTemplate, label: '' }] })).join(' '), /label/);
});

test('extra fields are ignored, never acted on', () => {
  const r = parseManifest(manifest({ run: 'calc.exe', scripts: { postinstall: 'evil' }, templates: [{ ...goodTemplate, onInstall: 'evil' }] }), 'acme-kit');
  assert.isTrue(r.ok);
  if (r.ok) assert.notProperty(r.manifest, 'run');
});

test('path problems report each rule separately', () => {
  assert.isNull(pathProblem('a/b.txt'));
  assert.isNotNull(pathProblem(''));
});

// ---------------------------------------------------------------- the host

const folder = (name: string, json: string | null, error: string | null = null): PluginFolder => ({ folder: name, json, error });
const platformWith = (folders: PluginFolder[]): Pick<Platform, 'pluginManifests'> => ({ pluginManifests: async () => folders });

beforeEach(() => unregisterTemplates('acme-kit'));

test('a good plugin registers its templates, and "build me a company website" finds them', async () => {
  const report = await loadPlugins(platformWith([folder('acme-kit', manifest())]));
  assert.equal(report.loaded.length, 1);
  assert.equal(report.rejected.length, 0);
  assert.equal(templateById('company-site')?.source, 'acme-kit');
  assert.equal(chooseTemplate('make me a company website')?.id, 'company-site');
  assert.equal(parseBuildRequest('build me a company website in D:\\Dev\\Acme')?.template, 'company-site');
});

test('a bad plugin is reported and skipped, and the good ones still load', async () => {
  const report = await loadPlugins(
    platformWith([
      folder('broken', '{nope'),
      folder('acme-kit', manifest()),
      folder('unreadable', null, 'plugin.json is larger than 4 MB.'),
      folder('hostile', manifest({ id: 'hostile', templates: [{ ...goodTemplate, id: 'evil', files: [{ path: 'index.html', content: 'x' }, { path: 'go.bat', content: 'x' }] }] })),
    ]),
  );
  assert.deepEqual(report.loaded.map((p) => p.id), ['acme-kit']);
  assert.deepEqual(report.rejected.map((r) => r.folder).sort(), ['broken', 'hostile', 'unreadable']);
  assert.isUndefined(templateById('evil'), 'nothing from a refused plugin is registered');
});

test('a plugin cannot replace a built-in project, or another plugin', async () => {
  const snake = manifest({ id: 'sneaky', templates: [{ ...goodTemplate, id: 'snake' }] });
  const before = templateById('snake');
  const report = await loadPlugins(platformWith([folder('sneaky', snake)]));
  assert.equal(report.loaded.length, 0);
  assert.match(report.rejected[0]!.errors.join(' '), /already used/);
  assert.strictEqual(templateById('snake'), before);

  const two = await loadPlugins(platformWith([folder('acme-kit', manifest()), folder('copycat', manifest({ id: 'copycat' }))]));
  assert.deepEqual(two.loaded.map((p) => p.id), ['acme-kit']);
  assert.equal(two.rejected[0]!.folder, 'copycat');
});

test('reloading forgets a plugin whose folder is gone', async () => {
  await loadPlugins(platformWith([folder('acme-kit', manifest())]));
  assert.isDefined(templateById('company-site'));
  await loadPlugins(platformWith([]));
  assert.isUndefined(templateById('company-site'));
  assert.deepEqual(pluginReport().loaded, []);
});

test('if the plugins folder cannot be read, that is reported rather than thrown', async () => {
  const report = await loadPlugins({ pluginManifests: async () => { throw new Error('access denied'); } });
  assert.equal(report.rejected[0]!.errors[0], 'access denied');
});

// ---------------------------------------------------------------- scaffolding checks the paths again

test('even a template that slipped through cannot write outside its folder', () => {
  for (const bad of ['../x.txt', '/abs.txt', 'C:/x.txt', 'a\\b', 'a//b', 'a/./b', 'a/b./c', 'a\u0001b']) {
    assert.isNotNull(unsafeFilePath(bad), JSON.stringify(bad));
  }
  assert.isNull(unsafeFilePath('Config/DefaultEngine.ini'));
});

function memoryPlatform(engines: EngineInfo[]) {
  const written = new Map<string, string>();
  const platform: Platform = {
    id: 't',
    capabilities: async () => ['devtools'],
    gameEngines: async () => engines,
    pathInfo: async () => { throw new Error('none'); },
    createFolder: async () => true,
    createFile: async (p, c) => { written.set(p, c ?? ''); return true; },
  };
  return { platform, written };
}
const UE57: EngineInfo = { kind: 'unreal', version: '5.7', path: 'D:\\Games\\Epic Games\\UE_5.7', editor: 'D:\\Games\\Epic Games\\UE_5.7\\Engine\\Binaries\\Win64\\UnrealEditor.exe' };
const ctx = { say: () => {}, confirm: async () => true };

test('a plugin template that sneaks a bad path past the loader is stopped when it is written', async () => {
  const evil = { ...manifestTemplates({ id: 'x', name: 'x', version: '1', description: '', author: '', templates: [{ ...goodTemplate, group: 'starter', files: [{ path: 'index.html', content: 'x' }] } as never] })[0]!, id: 'evil-t', files: () => [{ path: '../escape.txt', content: 'x' }] };
  const { registerTemplates } = await import('../src/templates');
  registerTemplates([evil]);
  try {
    const { platform, written } = memoryPlatform([]);
    const r = await createAppScaffoldSkills(platform)[0]!.run({ path: 'D:\\Dev\\Evil', template: 'evil-t' }, ctx);
    assert.isFalse(r.ok);
    assert.match(r.error!, /climbs out/);
    assert.equal(written.size, 0, 'nothing was written');
  } finally {
    unregisterTemplates('x');
    const { allTemplates: all } = await import('../src/templates');
    assert.isDefined(all());
  }
});

// ---------------------------------------------------------------- Unreal

test('project names are made safe for Unreal', () => {
  assert.equal(pascalFor('Void Clicker'), 'VoidClicker');
  assert.equal(pascalFor('my-cool_game 2'), 'MyCoolGame2');
  assert.equal(pascalFor('3D Racer'), 'Game3DRacer');
  assert.equal(pascalFor('!!!'), 'MyGame');
  assert.isAtMost(pascalFor('x'.repeat(100)).length, 40);
});

test('the newest installed Unreal is the one the project points at', () => {
  const e = (v: string, kind: EngineInfo['kind'] = 'unreal'): EngineInfo => ({ ...UE57, kind, version: v });
  assert.equal(newestUnreal([e('4.27'), e('5.7'), e('5.10'), e('5.3')])?.version, '5.10');
  assert.equal(newestUnreal([e('5.7', 'godot')]), undefined);
  assert.isUndefined(newestUnreal([]));
  assert.isUndefined(newestUnreal([e('source build {GUID}')]));
});

test('an Unreal project is a real .uproject with the engine version found on this PC', () => {
  const files = unrealProject.files({ name: 'Night Orb', id: 'night-orb', pascal: 'NightOrb', engines: [UE57] });
  const paths = files.map((f) => f.path);
  assert.deepEqual(paths, ['NightOrb.uproject', 'Config/DefaultEngine.ini', 'Config/DefaultGame.ini', 'Scripts/build_starter_level.py', 'README.md']);
  const up = JSON.parse(files[0]!.content);
  assert.equal(up.FileVersion, 3);
  assert.equal(up.EngineAssociation, '5.7');
  assert.equal(up.Description, 'Night Orb');
  assert.deepEqual(up.Plugins.map((p: { Name: string }) => p.Name), ['PythonScriptPlugin', 'EditorScriptingUtilities']);
  assert.notProperty(up, 'Modules', 'a content-only project has no C++ module to compile');
  assert.equal(unrealProject.launchFile!({ name: 'Night Orb', id: 'night-orb', pascal: 'NightOrb' }), 'NightOrb.uproject');
  for (const f of files) assert.isNull(unsafeFilePath(f.path), f.path);
});

test('with no Unreal installed it still writes a project, says so, and defaults to 5.7', () => {
  const files = unrealProject.files({ name: 'X', id: 'x', pascal: 'X', engines: [] });
  assert.equal(JSON.parse(files[0]!.content).EngineAssociation, '5.7');
  assert.match(files.find((f) => f.path === 'README.md')!.content, /was not found on this PC/);
});

test('the starter-level script only uses calls that exist and is plain Python', () => {
  const py = unrealProject.files({ name: 'X', id: 'x', pascal: 'X' }).find((f) => f.path.endsWith('.py'))!.content;
  for (const call of ['EditorActorSubsystem', 'LevelEditorSubsystem', 'new_level', 'save_current_level', 'spawn_actor_from_class', 'does_asset_exist', 'DirectionalLight', 'SkyLight', 'PlayerStart']) {
    assert.include(py, call);
  }
  assert.notMatch(py, /os\.system|subprocess|eval\(|exec\(|urllib|requests|socket/, 'it never runs a program or goes online');
});

test('building an Unreal project through the skill writes the files and does not open the editor', async () => {
  const { platform, written } = memoryPlatform([UE57]);
  const r = await createAppScaffoldSkills(platform)[0]!.run({ path: 'D:\\Dev\\Night Orb', template: 'unreal' }, ctx);
  assert.isTrue(r.ok, r.error);
  assert.isTrue(written.has('D:\\Dev\\Night Orb\\NightOrb.uproject'), [...written.keys()].join(', '));
  assert.equal((r.data as { launch: string }).launch, 'D:\\Dev\\Night Orb\\NightOrb.uproject');
  assert.match(r.message!, /heavy program|not opened/i);
});

// ---------------------------------------------------------------- asking

const g = new Grammar();
g.addMany(createCoreGrammar(new WorkingMemory()));
g.addMany(createExtraGrammar());
const skillsFor = (text: string) => g.parse(text)?.steps.map((s) => s.skill) ?? null;

test('an Unreal project is its own plan: written, and not opened', () => {
  expect(skillsFor('build me an unreal engine project in D:\\Dev\\Orb')).toEqual(['app.scaffold', 'project.check']);
  expect(g.parse('make a ue5 game in D:\\Dev\\Orb')?.steps[0]?.args).toMatchObject({ template: 'unreal', path: 'D:\\Dev\\Orb' });
});

test.each([
  ['what game engines do I have', 'engine.list'],
  ['which game engines are installed', 'engine.list'],
  ['do I have unreal installed', 'engine.list'],
  ['what plugins do I have', 'plugin.list'],
  ['reload my plugins', 'plugin.reload'],
  ['open the plugins folder', 'plugin.openFolder'],
])('%s -> %s', (text, skill) => {
  expect(skillsFor(text)).toEqual([skill]);
});

test.each([
  'I want to make an AAA open world game',
  'build me a 3D first person shooter',
  'make a game like GTA',
  'create a triple-A game with ray tracing',
  'build a huge MMO',
])('"%s" gets the honest answer about game engines', (text) => {
  const plan = g.parse(text);
  expect(plan?.steps.map((s) => s.skill)).toEqual(['engine.advise']);
});

test('even with a folder, a game that big is not handed to the developer agent', () => {
  expect(skillsFor('build me an AAA open world game in D:\\Dev\\Big')).toEqual(['engine.advise']);
});

test('small games are still built, and a note about engines follows them', async () => {
  expect(skillsFor('make a 2d platformer')).not.toEqual(['engine.advise']);
  const { platform } = memoryPlatform([]);
  const r = await createAppScaffoldSkills(platform)[0]!.run({ path: 'D:\\Dev\\Snake', template: 'snake' }, ctx);
  assert.isTrue(r.ok);
  assert.match(r.message!, /real game engine/);
  assert.match(r.message!, /what game engines do I have/);
});

test('the advice is honest about what is installed and what Atlas can and cannot do', () => {
  const none = engineAdvice([]);
  assert.match(none, /game engine/);
  assert.match(none, /do not see Unreal Engine, Unity or Godot/);
  const withUe = engineAdvice([UE57], 'I want an AAA game');
  assert.match(withUe, /Unreal Engine 5\.7/);
  assert.match(withUe, /build me an Unreal Engine project/);
  assert.match(withUe, /will not open the editor/);
  assert.match(withUe, /hundreds of people over years/, 'AAA gets its own plain word');
  const godot = engineAdvice([{ ...UE57, kind: 'godot', version: '4.3' }]);
  assert.match(godot, /Godot 4\.3/);
  assert.match(godot, /build me a Godot project/);
  const mixed = engineAdvice([UE57, { ...UE57, kind: 'blender', version: '4.2' }]);
  assert.match(mixed, /Blender 4\.2 is here too/);
  assert.match(engineAdvice([]), /cannot install them for you/);
});

test('the engine and plugin skills read what is really there', async () => {
  const skills = createPluginSkills({
    id: 't',
    capabilities: async () => [],
    gameEngines: async () => [UE57],
    openPluginsFolder: async () => 'C:\\Users\\me\\AppData\\Roaming\\atlas\\plugins',
  });
  const run = (id: string) => skills.find((s) => s.id === id)!.run({}, ctx);
  const list = await run('engine.list');
  assert.match(list.message!, /Unreal Engine 5\.7/);
  assert.match(list.message!, /UnrealEditor\.exe/);
  const opened = await run('plugin.openFolder');
  assert.match(opened.message!, /plugins/);
  for (const s of skills) assert.equal(s.risk, 'safe', s.id);
  const plugins = await run('plugin.list');
  assert.match(plugins.message!, /Built in \(\d+ projects/);
  assert.match(plugins.message!, /Games: .*snake/);
  assert.match(plugins.message!, /Game engines: Unreal Engine project, Godot project, Unity project, Blender project/);
  // only looks, never installs: the engine list says so and names what is missing
  assert.match(list.message!, /Not found: Unity, Godot, Blender/);
  assert.match(list.message!, /never download or install/);
});

test('every built-in project is still found, and Unreal is among them', () => {
  assert.isAbove(allTemplates().length, 18);
  assert.equal(templateById('unreal')?.group, 'engine');
  assert.equal(templateById('unreal')?.source, 'built-in');
  assert.equal(chooseTemplate('an unreal engine project')?.id, 'unreal');
});
