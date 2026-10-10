/**
 * Two things the loop does so a small, slow local model finishes sooner and honestly:
 *  - a file written exactly as it already is is not written again (a step the model wasted minutes on);
 *  - "done" after files changed, with nothing having vouched for them, makes Atlas run project.check
 *    itself: a pass makes the report verified, a failure goes back to the model to repair.
 * Real SkillRegistry and Executor; only the model and two skills are scripted.
 */

import { assert, expect, test } from 'vitest';
import type { IntelligenceProvider, IntelligenceRegistry, Skill, SkillContext } from '@atlas/core';
import { SkillRegistry } from '../src/skills/registry';
import { Executor } from '../src/planner/executor';
import { runDevTask } from '../src/devagent/loop';

const ctx = () => ({ say() {}, confirm: async () => true }) as unknown as SkillContext;

function modelThat(replies: string[]): IntelligenceProvider & { prompts: string[] } {
  const provider = {
    id: 'test',
    label: 'Test',
    prompts: [] as string[],
    isConfigured: () => true,
    isLocal: () => true,
    ask(prompt: string, handlers: { onDone: (full: string) => void }) {
      provider.prompts.push(prompt);
      handlers.onDone(replies[Math.min(provider.prompts.length, replies.length) - 1]!);
    },
  };
  return provider;
}

const registry = (p: IntelligenceProvider): IntelligenceRegistry => ({
  register: () => {},
  get: () => p,
  list: () => [p],
  active: () => p,
  setActive: () => {},
});

function rig(checkResults: Array<{ ok: boolean; text: string }>) {
  const created: string[] = [];
  const checks: string[] = [];
  const skills = new SkillRegistry({ capabilities: () => ['devtools', 'fs'] });
  const params = {
    path: { type: 'string' as const, required: false, description: 'path' },
    content: { type: 'string' as const, required: false, description: 'content' },
  };
  const create: Skill = {
    id: 'files.create',
    label: 'Create a file',
    domain: 'files',
    description: 'Create a file.',
    risk: 'safe',
    params,
    run: async (a) => {
      created.push(String(a.path));
      return { ok: true, message: `Created ${a.path}` };
    },
  };
  const check: Skill = {
    id: 'project.check',
    label: 'Check',
    domain: 'project',
    description: 'Check the project.',
    risk: 'safe',
    params,
    run: async (a) => {
      checks.push(String(a.path));
      const r = checkResults.shift() ?? { ok: true, text: 'fine' };
      return { ok: true, message: r.text, data: { ok: r.ok } };
    },
  };
  skills.registerMany([create, check]);
  return { skills, created, checks };
}

const file = (path: string, content: string) => JSON.stringify({ skill: 'files.create', args: { path, content } });
const done = JSON.stringify({ done: true, summary: 'Built it.' });

test('the same file written exactly the same way is not written twice', async () => {
  const { skills, created } = rig([]);
  const model = modelThat([file('D:\\p\\a.txt', 'one'), file('D:\\p\\a.txt', 'one'), done]);
  const report = await runDevTask('create a.txt in D:\\p', 'D:\\p', { skills, intelligence: registry(model), executor: new Executor(skills), getExecutionMode: () => 'doIt' }, ctx());
  expect(created).toEqual(['D:\\p\\a.txt']);
  expect(model.prompts[2]).toMatch(/already written exactly like that/);
  assert.equal(report.stoppedBecause, 'done');
});

test('a changed file IS written again: repairing is not blocked', async () => {
  const { skills, created } = rig([]);
  const model = modelThat([file('D:\\p\\a.txt', 'one'), file('D:\\p\\a.txt', 'two'), done]);
  await runDevTask('create a.txt in D:\\p', 'D:\\p', { skills, intelligence: registry(model), executor: new Executor(skills), getExecutionMode: () => 'doIt' }, ctx());
  expect(created).toEqual(['D:\\p\\a.txt', 'D:\\p\\a.txt']);
});

test('"done" with nothing checked makes Atlas run project.check itself, and a pass is verified', async () => {
  const { skills, checks } = rig([{ ok: true, text: 'all there' }]);
  const model = modelThat([file('D:\\p\\a.txt', 'one'), done]);
  const report = await runDevTask('create a.txt in D:\\p', 'D:\\p', { skills, intelligence: registry(model), executor: new Executor(skills), getExecutionMode: () => 'doIt' }, ctx());
  expect(checks).toEqual(['D:\\p']);
  assert.isTrue(report.ok);
  assert.isTrue(report.verified);
  // One model call per step, plus none for the check: file, then done.
  expect(model.prompts).toHaveLength(2);
});

test('a failed check goes back to the model to repair, then is checked again once', async () => {
  const { skills, checks, created } = rig([
    { ok: false, text: 'index.html loads app.js, which is not there' },
    { ok: true, text: 'all there' },
  ]);
  const model = modelThat([file('D:\\p\\index.html', 'x'), done, file('D:\\p\\app.js', 'y'), done]);
  const report = await runDevTask('create a page in D:\\p', 'D:\\p', { skills, intelligence: registry(model), executor: new Executor(skills), getExecutionMode: () => 'doIt' }, ctx());
  expect(model.prompts[2]).toMatch(/Atlas ran project\.check itself[\s\S]*app\.js, which is not there/);
  expect(created).toEqual(['D:\\p\\index.html', 'D:\\p\\app.js']);
  // Atlas looks once on its own; the model's own later check is its to run.
  expect(checks).toEqual(['D:\\p']);
  assert.equal(report.stoppedBecause, 'done');
});

test('a task that changed nothing is not checked', async () => {
  const { skills, checks } = rig([]);
  const model = modelThat([JSON.stringify({ done: true, summary: 'Nothing to do.' })]);
  const report = await runDevTask('explain this project', 'D:\\p', { skills, intelligence: registry(model), executor: new Executor(skills), getExecutionMode: () => 'doIt' }, ctx());
  expect(checks).toEqual([]);
  assert.isTrue(report.ok);
});
