/**
 * Plugins and game engines, as things a person can ask about.
 *
 *   plugin.list        "what plugins do I have"
 *   plugin.reload      "reload my plugins"
 *   plugin.openFolder  "open the plugins folder"
 *   engine.list        "what game engines do I have"
 *   engine.advise      the honest answer to "make me an AAA game": that needs a real engine
 *
 * All are read-only or open a folder Atlas itself owns, so none asks. They say what is actually
 * installed (from `Platform.gameEngines`, which only reports editors that exist on disk) rather
 * than what Atlas hopes is there.
 */

import type { EngineInfo, Platform, Skill } from '@atlas/core';
import { allTemplates } from '../templates';
import { loadPlugins, pluginReport } from '../plugins/host';

const NAMES: Record<string, string> = { unreal: 'Unreal Engine', unity: 'Unity', godot: 'Godot' };

function describeEngines(engines: readonly EngineInfo[]): string[] {
  return engines.map((e) => `${NAMES[e.kind] ?? e.kind} ${e.version}`.trim());
}

/** The words of advice when a request has outgrown a hand-written project. */
export function engineAdvice(engines: readonly EngineInfo[], request = ''): string {
  const intro =
    "That is past what a hand-written project can do. Anything 3D, open-world or AAA-scale needs a real game engine: it supplies the renderer, physics, animation, audio, networking, editor and asset pipeline that would take a team years to write from scratch. I can build small games and tools on my own (Snake, 2048, Breakout and so on), and I can set up the project for a real engine and keep helping with the scripts and tools around it.";
  const unreal = engines.filter((e) => e.kind === 'unreal');
  const others = engines.filter((e) => e.kind !== 'unreal');
  const lines: string[] = [intro, ''];
  if (engines.length) {
    lines.push(`On this PC I can see: ${describeEngines(engines).join(', ')}.`);
    if (unreal.length) lines.push('Say “build me an Unreal Engine project in D:\\Dev\\MyGame” and I will write the project and a script that builds a starter level. I will not open the editor for you; it is a heavy program, so that is yours to start.');
    if (others.length) lines.push(`I can see ${describeEngines(others).join(' and ')} too, but I do not have a project template for ${others.length === 1 ? 'it' : 'them'} yet. A plugin can add one (say “open the plugins folder”).`);
  } else {
    lines.push('I do not see Unreal Engine, Unity or Godot installed on this PC. Godot is free and small (godotengine.org); Unreal Engine comes from the Epic Games Launcher; Unity from Unity Hub. Once one is installed, say “what game engines do I have”.');
  }
  if (request && /\b(?:aaa|triple[- ]?a)\b/i.test(request)) {
    lines.push('', 'A word on “AAA”: those games are built by hundreds of people over years, on an engine and a large library of art, so the goal for one person is a slice of it, or a smaller game built the same way.');
  }
  return lines.join('\n');
}

export function createPluginSkills(platform: Platform): Skill[] {
  return [
    {
      id: 'engine.list',
      label: 'Which game engines do I have',
      icon: '🎮',
      domain: 'project',
      description: 'List the game engine editors (Unreal Engine, Unity, Godot) really installed on this PC.',
      needs: ['devtools'],
      risk: 'safe',
      examples: ['what game engines do I have'],
      params: {},
      async run() {
        const engines = (await platform.gameEngines?.().catch(() => [])) ?? [];
        if (!engines.length) {
          return { ok: true, message: 'I do not see Unreal Engine, Unity or Godot installed on this PC.', data: engines };
        }
        const rows = engines.map((e) => `• ${NAMES[e.kind] ?? e.kind} ${e.version} — ${e.editor}`);
        const unreal = engines.some((e) => e.kind === 'unreal');
        return {
          ok: true,
          message: `Game engines on this PC:\n${rows.join('\n')}${unreal ? '\n\nI can start an Unreal project for you: say “build me an Unreal Engine project in D:\\Dev\\MyGame”.' : ''}`,
          data: engines,
        };
      },
    },
    {
      id: 'engine.advise',
      label: 'When a game needs a real engine',
      icon: '🧭',
      domain: 'project',
      description: 'Explain that a 3D, open-world or AAA-scale game needs a real game engine, and say which engines are installed and what Atlas can set up.',
      needs: ['devtools'],
      risk: 'safe',
      examples: ['I want to build an AAA open world game'],
      params: { request: { type: 'string', required: false, description: 'what the person asked for' } },
      async run(args) {
        const engines = (await platform.gameEngines?.().catch(() => [])) ?? [];
        return { ok: true, message: engineAdvice(engines, String(args.request ?? '')), data: engines };
      },
    },
    {
      id: 'plugin.list',
      label: 'Which plugins do I have',
      icon: '🧩',
      domain: 'project',
      description: 'List the installed plugins and what each one adds, including any that were refused and why.',
      needs: ['devtools'],
      risk: 'safe',
      examples: ['what plugins do I have'],
      params: {},
      async run() {
        const report = pluginReport();
        const builtIn = allTemplates().filter((t) => t.source === 'built-in');
        const named = (group: string) => builtIn.filter((t) => t.group === group).map((t) => t.label.replace(/^an? /, '').replace(/\s+(?:game|app)$/, ''));
        const lines = [
          `Built in (${builtIn.length} projects, no plugin needed):`,
          `• Games: ${named('game').join(', ')}`,
          `• Tools: ${named('tool').join(', ')}`,
          `• Game engines: ${named('engine').join(', ') || 'none'}`,
          `• Starters: ${named('starter').join(', ')}`,
        ];
        if (report.loaded.length) {
          lines.push('', 'Installed plugins:');
          for (const p of report.loaded) {
            lines.push(`• ${p.name} ${p.version}${p.author ? ` by ${p.author}` : ''} — ${p.description || 'no description'}`);
            for (const t of p.templates) lines.push(`    adds ${t.label.replace(/^an? /, '')} (${t.group})`);
          }
        } else {
          lines.push('', 'No plugins are installed. A plugin is a folder with a plugin.json in it; say “open the plugins folder”.');
        }
        if (report.rejected.length) {
          lines.push('', 'Refused:');
          for (const r of report.rejected) lines.push(`• ${r.folder}: ${r.errors.slice(0, 3).join(' ')}${r.errors.length > 3 ? ` (and ${r.errors.length - 3} more)` : ''}`);
        }
        return { ok: true, message: lines.join('\n'), data: report };
      },
    },
    {
      id: 'plugin.reload',
      label: 'Reload plugins',
      icon: '🔄',
      domain: 'project',
      description: 'Read the plugins folder again and register what it holds.',
      needs: ['devtools'],
      risk: 'safe',
      examples: ['reload my plugins'],
      params: {},
      async run() {
        const report = await loadPlugins(platform);
        const bad = report.rejected.length ? ` ${report.rejected.length} ${report.rejected.length === 1 ? 'was' : 'were'} refused; say “what plugins do I have” for why.` : '';
        return { ok: true, message: `Loaded ${report.loaded.length} plugin${report.loaded.length === 1 ? '' : 's'}.${bad}`, data: report };
      },
    },
    {
      id: 'plugin.openFolder',
      label: 'Open the plugins folder',
      icon: '📂',
      domain: 'project',
      description: 'Open the folder where plugins go, creating it if needed.',
      needs: ['devtools'],
      risk: 'safe',
      examples: ['open the plugins folder'],
      params: {},
      async run() {
        if (!platform.openPluginsFolder) return { ok: false, error: "I can't open folders on this device." };
        try {
          const dir = await platform.openPluginsFolder();
          return { ok: true, message: `Opened ${dir}. Each plugin is a folder with a plugin.json in it; say “reload my plugins” after adding one.` };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
  ];
}
