# Atlas plugins

A plugin adds **project templates** to Atlas: things "build me a …" can write with no model. It is
**data, never code**. Nothing in a plugin folder is run, loaded as a script or handed to a shell.

## Where plugins go

Say "open the plugins folder" (or find `%APPDATA%\dev.atlas.assistant\plugins`). Each plugin is a
folder with one `plugin.json`. After adding or changing one, say "reload my plugins". "What plugins do
I have" lists what loaded, what each adds, and why any were refused.

## plugin.json

```json
{
  "id": "acme-kit",
  "name": "Acme Kit",
  "version": "1.0.0",
  "author": "Acme",
  "description": "Starters for Acme projects.",
  "templates": [
    {
      "id": "acme-site",
      "label": "an Acme website",
      "summary": "the Acme company website skeleton",
      "group": "starter",
      "words": ["acme website", "acme site"],
      "launch": "index.html",
      "tip": "Edit index.html.",
      "files": [
        { "path": "index.html", "content": "<!doctype html><title>{{NAME}}</title><h1>{{NAME}}</h1>" },
        { "path": "css/site.css", "content": "body { margin: 0 }" }
      ]
    }
  ]
}
```

- `id` must be 3-40 lower-case letters, digits and dashes, and **must match the folder name**.
- A template's `id` must be new: a plugin can never replace a built-in project or another plugin's.
- `group` is `game`, `tool`, `starter` or `engine`. Only `engine` projects are not opened for you
  afterwards (an engine editor is a heavy program).
- `words` are the plain phrases people will say ("acme website"): lower case, whole words, no patterns.
  Pick phrases that cannot be an everyday sentence on their own.
- In file **contents**, `{{NAME}}` (how the project is named: "Night Orb"), `{{ID}}` ("night-orb") and
  `{{PASCAL}}` ("NightOrb") are filled in. In file **paths** only `{{ID}}` and `{{PASCAL}}` may be used.
- `launch` is the file to open, and must be one of the template's files. It must be a document or
  project file: `.html`, `.md`, `.txt`, `.uproject`, `.godot` or `.sln`.

## What is refused (and why)

Every byte comes from outside Atlas, so it is checked before it is believed:

| Refused | Why |
| --- | --- |
| a path that is absolute, has `..`, a drive letter, a backslash, an empty part, a Windows-reserved name, or is too long or deep | a plugin can only write inside the project folder it is building |
| a program or shortcut: `.exe .dll .bat .cmd .ps1 .vbs .msi .lnk .reg .jar .sh …` | a plugin can never write something that runs |
| `package.json`, `Play.cmd`, `init_unreal.py` | the first two would install packages or start a program; Unreal runs the third by itself when a project opens |
| `desktop: true` | a desktop template runs `npm install`, which runs whatever the package names |
| more than 20 templates, 60 files per template, 512 KB per file, 4 MB per template | keeps a plugin readable and harmless to load |
| a template id that is already taken | installing a plugin cannot change what a built-in project writes |

Atlas checks the paths **again** when it writes the files, so a bug in one check cannot become a write
outside the folder.

**Installing a plugin is still trusting its author.** A project it writes can contain anything not on
that list (a web page with script in it, an engine project with content), and the browser or engine
that opens it treats it as yours. Read what a plugin adds with "what plugins do I have" first.

## Game engines

"What game engines do I have" looks for Unreal Engine, Unity and Godot where each registers itself
(the registry, the Epic launcher's install list, Unity Hub's folder, the usual Godot places) and reports
only editors that exist on disk. Atlas never starts one.

Built in: **Unreal Engine** projects (`build me an unreal engine project in D:\Dev\MyGame`). It writes a
content-only (Blueprint) project pointed at the newest Unreal found, with Python editor scripting on and
a `Scripts/build_starter_level.py` that builds a small level when run from the editor. Unity and Godot
are detected, and a plugin can add project templates for them.

When a request is past what hand-written code can do (AAA, 3D, open world, "like GTA"), Atlas says so
and points at an engine instead of building a toy.
