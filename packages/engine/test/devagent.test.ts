/**
 * `runDevTask` — the developer agent's bounded, observe-and-replan loop.
 *
 * Every action still runs through the real `Executor`, so these tests use a
 * real `SkillRegistry` and `Executor` with a handful of fake skills, rather
 * than mocking the executor away — the whole point of the loop is that it
 * adds no second door to action, and a test that mocked the executor would
 * not catch a regression in that guarantee.
 */

import { test, assert } from 'vitest';
import type { IntelligenceProvider, IntelligenceRegistry, Skill, SkillContext } from '@atlas/core';
import { SkillRegistry } from '../src/skills/registry';
import { Executor } from '../src/planner/executor';
import { runDevTask, MAX_DEV_ITERATIONS, type DevAgentDeps } from '../src/devagent/loop';

function fakeContext(confirmAnswer = true): SkillContext & { said: string[] } {
  const said: string[] = [];
  return {
    say: (t: string) => {
      said.push(t);
    },
    confirm: async () => confirmAnswer,
    said,
  };
}

/** `next(callNumber)` returns the raw string reply for that call, 1-indexed. */
function fakeProvider(next: (call: number) => string): IntelligenceProvider & { calls: number } {
  const provider = {
    id: 'test',
    label: 'Test',
    calls: 0,
    isConfigured: () => true,
    isLocal: () => true,
    ask(_prompt: string, handlers: { onDone: (full: string) => void }) {
      provider.calls += 1;
      handlers.onDone(next(provider.calls));
    },
  };
  return provider;
}

function registryWith(provider: IntelligenceProvider | null): IntelligenceRegistry {
  return {
    register: () => {},
    get: () => provider,
    list: () => (provider ? [provider] : []),
    active: () => provider,
    setActive: () => {},
  };
}

function deps(skills: SkillRegistry, intelligence: IntelligenceRegistry): DevAgentDeps {
  return { skills, intelligence, executor: new Executor(skills), getExecutionMode: () => 'doIt' };
}

function detectSkill(run: () => Promise<{ ok: boolean; message?: string; error?: string }>): Skill {
  return {
    id: 'project.detect',
    label: 'Detect',
    domain: 'project',
    description: 'detect',
    risk: 'safe',
    params: { path: { type: 'string', required: true, description: 'path' } },
    run,
  };
}

test('a task that is already done on the first turn runs no steps', async () => {
  const skills = new SkillRegistry({ capabilities: () => ['devtools'] });
  const provider = fakeProvider(() => JSON.stringify({ done: true, summary: 'Nothing to do.' }));
  const ctx = fakeContext();

  const report = await runDevTask('goal', 'C:\\proj', deps(skills, registryWith(provider)), ctx);

  assert.isTrue(report.ok);
  assert.equal(report.stoppedBecause, 'done');
  assert.deepEqual(report.steps, []);
  assert.equal(provider.calls, 1);
  assert.deepEqual(ctx.said, ['Nothing to do.']);
});

test('a proposed step actually runs through the real executor, then done', async () => {
  const skills = new SkillRegistry({ capabilities: () => ['devtools'] });
  let ran = 0;
  skills.register(
    detectSkill(async () => {
      ran += 1;
      return { ok: true, message: 'detected 3 systems' };
    }),
  );

  const provider = fakeProvider((call) =>
    call === 1
      ? JSON.stringify({ skill: 'project.detect', args: { path: 'C:\\proj' } })
      : JSON.stringify({ done: true, summary: 'Found it.' }),
  );

  const report = await runDevTask(
    'goal',
    'C:\\proj',
    deps(skills, registryWith(provider)),
    fakeContext(),
  );

  assert.equal(ran, 1, 'the skill must actually have been invoked, not just parsed');
  assert.equal(report.steps.length, 1);
  assert.isTrue(report.steps[0].ok);
  assert.equal(report.stoppedBecause, 'done');
});

test('no active provider stops immediately without ever asking anything', async () => {
  const skills = new SkillRegistry({ capabilities: () => ['devtools'] });
  const ctx = fakeContext();

  const report = await runDevTask('goal', 'C:\\proj', deps(skills, registryWith(null)), ctx);

  assert.isFalse(report.ok);
  assert.equal(report.stoppedBecause, 'no-provider');
  assert.match(ctx.said[0], /cortex/i);
});

test('the exact same failed call is never retried — the loop stops and says why', async () => {
  const skills = new SkillRegistry({ capabilities: () => ['devtools'] });
  let ran = 0;
  skills.register(
    detectSkill(async () => {
      ran += 1;
      return { ok: false, error: 'boom' };
    }),
  );

  // Proposes the identical skill + args every single turn.
  const provider = fakeProvider(() =>
    JSON.stringify({ skill: 'project.detect', args: { path: 'C:\\proj' } }),
  );

  const report = await runDevTask(
    'goal',
    'C:\\proj',
    deps(skills, registryWith(provider)),
    fakeContext(),
  );

  assert.equal(report.stoppedBecause, 'repeated-failure');
  assert.equal(ran, 1, 'a call that already failed must not run again');
  assert.equal(report.steps.length, 1);
});

test('a different call after a failure is allowed — only the identical one is refused', async () => {
  const skills = new SkillRegistry({ capabilities: () => ['devtools'] });
  const seen: string[] = [];
  skills.register(
    detectSkill(async (args) => {
      seen.push(String(args.path));
      return args.path === 'C:\\bad' ? { ok: false, error: 'boom' } : { ok: true, message: 'ok' };
    }),
  );

  const provider = fakeProvider((call) => {
    if (call === 1) return JSON.stringify({ skill: 'project.detect', args: { path: 'C:\\bad' } });
    if (call === 2) return JSON.stringify({ skill: 'project.detect', args: { path: 'C:\\good' } });
    return JSON.stringify({ done: true, summary: 'Recovered.' });
  });

  const report = await runDevTask(
    'goal',
    'C:\\proj',
    deps(skills, registryWith(provider)),
    fakeContext(),
  );

  assert.deepEqual(seen, ['C:\\bad', 'C:\\good']);
  assert.equal(report.stoppedBecause, 'done');
  assert.equal(report.steps.length, 2);
});

test('a skill outside the dev-agent domains is never invoked, even if proposed', async () => {
  const skills = new SkillRegistry({ capabilities: () => ['devtools', 'os'] });
  let osRan = false;
  skills.register({
    id: 'os.lockWorkstation',
    label: 'Lock',
    domain: 'os',
    description: 'lock',
    risk: 'safe',
    params: {},
    run: async () => {
      osRan = true;
      return { ok: true };
    },
  });

  const provider = fakeProvider((call) =>
    call === 1
      ? JSON.stringify({ skill: 'os.lockWorkstation', args: {} })
      : JSON.stringify({ done: true, summary: 'Stopped.' }),
  );

  await runDevTask('goal', 'C:\\proj', deps(skills, registryWith(provider)), fakeContext());

  assert.isFalse(
    osRan,
    'a skill outside project/git/build/test/code/files must never run from this loop',
  );
});

test('two malformed replies in a row stop the task rather than looping forever', async () => {
  const skills = new SkillRegistry({ capabilities: () => ['devtools'] });
  const provider = fakeProvider(() => 'not json at all');

  const report = await runDevTask(
    'goal',
    'C:\\proj',
    deps(skills, registryWith(provider)),
    fakeContext(),
  );

  assert.equal(report.stoppedBecause, 'malformed');
  assert.equal(provider.calls, 2);
});

test('declining a confirm-tier step ends the task, matching Executor.run elsewhere', async () => {
  const skills = new SkillRegistry({ capabilities: () => ['devtools'] });
  let ran = false;
  skills.register({
    id: 'code.write',
    label: 'Write',
    domain: 'code',
    description: 'write',
    risk: 'confirm',
    params: { path: { type: 'string', required: true, description: 'p' } },
    run: async () => {
      ran = true;
      return { ok: true };
    },
  });

  const provider = fakeProvider(() =>
    JSON.stringify({ skill: 'code.write', args: { path: 'C:\\proj\\a.txt' } }),
  );

  const report = await runDevTask(
    'goal',
    'C:\\proj',
    deps(skills, registryWith(provider)),
    fakeContext(false),
  );

  assert.equal(report.stoppedBecause, 'declined');
  assert.isFalse(ran, 'a declined step must never run');
});

test('the loop never exceeds its iteration budget', async () => {
  const skills = new SkillRegistry({ capabilities: () => ['devtools'] });
  skills.register(detectSkill(async () => ({ ok: true, message: 'ok' })));

  // Never says done, always a fresh path so nothing trips the repeat guard.
  const provider = fakeProvider((call) =>
    JSON.stringify({ skill: 'project.detect', args: { path: `C:\\proj\\${call}` } }),
  );

  const report = await runDevTask(
    'goal',
    'C:\\proj',
    deps(skills, registryWith(provider)),
    fakeContext(),
  );

  assert.equal(report.stoppedBecause, 'budget');
  assert.equal(report.steps.length, MAX_DEV_ITERATIONS);
  assert.equal(provider.calls, MAX_DEV_ITERATIONS);
});
