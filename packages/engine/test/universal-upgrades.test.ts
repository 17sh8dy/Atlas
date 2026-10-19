/** 2.0.2 agent upgrades: job-aware shelf, advice after steps, "done" checked per kind of job, progress tally. */
import { describe, expect, test } from 'vitest';
import type { IntelligenceProvider, IntelligenceRegistry, Skill, SkillContext } from '@atlas/core';
import { SkillRegistry } from '../src/skills/registry';
import { Executor } from '../src/planner/executor';
import { CapabilityIndex } from '../src/capabilities';
import { adviceFor, jobChallenge, progressFor, runUniversalTask, shelfFor } from '../src/universal/loop';
import type { AgentDeps, AgentStepLog } from '../src/agent/loop';

const step = (skill: string, ok = true): AgentStepLog => ({ skill, args: {}, ok, summary: skill });

const mk = (id: string, description: string, ran: string[]): Skill => ({
  id, label: id, icon: '•', domain: id.split('.')[0]!, description, risk: 'safe', params: {},
  summarize: () => id,
  async run() { ran.push(id); return { ok: true, message: `${id} finished` }; },
});

function rig(replies: string[]) {
  const ran: string[] = [];
  const registry = new SkillRegistry({ capabilities: () => [] });
  registry.registerMany([
    mk('research.search', 'Search the web for current information.', ran),
    mk('research.open', 'Open a web page and read its text.', ran),
    mk('files.find', 'Find files by name on this PC.', ran),
    mk('code.edit', 'Edit a code file.', ran),
    mk('test.run', 'Run the project tests.', ran),
  ]);
  const prompts: string[] = [];
  const p = {
    id: 't', label: 'T', isConfigured: () => true, isLocal: () => true,
    ask(prompt: string, h: { onDone: (s: string) => void }) { prompts.push(prompt); h.onDone(replies[Math.min(prompts.length - 1, replies.length - 1)]!); },
  } as unknown as IntelligenceProvider;
  const reg = { register: () => {}, get: () => p, list: () => [p], active: () => p, setActive: () => {} } as unknown as IntelligenceRegistry;
  const deps: AgentDeps = { skills: registry, intelligence: reg, executor: new Executor(registry), getExecutionMode: () => 'doIt' };
  const ctx = { say: () => {}, confirm: async () => true } as unknown as SkillContext;
  return { deps, ran, prompts, run: (g: string) => runUniversalTask(g, deps, ctx) };
}

describe('shelf', () => {
  const deps = rig(['{"done":true,"summary":"x"}']).deps;
  test('a research goal pins the web tools; a plain file goal pins nothing', () => {
    expect(shelfFor('research the latest laptops', deps)).toEqual(['research.search', 'research.open']);
    expect(shelfFor('find my tax files', deps)).toEqual([]);
  });
  test('a coding goal pins only the code tools that exist', () => {
    expect(shelfFor('fix the bug in the parser', deps)).toEqual(['code.edit', 'test.run']);
  });
});

describe('advice and challenges', () => {
  test('after a search it says to open pages; after a code change, to check it', () => {
    expect(adviceFor('research.search', true)).toMatch(/research\.open/);
    expect(adviceFor('code.edit', true)).toMatch(/test\.run/);
    expect(adviceFor('files.find', true)).toBeUndefined();
  });
  test('a web question is not done until a search ran, and a research one until a page was opened', () => {
    expect(jobChallenge('what is the latest Node release', [])).toMatch(/no search ran/);
    expect(jobChallenge('what is the latest Node release', [step('research.search')])).toBeNull();
    expect(jobChallenge('research the best laptops', [step('research.search')])).toMatch(/opened no page/);
    expect(jobChallenge('research the best laptops', [step('research.search'), step('research.open')])).toBeNull();
    expect(jobChallenge('research the best laptops', [step('research.search', false)])).toMatch(/no search ran/);
  });
  test('changed code with no check afterwards is challenged', () => {
    expect(jobChallenge('fix the bug', [step('code.edit')])).toMatch(/no build, test or check/);
    expect(jobChallenge('fix the bug', [step('code.edit'), step('test.run')])).toBeNull();
  });
});

describe('progress tally', () => {
  const { deps } = rig(['{"done":true,"summary":"x"}']);
  const index = new CapabilityIndex(deps.skills);
  test('a one-part request has none', () => {
    expect(progressFor('find my files', [], index, deps)).toEqual({});
  });
  test('a two-part request lists both open, then marks the covered one done', () => {
    const goal = 'find my files and then research the latest laptops';
    const before = Object.values(progressFor(goal, [], index, deps))[0]!;
    expect(before).toContain('[open] find my files');
    const after = Object.values(progressFor(goal, [step('files.find')], index, deps))[0]!;
    expect(after).toContain('[done] find my files');
    expect(after).toContain('[open] research the latest laptops');
  });
});

describe('through the loop', () => {
  test('a web question answered "done" with no search is sent back, then searches and reports', async () => {
    const r = rig([
      '{"done":true,"summary":"It is 22."}',
      '{"skill":"research.search","args":{}}',
      '{"done":true,"summary":"Found."}',
    ]);
    const report = await r.run('what is the latest news about Rust');
    expect(r.ran).toEqual(['research.search']);
    expect(r.prompts[0]).toContain('research.search');
    expect(r.prompts[1]).toContain('Atlas checked your "done"');
    expect(report.steps.some((s) => s.skill === 'research.search' && s.ok)).toBe(true);
  });
});
