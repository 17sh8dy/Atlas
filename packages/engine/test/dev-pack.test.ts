/**
 * Git without a folder, the current project, and opening a terminal or editor:
 * how it is understood, and what each one asks of the machine.
 */

import { assert, test } from 'vitest';
import type { Fact, Memory, Platform, Skill } from '@atlas/core';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { WorkingMemory } from '../src/working-memory';
import { createDevToolsSkills } from '../src/skills/devtools-skills';
import { ProjectContext, createProjectSkills, withCurrentProject } from '../src/skills/project-context';

function grammar(): Grammar {
  const g = new Grammar();
  g.addMany(createCoreGrammar(new WorkingMemory()));
  g.addMany(createExtraGrammar());
  return g;
}
const plan = (text: string) =>
  grammar()
    .parse(text)
    ?.steps.map((s) => [s.skill, s.args]);

// ---- understanding ---------------------------------------------------------------------

test('git, with no folder named', () => {
  assert.deepEqual(plan('git status'), [['git.status', {}]]);
  assert.deepEqual(plan('git status in D:\\Dev\\Atlas'), [['git.status', { path: 'D:\\Dev\\Atlas' }]]);
  assert.deepEqual(plan('which branch am i on'), [['git.branch', {}]]);
  assert.deepEqual(plan('show git log'), [['git.log', { limit: 10 }]]);
  assert.deepEqual(plan('git diff'), [['git.diff', {}]]);
});

test('commit: everything stages first; "commit with message" takes only what is staged', () => {
  assert.deepEqual(plan('commit everything with message fix typo'), [
    ['git.add', { file: '.' }],
    ['git.commit', { message: 'fix typo' }],
  ]);
  assert.deepEqual(plan('commit with message wip'), [['git.commit', { message: 'wip' }]]);
  assert.deepEqual(plan('git commit -m "add tests"'), [['git.commit', { message: 'add tests' }]]);
});

test('branches, pull, push, stash', () => {
  assert.deepEqual(plan('switch to branch dev'), [['git.checkout', { branch: 'dev' }]]);
  assert.deepEqual(plan('create a branch called feature-y'), [['git.checkout', { branch: 'feature-y', create: true }]]);
  assert.deepEqual(plan('pull the latest'), [['git.pull', {}]]);
  assert.deepEqual(plan('stash my changes'), [['git.stash', { action: 'push' }]]);
  assert.deepEqual(plan('git stash pop'), [['git.stash', { action: 'pop' }]]);
});

test('"push to github" is a git push now — not a click on "to github" — and a button is still a button', () => {
  assert.deepEqual(plan('push to github'), [['git.push', {}]]);
  assert.deepEqual(plan('push my changes'), [['git.push', {}]]);
  assert.equal(grammar().parse('push the save button')?.steps[0]?.skill, 'uia.invoke');
});

test('a branch name that is really a flag is not taken as one', () => {
  assert.notEqual(grammar().parse('switch to branch -D')?.steps[0]?.skill, 'git.checkout');
  assert.notEqual(grammar().parse('checkout --force')?.steps[0]?.skill, 'git.checkout');
});

test('projects and where to open them', () => {
  assert.deepEqual(plan('use D:\\Dev\\Atlas as my project'), [['project.use', { target: 'D:\\Dev\\Atlas' }]]);
  assert.deepEqual(plan('which project am i working on'), [['project.current', {}]]);
  assert.deepEqual(plan('open the terminal in this folder'), [['project.terminal', {}]]);
  assert.deepEqual(plan('open this project in vscode'), [['project.editor', {}]]);
  assert.deepEqual(plan('open D:\\Dev\\Atlas in vscode'), [['project.editor', { path: 'D:\\Dev\\Atlas' }]]);
});

// ---- the current project -----------------------------------------------------------------

function memoryOf(): Memory & { facts_: Map<string, string> } {
  const store = new Map<string, string>();
  const key = (k: string, s: string) => `${k}:${s}`;
  return {
    facts_: store,
    remember: async (k: string, s: string, v: string) => void store.set(key(k, s), v),
    fact: async (k: string, s: string) => {
      const v = store.get(key(k, s));
      return v === undefined ? undefined : ({ kind: k, subject: s, value: v, at: 0 } as Fact);
    },
  } as unknown as Memory & { facts_: Map<string, string> };
}

function setup(over: Partial<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  const memory = memoryOf();
  const platform = {
    gitStatus: async (p: string) => {
      calls.push(`status ${p}`);
      if (over.statusFails) throw new Error('That isn\'t a git repository.');
      return { branch: 'main', staged: [], unstaged: [], untracked: [], clean: true };
    },
    gitBranches: async (p: string) => {
      calls.push(`branches ${p}`);
      return { current: 'main', branches: ['dev', 'main'] };
    },
    gitCheckout: async (p: string, b: string, c: boolean) => {
      calls.push(`checkout ${p} ${b} ${c}`);
      return '';
    },
    gitPull: async (p: string) => {
      calls.push(`pull ${p}`);
      return 'Already up to date.';
    },
    gitPush: async (p: string) => {
      calls.push(`push ${p}`);
      return '';
    },
    gitStash: async (p: string, a: string) => {
      calls.push(`stash ${p} ${a}`);
      return '';
    },
    detectProject: async () => ({ systems: ['pnpm'], isGitRepo: true }),
    openProjectTerminal: async (p: string) => {
      calls.push(`terminal ${p}`);
      return true;
    },
    openProjectEditor: async (p: string) => {
      calls.push(`editor ${p}`);
      return true;
    },
    knownFolder: async () => 'C:\\U\\Documents',
    listDir: async () => [],
  } as unknown as Platform;
  const ctx = new ProjectContext(memory);
  const skills = [...withCurrentProject(createDevToolsSkills(platform), ctx, platform, memory), ...createProjectSkills(platform, ctx, memory)];
  const by = Object.fromEntries(skills.map((s) => [s.id, s])) as Record<string, Skill>;
  const run = (id: string, args: Record<string, unknown> = {}) =>
    by[id]!.run(args, {} as never) as Promise<{ ok: boolean; message?: string; error?: string }>;
  return { calls, run, by, ctx, memory };
}

test('with no project, it asks which — and runs nothing', async () => {
  const { run, calls } = setup();
  const r = await run('git.status');
  assert.equal(r.ok, false);
  assert.match(String(r.error), /Which project\?/);
  assert.equal(calls.length, 0);
});

test('"use X as my project" sets it, and later requests need no folder', async () => {
  const { run, calls, ctx } = setup();
  const set = await run('project.use', { target: 'D:\\Dev\\Atlas' });
  assert.match(String(set.message), /Working in Atlas \(pnpm, git\)/);
  assert.equal(await ctx.get(), 'D:\\Dev\\Atlas');
  await run('git.status');
  await run('git.branch');
  assert.deepEqual(calls, ['status D:\\Dev\\Atlas', 'branches D:\\Dev\\Atlas']);
});

test('a folder that is given always wins, and then becomes the current project', async () => {
  const { run, calls, ctx } = setup();
  await run('project.use', { target: 'D:\\Dev\\Atlas' });
  await run('git.status', { path: 'D:\\Dev\\Other' });
  assert.deepEqual(calls, ['status D:\\Dev\\Other']);
  assert.equal(await ctx.get(), 'D:\\Dev\\Other');
});

test('a failed run does not move the current project', async () => {
  const { run, ctx } = setup({ statusFails: true });
  await run('project.use', { target: 'D:\\Dev\\Atlas' });
  const r = await run('git.status', { path: 'D:\\NotARepo' });
  assert.equal(r.ok, false);
  assert.equal(await ctx.get(), 'D:\\Dev\\Atlas');
});

test('a remembered name stands in for a folder', async () => {
  const { run, calls, memory } = setup();
  await memory.remember('alias', 'atlas', 'D:\\Dev\\Atlas');
  await run('git.status', { path: 'atlas' });
  assert.deepEqual(calls, ['status D:\\Dev\\Atlas']);
});

test('what changes the repository or publishes it asks; reading does not', () => {
  const { by } = setup();
  for (const id of ['git.checkout', 'git.pull', 'git.push']) assert.equal(by[id]!.risk, 'confirm', id);
  assert.equal(by['git.stash']!.risk, 'confirm');
  assert.equal(by['git.stash']!.riskFor?.({ action: 'list' }), 'safe');
  assert.equal(by['git.stash']!.riskFor?.({ action: 'push' }), undefined);
  for (const id of ['git.branch', 'git.status', 'project.current', 'project.terminal', 'project.editor']) {
    assert.equal(by[id]!.risk, 'safe', id);
  }
});

test('the path is optional now, so nothing asks "which folder?" ahead of the skill saying so itself', () => {
  const { by } = setup();
  for (const id of ['git.status', 'git.push', 'test.run', 'build.run']) {
    assert.equal(by[id]!.params?.path?.required, false, id);
  }
});

test('the git actions reach the machine with the right arguments', async () => {
  const { run, calls } = setup();
  await run('project.use', { target: 'D:\\Dev\\Atlas' });
  await run('git.checkout', { branch: 'dev', create: true });
  await run('git.pull');
  await run('git.push');
  await run('git.stash', { action: 'push' });
  assert.deepEqual(calls.slice(0), [
    'checkout D:\\Dev\\Atlas dev true',
    'pull D:\\Dev\\Atlas',
    'push D:\\Dev\\Atlas',
    'stash D:\\Dev\\Atlas push',
  ]);
});

test('terminal and editor open on the current project', async () => {
  const { run, calls } = setup();
  assert.equal((await run('project.terminal')).ok, false, 'no project yet');
  await run('project.use', { target: 'D:\\Dev\\Atlas' });
  assert.match(String((await run('project.terminal')).message), /Opened a terminal in Atlas/);
  await run('project.editor');
  assert.deepEqual(calls, ['terminal D:\\Dev\\Atlas', 'editor D:\\Dev\\Atlas']);
});
