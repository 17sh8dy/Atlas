/**
 * An Unreal Engine 5 project, written as plain text.
 *
 * A content-only (Blueprint) Unreal project is a `.uproject` JSON file plus a Config folder; the
 * editor creates everything else the first time it opens it. So Atlas can start one with no model
 * and no engine running. What it writes:
 *
 *   <Name>.uproject               the project, pointed at the engine version found on this PC
 *   Config/DefaultEngine.ini      desktop target, maximum graphics
 *   Config/DefaultGame.ini        the project's name
 *   Scripts/build_starter_level.py  run once from the editor: makes a small playable level
 *   README.md                     how to open it, and what to do next
 *
 * It does NOT open the editor. That is a heavy program (it compiles shaders and uses the GPU), so
 * opening it is left to the person: double-click the .uproject, or say "play it".
 *
 * Verified against a real Unreal Engine 5.7 install (2026-10-03): `UnrealEditor-Cmd.exe <project>
 * -run=pythonscript -script=build_starter_level.py -nullrhi` loaded the project, ran the script
 * ("Python script executed successfully", "Created /Game/Maps/StarterMap") and saved the level, in
 * about 8 seconds on the CPU with no GPU use. NOT verified: opening it in the full editor window and
 * pressing Play, which is a heavy GPU program that was deliberately not started.
 */

import type { EngineInfo } from '@atlas/core';
import type { AppTemplate, TemplateFile, TemplateOptions } from './types';

/** A project name Unreal accepts: letters and digits, starting with a letter. */
export function pascalFor(name: string): string {
  const words = name.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  let p = words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join('');
  if (!p) p = 'MyGame';
  if (/^[0-9]/.test(p)) p = 'Game' + p;
  return p.slice(0, 40);
}

/** The newest Unreal install found, as the version string a .uproject wants ("5.7"). */
export function newestUnreal(engines: readonly EngineInfo[] | undefined): EngineInfo | undefined {
  const versionKey = (v: string) => v.split('.').map((n) => parseInt(n, 10) || 0);
  return [...(engines ?? [])]
    .filter((e) => e.kind === 'unreal' && /^\d+\.\d+/.test(e.version))
    .sort((a, b) => {
      const x = versionKey(a.version), y = versionKey(b.version);
      return (y[0]! - x[0]!) || (y[1]! - x[1]!);
    })[0];
}

const STARTER_SCRIPT = String.raw`"""
Builds a small playable starter level in this project: a floor, a ring of cubes, lights and a
player start. Run it ONCE from inside the Unreal Editor:

    Tools > Execute Python Script...   (choose this file)

or paste this into the Output Log (set it to Cmd):   py "<full path to this file>"

It makes the level /Game/Maps/StarterMap and saves it. Press Play to walk around it.
"""
import math
import unreal

MAP = "/Game/Maps/StarterMap"

actors = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
levels = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)


def mesh(name):
    return unreal.EditorAssetLibrary.load_asset("/Engine/BasicShapes/%s.%s" % (name, name))


def spawn_shape(shape, location, scale, label):
    actor = actors.spawn_actor_from_class(unreal.StaticMeshActor, location)
    actor.set_actor_label(label)
    actor.set_actor_scale3d(scale)
    actor.get_editor_property("static_mesh_component").set_static_mesh(mesh(shape))
    return actor


if unreal.EditorAssetLibrary.does_asset_exist(MAP):
    unreal.log_warning("%s already exists, so nothing was changed." % MAP)
else:
    levels.new_level(MAP)
    spawn_shape("Cube", unreal.Vector(0, 0, -50), unreal.Vector(40, 40, 1), "Floor")
    for i in range(8):
        angle = i * math.pi / 4
        spawn_shape("Cube", unreal.Vector(700 * math.cos(angle), 700 * math.sin(angle), 50), unreal.Vector(1.5, 1.5, 2 + i % 3), "Pillar_%d" % i)
    spawn_shape("Sphere", unreal.Vector(0, 0, 150), unreal.Vector(2, 2, 2), "Centre")
    actors.spawn_actor_from_class(unreal.DirectionalLight, unreal.Vector(0, 0, 600), unreal.Rotator(0, -45, 30))
    actors.spawn_actor_from_class(unreal.SkyLight, unreal.Vector(0, 0, 400))
    actors.spawn_actor_from_class(unreal.PlayerStart, unreal.Vector(-1400, 0, 100))
    levels.save_current_level()
    unreal.log("Created %s. Press Play." % MAP)
`;

function readme(o: TemplateOptions, version: string, found: boolean): string {
  const p = o.pascal ?? 'MyGame';
  return `# ${o.name}

An Unreal Engine ${version} project, started by Atlas.

## Open it

Double-click **${p}.uproject**${found ? '' : ` (Unreal Engine ${version} was not found on this PC when this was made, so install it from the Epic Games Launcher first, or change "EngineAssociation" in the .uproject to the version you have)`}.
The first open takes a while: Unreal builds its caches. Say **yes** if it offers to create content.

## Make a first level

In the editor choose **Tools > Execute Python Script...** and pick \`Scripts/build_starter_level.py\`.
It builds a small level (floor, pillars, lights, a player start) as /Game/Maps/StarterMap. Press **Play**.

## What this project is

A content-only project: you build with Blueprints and the editor, and the Python Editor Scripting
plugin is switched on so scripts like the one above can build levels and assets for you.
For C++, use **Tools > New C++ Class** in the editor (you need Visual Studio with the
"Game development with C++" workload).

## When a game gets big

Hand-written projects like Atlas's Snake or Breakout stop making sense for 3D, open worlds and
AAA-scale games. That is exactly what Unreal is for: rendering, physics, animation, audio, networking,
the editor and the asset pipeline. Keep Atlas for the scripts, tools and small projects around it.

## Files

- \`${p}.uproject\` the project
- \`Config/\` engine and game settings
- \`Scripts/build_starter_level.py\` the starter level script
`;
}

export const unrealProject: AppTemplate = {
  id: 'unreal',
  label: 'an Unreal Engine project',
  summary: 'a new Unreal Engine 5 project (Blueprint, with Python editor scripting) and a script that builds a small starter level',
  group: 'engine',
  words: ['unreal engine project', 'unreal project', 'unreal engine game', 'ue5 project', 'ue5 game', 'unreal engine 5', 'unreal engine', 'ue5'],
  desktop: false,
  launch: 'MyGame.uproject',
  launchFile: (o) => `${o.pascal ?? 'MyGame'}.uproject`,
  tip: 'Double-click the .uproject to open it in Unreal Engine (it is not opened for you: the editor is a heavy program). Then run Scripts/build_starter_level.py from Tools > Execute Python Script.',
  source: 'built-in',
  files(o: TemplateOptions): TemplateFile[] {
    const p = o.pascal ?? 'MyGame';
    const engine = newestUnreal(o.engines);
    const version = engine?.version ?? '5.7';
    const uproject = {
      FileVersion: 3,
      EngineAssociation: version,
      Category: '',
      Description: o.name,
      Plugins: [
        { Name: 'PythonScriptPlugin', Enabled: true },
        { Name: 'EditorScriptingUtilities', Enabled: true },
      ],
    };
    return [
      { path: `${p}.uproject`, content: JSON.stringify(uproject, null, '\t') + '\n' },
      {
        path: 'Config/DefaultEngine.ini',
        content: '[/Script/HardwareTargeting.HardwareTargetingSettings]\nTargetedHardwareClass=Desktop\nAppliedTargetedHardwareClass=Desktop\nDefaultGraphicsPerformance=Maximum\nAppliedDefaultGraphicsPerformance=Maximum\n',
      },
      { path: 'Config/DefaultGame.ini', content: `[/Script/EngineSettings.GeneralProjectSettings]\nProjectName=${o.name}\nCompanyName=\n` },
      { path: 'Scripts/build_starter_level.py', content: STARTER_SCRIPT },
      { path: 'README.md', content: readme(o, version, Boolean(engine)) },
    ];
  },
};
