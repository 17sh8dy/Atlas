/**
 * Godot, Unity and Blender projects, written as plain text.
 *
 * Like the Unreal template, these write the files an engine reads when it opens a project, and
 * nothing else: no download, no install, no editor started. Atlas only checks whether the program
 * is already on the PC (`Platform.gameEngines`) so a project can point at the right version.
 *
 * ⚠️ NONE OF THE THREE WAS RUN AGAINST THE REAL PROGRAM. Godot, Unity and Blender are not installed on
 * the PC these were written on (Unreal was, and its template is verified; see `unreal.ts`). What is
 * checked is what can be checked without them: the JSON parses, the Python compiles, every path is
 * safe and the project follows the layout each engine documents. If one fails to open, the README in
 * the project says what to look at, and a fix belongs in this file.
 */

import type { EngineInfo } from '@atlas/core';
import type { AppTemplate, TemplateFile, TemplateOptions } from './types';

/** The newest detected install of a kind, by dotted version. */
function newest(engines: readonly EngineInfo[] | undefined, kind: EngineInfo['kind']): EngineInfo | undefined {
  const key = (v: string) => v.split(/[.\-f]/).map((n) => parseInt(n, 10) || 0);
  return [...(engines ?? [])]
    .filter((e) => e.kind === kind && /^\d/.test(e.version))
    .sort((a, b) => {
      const x = key(a.version), y = key(b.version);
      for (let i = 0; i < 3; i++) if ((y[i] ?? 0) !== (x[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
      return 0;
    })[0];
}

// ------------------------------------------------------------------------------------ GODOT

const GODOT_PLAYER = `extends CharacterBody2D
# Move with the arrow keys / WASD (Godot's built-in "ui_*" actions).

@export var speed: float = 320.0


func _physics_process(_delta: float) -> void:
	var direction := Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")
	velocity = direction * speed
	move_and_slide()
`;

function godotScene(): string {
  return [
    '[gd_scene load_steps=3 format=3]',
    '',
    '[ext_resource type="Script" path="res://player.gd" id="1_player"]',
    '',
    '[sub_resource type="RectangleShape2D" id="RectangleShape2D_player"]',
    'size = Vector2(32, 32)',
    '',
    '[node name="Main" type="Node2D"]',
    '',
    '[node name="Player" type="CharacterBody2D" parent="."]',
    'position = Vector2(576, 324)',
    'script = ExtResource("1_player")',
    '',
    '[node name="Shape" type="CollisionShape2D" parent="Player"]',
    'shape = SubResource("RectangleShape2D_player")',
    '',
    '[node name="Body" type="Polygon2D" parent="Player"]',
    'color = Color(0.66, 0.33, 0.97, 1)',
    'polygon = PackedVector2Array(-16, -16, 16, -16, 16, 16, -16, 16)',
    '',
    '[node name="Camera" type="Camera2D" parent="Player"]',
    '',
  ].join('\n');
}

export function godotFiles(o: TemplateOptions): TemplateFile[] {
  const found = newest(o.engines, 'godot');
  const feature = found && /^\d+\.\d+/.test(found.version) ? found.version.match(/^\d+\.\d+/)![0] : '4.3';
  const name = o.name.replace(/"/g, "'");
  const project = [
    '; Engine configuration file.',
    '; It is best edited using the editor UI and not directly,',
    '; since the parameters that go here are not all obvious.',
    '',
    'config_version=5',
    '',
    '[application]',
    '',
    `config/name="${name}"`,
    'run/main_scene="res://main.tscn"',
    `config/features=PackedStringArray("${feature}")`,
    '',
    '[display]',
    '',
    'window/size/viewport_width=1152',
    'window/size/viewport_height=648',
    '',
  ].join('\n');
  return [
    { path: 'project.godot', content: project },
    { path: 'main.tscn', content: godotScene() },
    { path: 'player.gd', content: GODOT_PLAYER },
    {
      path: 'README.md',
      content: `# ${o.name}

A Godot ${feature} project, started by Atlas: a purple square you move with the arrow keys.

## Open it

Start Godot, choose **Import**, and pick \`project.godot\` in this folder. Press **F5** to run it.
${found ? '' : '\nGodot was not found on this PC when this was made. Get it from godotengine.org (it is one small file, no installer).\n'}
## Files

- \`project.godot\` the project settings
- \`main.tscn\` the starting scene: a player and a camera
- \`player.gd\` the script that moves the player

## If it will not open

This project was written without Godot to test it on. If Godot reports an error in \`main.tscn\`, open
it in a text editor: it is a plain list of nodes and is easy to fix by hand.

## When a game gets big

Godot is a real game engine: scenes, physics, animation, audio, export to many platforms. Keep growing
the game here rather than in hand-written code.
`,
    },
  ];
}

export const godotProject: AppTemplate = {
  id: 'godot',
  label: 'a Godot project',
  summary: 'a new Godot 4 project: a scene with a player you move around, ready to grow into a game',
  group: 'engine',
  words: ['godot project', 'godot game', 'godot engine project', 'godot 4 project', 'godot'],
  desktop: false,
  launch: 'project.godot',
  tip: 'Start Godot, choose Import, and pick project.godot (it is not opened for you). Press F5 to run it.',
  source: 'built-in',
  files: godotFiles,
};

// ------------------------------------------------------------------------------------ UNITY

const UNITY_SCRIPT = `using UnityEngine;

// Attach this to any object to spin it. Edit the numbers in the Inspector.
public class Spin : MonoBehaviour
{
    public Vector3 degreesPerSecond = new Vector3(0f, 45f, 0f);

    void Update()
    {
        transform.Rotate(degreesPerSecond * Time.deltaTime);
    }
}
`;

export function unityFiles(o: TemplateOptions): TemplateFile[] {
  const found = newest(o.engines, 'unity');
  const version = found?.version ?? '6000.0.23f1';
  const manifest = {
    dependencies: {
      'com.unity.modules.animation': '1.0.0',
      'com.unity.modules.audio': '1.0.0',
      'com.unity.modules.imgui': '1.0.0',
      'com.unity.modules.jsonserialize': '1.0.0',
      'com.unity.modules.particlesystem': '1.0.0',
      'com.unity.modules.physics': '1.0.0',
      'com.unity.modules.physics2d': '1.0.0',
      'com.unity.modules.ui': '1.0.0',
      'com.unity.modules.uielements': '1.0.0',
    },
  };
  return [
    { path: 'Packages/manifest.json', content: JSON.stringify(manifest, null, 2) + '\n' },
    { path: 'ProjectSettings/ProjectVersion.txt', content: `m_EditorVersion: ${version}\n` },
    { path: 'Assets/Scripts/Spin.cs', content: UNITY_SCRIPT },
    {
      path: 'README.md',
      content: `# ${o.name}

A Unity project (${version}), started by Atlas, with one example script (\`Assets/Scripts/Spin.cs\`).

## Open it

Start **Unity Hub**, choose **Add > Add project from disk**, and pick this folder. ${found ? `Unity ${found.version} was found on this PC and the project asks for that version.` : `Unity was not found on this PC when this was made, so the project asks for ${version}: install a Unity editor from Unity Hub, or change \`m_EditorVersion\` in ProjectSettings/ProjectVersion.txt to the version you have.`}
The first open takes a while: Unity builds its caches and creates the rest of the project.

## First steps

Make a scene (**File > New Scene**), add a Cube (**GameObject > 3D Object > Cube**), drag \`Spin.cs\` onto it and press **Play**.

## If it will not open

This project was written without Unity to test it on. If Hub complains about the version, edit
\`ProjectSettings/ProjectVersion.txt\`. If it complains about a package, delete the line in
\`Packages/manifest.json\`.

## When a game gets big

Unity is a real game engine. Keep growing the game there, and use Atlas for the scripts and tools around it.
`,
    },
  ];
}

export const unityProject: AppTemplate = {
  id: 'unity',
  label: 'a Unity project',
  summary: 'a new Unity project with the standard modules and an example script that spins an object',
  group: 'engine',
  words: ['unity project', 'unity game', 'unity engine project', 'unity3d project', 'unity'],
  desktop: false,
  launch: 'README.md',
  tip: 'Start Unity Hub, choose Add > Add project from disk and pick the folder (it is not opened for you).',
  source: 'built-in',
  files: unityFiles,
};

// ------------------------------------------------------------------------------------ BLENDER

const BLENDER_SCRIPT = `"""
Builds a small scene: a floor, a ring of cubes, a sphere, a light and a camera.

Run it in Blender:   Scripting tab > Open > this file > Run Script (the play button)
Or from a terminal:  blender --background --python scene.py

It saves scene.blend next to this file. Change the numbers and run it again.
"""
import math
import os

import bpy

# Start from an empty scene.
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def add_cube(location, size, name):
    bpy.ops.mesh.primitive_cube_add(size=size, location=location)
    obj = bpy.context.active_object
    obj.name = name
    return obj


floor = add_cube((0, 0, -0.5), 1, "Floor")
floor.scale = (12, 12, 0.5)

for i in range(8):
    angle = i * math.pi / 4
    add_cube((4 * math.cos(angle), 4 * math.sin(angle), 0.5 + (i % 3) * 0.5), 1, "Pillar_%d" % i)

bpy.ops.mesh.primitive_uv_sphere_add(radius=1.2, location=(0, 0, 1.2))
bpy.context.active_object.name = "Centre"

bpy.ops.object.light_add(type="SUN", location=(6, -6, 10))
bpy.context.active_object.data.energy = 3.0

bpy.ops.object.camera_add(location=(9, -9, 7), rotation=(math.radians(60), 0, math.radians(45)))
scene.camera = bpy.context.active_object

here = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else os.getcwd()
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(here, "scene.blend"))
print("Saved scene.blend in", here)
`;

export function blenderFiles(o: TemplateOptions): TemplateFile[] {
  const found = newest(o.engines, 'blender');
  return [
    { path: 'scene.py', content: BLENDER_SCRIPT },
    {
      path: 'README.md',
      content: `# ${o.name}

A Blender project, started by Atlas: a Python script that builds a small 3D scene.

## Use it

${found ? `Blender ${found.version} was found on this PC.` : 'Blender was not found on this PC when this was made. It is free from blender.org.'}

1. Open Blender, go to the **Scripting** tab, choose **Open**, pick \`scene.py\`, and press the play button.
2. Or without opening a window: \`blender --background --python scene.py\`

It saves \`scene.blend\` next to the script. To see an image: \`blender --background scene.blend --render-output //render --render-frame 1\`.

## If it will not run

This script was written without Blender to test it on; it uses only long-standing \`bpy\` calls. If Blender
names a line, the numbers at the top of each block are the easiest thing to change.

## Going further

Blender is a full 3D package: modelling, sculpting, animation, rendering. Atlas can keep helping with
Python scripts like this one.
`,
    },
  ];
}

export const blenderProject: AppTemplate = {
  id: 'blender',
  label: 'a Blender project',
  summary: 'a Blender Python script that builds a small 3D scene (floor, pillars, sphere, light, camera) and saves it as a .blend',
  group: 'engine',
  words: ['blender project', 'blender script', 'blender scene', 'blender python', 'blender'],
  desktop: false,
  launch: 'scene.py',
  tip: 'In Blender open the Scripting tab, open scene.py and run it (Blender is not opened for you).',
  source: 'built-in',
  files: blenderFiles,
};
