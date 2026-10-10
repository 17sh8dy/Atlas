/**
 * "I couldn't find an app called “there is not app, you have to build it”".
 *
 * The sentence was typed into the "what is it called?" box and read as a name. It is an instruction:
 * the thing does not exist, so build it. Checked at the three places it can arrive — the text
 * classifier, the open-app skill's question, and a fresh message right after "open X".
 */

import { expect, test } from 'vitest';
import { classifyTyped } from '../src/skills/ask-where';
import { buildSentenceFor, isBuildItRedirect, openTargetOf } from '../src/text/build-redirect';
import { parseBuildRequest } from '../src/planner/app-grammar';

test.each([
  'there is not an app, you have to build it',
  'There is not an app, you have to build it.',
  "there isn't one, build it",
  "it doesn't exist, make it",
  'no app, you need to create it',
  'you have to build it',
  'build it',
  'just make it yourself',
  'then create one for me',
  'could you build it for me',
])('%s is an instruction to build', (text) => {
  expect(isBuildItRedirect(text)).toBe(true);
  expect(classifyTyped(text)).toEqual({ kind: 'build' });
});

test.each([
  'Notepad++',
  'C:\\Program Files\\App\\app.exe',
  'build.exe',
  'open the build folder',
  'make it so',
  'discord',
  'there is a new app called steam',
  'visual studio code',
])('%s is still a name or a place', (text) => {
  expect(isBuildItRedirect(text)).toBe(false);
  expect(classifyTyped(text).kind).not.toBe('build');
});

test('what was being opened is remembered, and only for an open request', () => {
  expect(openTargetOf('open Nova.Play')).toBe('Nova.Play');
  expect(openTargetOf('launch the Infinite Clicker app')).toBe('Infinite Clicker');
  expect(openTargetOf('could you please start my budget tracker')).toBe('budget tracker');
  expect(openTargetOf('build me a clicker game')).toBeNull();
  expect(openTargetOf('what is the weather')).toBeNull();
});

test('the subject becomes a build request the existing rules understand', () => {
  // A thing Atlas has a ready-made version of: built from it, no model.
  expect(parseBuildRequest(buildSentenceFor('Infinite Clicker'))).toMatchObject({ template: 'clicker' });
  // Anything else: a named app, and Atlas asks which kind and where.
  const sentence = buildSentenceFor('Nova.Play');
  expect(sentence).toBe('build me an app called Nova.Play');
  expect(parseBuildRequest(sentence)).toMatchObject({ name: 'Nova.Play' });
});

// ------------------------------------------------------------------ through the real engine

import type { AppEntry, Clarification, ClarifyAnswer, Platform, Skill } from '@atlas/core';
import { Engine, type EngineIO } from '../src/engine';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { WorkingMemory } from '../src/working-memory';
import { SkillRegistry } from '../src/skills/registry';
import { createCoreSkills } from '../src/skills/core-skills';
import { createAppScaffoldSkills } from '../src/skills/app-scaffold-skills';
import { createPhrasing } from '../src/phrasing';

function rig(answers: ClarifyAnswer[]) {
  const platform = {
    listApps: async () => [] as AppEntry[],
    launchApp: async () => true,
    openUrl: async () => true,
    openPath: async () => true,
    listWindows: async () => [],
    focusWindow: async () => true,
    searchFiles: async () => [],
  } as unknown as Platform;
  const memory = { fact: async () => undefined, facts: async () => [], remember: async () => {}, record: async () => {}, episodes: async () => [], forget: async () => {} } as never;
  const skills = new SkillRegistry({
    capabilities: () => ['apps', 'fs', 'window-control', 'network', 'files', 'notifications', 'clipboard', 'os', 'processes', 'system', 'devtools'] as never,
  });
  skills.registerMany(createCoreSkills(platform, memory, skills, createPhrasing()) as Skill[]);
  skills.registerMany(createAppScaffoldSkills(platform) as Skill[]);
  const grammar = new Grammar();
  grammar.addMany(createCoreGrammar(new WorkingMemory()));
  grammar.addMany(createExtraGrammar());
  const engine = new Engine({ skills, grammar });
  const said: string[] = [];
  const questions: Clarification[] = [];
  const queue = [...answers];
  const io: EngineIO = {
    say: (t) => void said.push(t),
    confirm: async () => true,
    showResults: () => undefined,
    clarify: async (q) => {
      questions.push(q);
      return queue.shift() ?? { kind: 'cancelled' };
    },
  };
  return { engine, io, said, questions };
}

test('typed into the "what is it called?" box, the instruction builds instead of searching', async () => {
  const { engine, io, said, questions } = rig([
    { kind: 'text', text: 'there is not an app, you have to build it', many: false },
  ]);
  await engine.ask('open Zorblax', io);
  const text = said.join('\n');
  expect(text).not.toMatch(/couldn.t find an app called .there is not/i);
  expect(text).toMatch(/there is no .Zorblax. on this PC, so I.ll build it/i);
  // The second question is the build's own: which kind of project.
  expect(questions[0]!.question).toMatch(/couldn.t find an app called .Zorblax./i);
  expect(questions[1]?.question ?? '').toMatch(/What kind of project/i);
});

test('the same words as a fresh message right after "open X"', async () => {
  const { engine, io, said, questions } = rig([{ kind: 'cancelled' }]);
  await engine.ask('open Zorblax', io);
  said.length = 0;
  await engine.ask('there is not an app, you have to build it', io);
  expect(said.join('\n')).toMatch(/there is no .Zorblax. to open, so I.ll build it/i);
  expect(questions.some((q) => /What kind of project/i.test(q.question))).toBe(true);
  // And only straight after: with nothing to refer to, it is not turned into a build.
  said.length = 0;
  await engine.ask('what time is it', io);
  said.length = 0;
  await engine.ask('there is not an app, you have to build it', io);
  expect(said.join('\n')).not.toMatch(/so I.ll build it/i);
});
