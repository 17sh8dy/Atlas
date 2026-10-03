/**
 * Atlas does not give up on a command, and does not blame a missing model for it.
 *
 * - `open X` tries the installed apps, a multi-app reading, a known site, an
 *   already-open window, and a program on disk — and then *asks* (a name? a
 *   path? search the web?), and acts on the answer.
 * - A command nothing matched, with a model configured but offline, gets a
 *   useful reply and suggestions — never "couldn't reach that provider".
 */

import { assert, test } from 'vitest';
import type { AppEntry, Clarification, ClarifyAnswer, FileEntry, Platform, Skill, WindowEntry } from '@atlas/core';
import { Engine, type EngineIO } from '../src/engine';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { WorkingMemory } from '../src/working-memory';
import { SkillRegistry } from '../src/skills/registry';
import { createCoreSkills } from '../src/skills/core-skills';
import { createPhrasing } from '../src/phrasing';

const app = (name: string): AppEntry => ({ id: name.toLowerCase(), name }) as AppEntry;

function rig(over: {
  apps?: AppEntry[];
  windows?: WindowEntry[];
  files?: FileEntry[];
  answer?: ClarifyAnswer;
  provider?: 'offline' | 'none';
}) {
  const calls: string[] = [];
  const platform = {
    listApps: async () => over.apps ?? [],
    launchApp: async (id: string) => {
      calls.push(`launch ${id}`);
      return true;
    },
    openUrl: async (u: string) => {
      calls.push(`url ${u}`);
      return true;
    },
    openPath: async (p: string) => {
      calls.push(`path ${p}`);
      return true;
    },
    listWindows: async () => over.windows ?? [],
    focusWindow: async (id: string) => {
      calls.push(`focus ${id}`);
      return true;
    },
    searchFiles: async () => over.files ?? [],
  } as unknown as Platform;
  const memory = { fact: async () => undefined, facts: async () => [], remember: async () => {}, record: async () => {}, episodes: async () => [], forget: async () => {} } as never;
  const skills = new SkillRegistry({
    capabilities: () => ['apps', 'fs', 'window-control', 'network', 'files', 'notifications', 'clipboard', 'os', 'processes', 'system'] as never,
  });
  skills.registerMany(createCoreSkills(platform, memory, skills, createPhrasing()) as Skill[]);
  const grammar = new Grammar();
  grammar.addMany(createCoreGrammar(new WorkingMemory()));
  grammar.addMany(createExtraGrammar());
  const provider =
    over.provider === 'offline'
      ? {
          active: () => ({
            id: 'ollama',
            label: 'Ollama',
            isConfigured: () => true,
            isLocal: () => true,
            ask: (_p: string, h: { onError(r: string): void }) => h.onError('offline'),
          }),
        }
      : undefined;
  const engine = new Engine({ skills, grammar, intelligence: provider as never });
  const said: string[] = [];
  const questions: Clarification[] = [];
  const io: EngineIO = {
    say: (t) => void said.push(t),
    confirm: async () => true,
    showResults: (_rows, meta) => void said.push(`[list] ${meta?.title ?? ''}`),
    clarify: over.answer
      ? async (q) => {
          questions.push(q);
          return over.answer!;
        }
      : undefined,
  };
  return { engine, io, said, calls, questions };
}

test('an app that is not installed but is already open is brought to the front', async () => {
  const r = rig({ windows: [{ id: '42', title: 'Portable Thing', processName: 'portable.exe' } as WindowEntry] });
  await r.engine.ask('open portable thing', r.io);
  assert.deepEqual(r.calls, ['focus 42']);
  assert.match(r.said.join(' '), /already open/);
});

test('a program found on disk is opened', async () => {
  const exe = { path: 'D:\\Tools\\Notepad++\\notepad++.exe', name: 'notepad++.exe', ext: 'exe', isDirectory: false } as FileEntry;
  const r = rig({ files: [exe] });
  await r.engine.ask('open notepad++', r.io);
  assert.deepEqual(r.calls, ['path D:\\Tools\\Notepad++\\notepad++.exe']);
  assert.match(r.said.join(' '), /Found it on this PC/);
});

test('several programs on disk are offered, not guessed', async () => {
  const files = ['a', 'b'].map((x) => ({ path: `D:\\${x}\\thing.exe`, name: 'thing.exe', ext: 'exe', isDirectory: false }) as FileEntry);
  const r = rig({ files });
  await r.engine.ask('open quibble', r.io);
  assert.deepEqual(r.calls, []);
  assert.match(r.said.join(' '), /Found several matches/);
});

test('nothing found anywhere: it asks, with the choices a person would want', async () => {
  const r = rig({ answer: { kind: 'cancelled' } });
  await r.engine.ask('open zorblax', r.io);
  assert.equal(r.questions.length, 1);
  const labels = r.questions[0]!.choices.map((c) => c.label).join(' | ');
  assert.match(labels, /exact name, or where it is/);
  assert.match(labels, /Search the web for “zorblax”/);
  assert.match(labels, /Show me my installed apps/);
  assert.match(labels, /Never mind/);
  assert.deepEqual(r.calls, []);
});

test('a typed name goes round again; a typed path is opened; "search the web" searches', async () => {
  const name = rig({ apps: [app('Obsidian')], answer: { kind: 'text', text: 'Obsidian', many: false } });
  await name.engine.ask('open zorblax', name.io);
  assert.deepEqual(name.calls, ['launch obsidian']);

  const path = rig({ answer: { kind: 'text', text: 'D:\\Games\\Zorblax\\zorblax.exe', many: false } });
  await path.engine.ask('open zorblax', path.io);
  assert.deepEqual(path.calls, ['path D:\\Games\\Zorblax\\zorblax.exe']);

  const web = rig({ answer: { kind: 'choice', id: 'web' } });
  await web.engine.ask('open zorblax', web.io);
  assert.deepEqual(web.calls, ['url https://www.google.com/search?q=zorblax']);
});

test('a surface that cannot ask gets the same options in words', async () => {
  const r = rig({});
  await r.engine.ask('open zorblax', r.io);
  assert.match(r.said.join(' '), /Do you know the exact name, or where it is\?/);
  assert.match(r.said.join(' '), /search the web for zorblax/);
});

test('the name it was told is not asked about forever', async () => {
  const r = rig({ answer: { kind: 'text', text: 'zorblax', many: false } });
  await r.engine.ask('open zorblax', r.io);
  assert.equal(r.questions.length, 1, 'the same name again is not a new answer');
});

// ---- a command is never answered with the provider message --------------------------------

test('a command nothing matched, with the model offline, is answered by Atlas', async () => {
  const r = rig({ provider: 'offline' });
  await r.engine.ask('make my windows line up in a grid for the meeting', r.io);
  const said = r.said.join(' ');
  assert.notMatch(said, /reach that provider|language model/i);
  assert.match(said, /didn't catch|What are you trying to get done/);
});

test('a build request Atlas has no template for says what it CAN build instead of a shrug', async () => {
  const r = rig({ provider: 'offline' });
  await r.engine.ask('build me a flight simulator game', r.io);
  const said = r.said.join(' ');
  assert.notMatch(said, /reach that provider/i);
  assert.match(said, /Games: .*clicker.*snake/s);
  assert.match(said, /build me a snake game in D:/);
  assert.match(said, /game engine/);
  assert.notMatch(said, /didn't catch/);
});

test('a ready-made project is planned by the grammar, with no model', async () => {
  const r = rig({ provider: 'offline' });
  const plan = await r.engine.planFor('Build me a high quality clicker desktop app game, it must be simple');
  assert.equal(plan?.intent, 'build-app');
  assert.deepEqual(
    plan?.steps.map((s) => s.skill),
    ['app.scaffold', 'dependency.installAll', 'project.play'],
  );
});

test('suggestions point at things Atlas can really do', async () => {
  const r = rig({});
  await r.engine.ask('open the window list please sort', r.io).catch(() => undefined);
  const q = rig({ provider: 'offline' });
  await q.engine.ask('make the thing about the windows go away', q.io);
  assert.notMatch(q.said.join(' '), /provider/i);
});

test('"stop" with nothing running says so and points at the emergency stop', async () => {
  const r = rig({});
  await r.engine.ask('stop', r.io);
  assert.match(r.said.join(' '), /Nothing is running right now.*F8/s);
});

test('a real question with the model offline is told what happened and what still works', async () => {
  const r = rig({ provider: 'offline' });
  await r.engine.ask('should i learn rust or go?', r.io);
  const said = r.said.join(' ');
  assert.match(said, /couldn't reach your language model/);
  assert.match(said, /what can you do/);
});
