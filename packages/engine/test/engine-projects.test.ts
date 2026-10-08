/**
 * Godot, Unity and Blender project templates. None of the three programs is installed on the PC
 * these were written on, so these tests check everything that CAN be checked without them: the
 * JSON parses, the Python compiles, the files follow the layout each engine documents, every path
 * is safe, and the versions come from what Atlas detects. They do not claim the engine opens the
 * project; that is said plainly in each template's header and README.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, expect, test } from 'vitest';
import type { EngineInfo } from '@atlas/core';
import { blenderFiles, blenderProject, godotFiles, godotProject, unityFiles, unityProject } from '../src/templates/engines';
import { unsafeFilePath } from '../src/skills/app-scaffold-skills';
import { chooseTemplate, templateById } from '../src/templates';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { WorkingMemory } from '../src/working-memory';

const opts = (engines: EngineInfo[] = []) => ({ name: 'Night Orb', id: 'night-orb', pascal: 'NightOrb', engines });
const engine = (kind: EngineInfo['kind'], version: string): EngineInfo => ({ kind, version, path: 'C:\\x', editor: 'C:\\x\\e.exe' });
const byPath = (files: Array<{ path: string; content: string }>, p: string) => files.find((f) => f.path === p)!.content;

test('every path in every engine template is safe and relative', () => {
  for (const t of [godotProject, unityProject, blenderProject]) {
    for (const f of t.files(opts())) assert.isNull(unsafeFilePath(f.path), `${t.id}: ${f.path}`);
    assert.equal(t.group, 'engine');
    assert.isFalse(t.desktop, 'no npm install');
    assert.equal(t.source, 'built-in');
  }
});

test('a Godot project has the files Godot looks for, and points at the scene it writes', () => {
  const files = godotFiles(opts([engine('godot', '4.4.1')]));
  assert.deepEqual(files.map((f) => f.path), ['project.godot', 'main.tscn', 'player.gd', 'README.md']);
  const project = byPath(files, 'project.godot');
  assert.match(project, /^config_version=5$/m);
  assert.match(project, /^config\/name="Night Orb"$/m);
  assert.match(project, /^run\/main_scene="res:\/\/main\.tscn"$/m);
  assert.match(project, /PackedStringArray\("4\.4"\)/, 'the feature tag follows the Godot found');
  assert.match(byPath(godotFiles(opts()), 'project.godot'), /PackedStringArray\("4\.3"\)/, 'a sensible default with none found');
});

test('the Godot scene is well formed: every resource it uses is declared, and the counts add up', () => {
  const scene = byPath(godotFiles(opts()), 'main.tscn');
  assert.match(scene, /^\[gd_scene load_steps=3 format=3\]/);
  const ext = [...scene.matchAll(/^\[ext_resource [^\]]*id="([^"]+)"/gm)].map((m) => m[1]);
  const sub = [...scene.matchAll(/^\[sub_resource [^\]]*id="([^"]+)"/gm)].map((m) => m[1]);
  assert.equal(1 + ext.length + sub.length, 3, 'load_steps = resources + 1');
  for (const used of [...scene.matchAll(/ExtResource\("([^"]+)"\)/g)].map((m) => m[1])) assert.include(ext, used);
  for (const used of [...scene.matchAll(/SubResource\("([^"]+)"\)/g)].map((m) => m[1])) assert.include(sub, used);
  // every node's parent exists before it does
  const names = new Set<string>();
  for (const m of scene.matchAll(/^\[node name="([^"]+)" type="([^"]+)"(?: parent="([^"]+)")?\]/gm)) {
    const [, name, , parent] = m;
    if (parent && parent !== '.') assert.isTrue(names.has(parent), `${name}: parent ${parent} comes first`);
    names.add(name!);
  }
  assert.deepEqual([...names], ['Main', 'Player', 'Shape', 'Body', 'Camera']);
  assert.include(byPath(godotFiles(opts()), 'player.gd'), 'extends CharacterBody2D');
  assert.include(byPath(godotFiles(opts()), 'player.gd'), 'move_and_slide()');
});

test('a quote in the project name cannot break project.godot', () => {
  const project = byPath(godotFiles({ ...opts(), name: 'The "Best" Game' }), 'project.godot');
  assert.match(project, /^config\/name="The 'Best' Game"$/m);
});

test('a Unity project asks for the Unity found, and has valid JSON and the standard modules', () => {
  const files = unityFiles(opts([engine('unity', '2022.3.10f1'), engine('unity', '6000.0.23f1')]));
  assert.deepEqual(files.map((f) => f.path), ['Packages/manifest.json', 'ProjectSettings/ProjectVersion.txt', 'Assets/Scripts/Spin.cs', 'README.md']);
  assert.equal(byPath(files, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 6000.0.23f1\n', 'the newest');
  const manifest = JSON.parse(byPath(files, 'Packages/manifest.json'));
  assert.isAbove(Object.keys(manifest.dependencies).length, 5);
  for (const k of Object.keys(manifest.dependencies)) assert.match(k, /^com\.unity\.modules\./);
  assert.match(byPath(files, 'Assets/Scripts/Spin.cs'), /class Spin : MonoBehaviour/);
  assert.match(byPath(unityFiles(opts()), 'README.md'), /Unity was not found on this PC/);
});

test('the Unity script is balanced C#', () => {
  const cs = byPath(unityFiles(opts()), 'Assets/Scripts/Spin.cs');
  assert.equal([...cs].filter((c) => c === '{').length, [...cs].filter((c) => c === '}').length);
  assert.equal([...cs].filter((c) => c === '(').length, [...cs].filter((c) => c === ')').length);
});

function pythonAvailable(): string | null {
  for (const exe of ['python', 'python3', 'py']) {
    try {
      execFileSync(exe, ['--version'], { stdio: 'ignore' });
      return exe;
    } catch {
      /* try the next */
    }
  }
  return null;
}

test.skipIf(!pythonAvailable())('the Blender script is valid Python', () => {
  const py = pythonAvailable()!;
  const dir = mkdtempSync(join(tmpdir(), 'atlas-blender-'));
  try {
    const file = join(dir, 'scene.py');
    writeFileSync(file, byPath(blenderFiles(opts()), 'scene.py'), 'utf8');
    execFileSync(py, ['-m', 'py_compile', file]); // throws on a syntax error
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the Blender script only uses bpy, math and os, and never runs anything', () => {
  const py = byPath(blenderFiles(opts()), 'scene.py');
  expect([...py.matchAll(/^import (\w+)/gm)].map((m) => m[1]).sort()).toEqual(['bpy', 'math', 'os']);
  assert.notMatch(py, /subprocess|os\.system|eval\(|exec\(|urllib|requests|socket|__import__/);
  assert.include(py, 'save_as_mainfile');
  assert.match(byPath(blenderFiles(opts([engine('blender', '4.2')])), 'README.md'), /Blender 4\.2 was found/);
});

test('each is found by what people say, and a request builds only the project (the editor is never opened)', () => {
  assert.equal(chooseTemplate('a godot game')?.id, 'godot');
  assert.equal(chooseTemplate('a unity project')?.id, 'unity');
  assert.equal(chooseTemplate('a blender scene')?.id, 'blender');
  const g = new Grammar();
  g.addMany(createCoreGrammar(new WorkingMemory()));
  g.addMany(createExtraGrammar());
  for (const [text, id] of [
    ['build me a godot project in D:\\Dev\\Orb', 'godot'],
    ['make a unity game in D:\\Dev\\Orb', 'unity'],
    ['create a blender project in D:\\Dev\\Orb', 'blender'],
  ] as const) {
    const plan = g.parse(text);
    expect(plan?.steps.map((s) => s.skill), text).toEqual(['app.scaffold', 'project.check']);
    expect(plan?.steps[0]?.args).toMatchObject({ template: id, path: 'D:\\Dev\\Orb' });
  }
  assert.equal(templateById('godot')?.launch, 'project.godot');
});
