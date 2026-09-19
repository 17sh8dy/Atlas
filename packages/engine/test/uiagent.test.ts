/**
 * `runUiTask` — the UI-driving agent's bounded, observe-and-replan loop.
 *
 * Mirrors `devagent.test.ts`'s own shape closely on purpose: this loop shares
 * its mechanism (`agent/loop.ts`) with the developer agent almost entirely,
 * so most of what has to hold — the executor is real, a step outside the
 * allowed set never runs, a repeated failure stops, a decline stops, the
 * budget is a hard ceiling — is exactly the same guarantee, just proven
 * against this task's own config. The one test worth adding beyond that
 * parity is `observationText`'s whole reason to exist: a skill that reports
 * through `.data` rather than `.message` (the `uia.tree`/`window.list`
 * convention) still has to reach the next prompt, or the "observe" half of
 * observe-act-observe-replan is a no-op for exactly the skills this loop was
 * built to drive.
 */

import { test, assert } from 'vitest';
import type { IntelligenceProvider, IntelligenceRegistry, Skill, SkillContext } from '@atlas/core';
import { SkillRegistry } from '../src/skills/registry';
import { Executor } from '../src/planner/executor';
import { runUiTask, MAX_UI_ITERATIONS, type UiAgentDeps } from '../src/uiagent/loop';

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

/** `next(callNumber, prompt)` returns the raw string reply for that call, 1-indexed. */
function fakeProvider(
  next: (call: number, prompt: string) => string,
): IntelligenceProvider & { calls: number; prompts: string[] } {
  const provider = {
    id: 'test',
    label: 'Test',
    calls: 0,
    prompts: [] as string[],
    isConfigured: () => true,
    isLocal: () => true,
    ask(prompt: string, handlers: { onDone: (full: string) => void }) {
      provider.calls += 1;
      provider.prompts.push(prompt);
      handlers.onDone(next(provider.calls, prompt));
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

function deps(skills: SkillRegistry, intelligence: IntelligenceRegistry): UiAgentDeps {
  return { skills, intelligence, executor: new Executor(skills), getExecutionMode: () => 'doIt' };
}

function windowListSkill(
  run: () => Promise<{ ok: boolean; message?: string; error?: string; data?: unknown }>,
): Skill {
  return {
    id: 'window.list',
    label: 'List windows',
    domain: 'system',
    description: 'list',
    risk: 'safe',
    params: {},
    run,
  };
}

test('a task that is already done on the first turn runs no steps', async () => {
  const skills = new SkillRegistry({ capabilities: () => ['ui-automation', 'window-control'] });
  const provider = fakeProvider(() => JSON.stringify({ done: true, summary: 'Nothing to do.' }));
  const ctx = fakeContext();

  const report = await runUiTask('goal', deps(skills, registryWith(provider)), ctx);

  assert.isTrue(report.ok);
  assert.equal(report.stoppedBecause, 'done');
  assert.deepEqual(report.steps, []);
  assert.equal(provider.calls, 1);
  assert.deepEqual(ctx.said, ['Nothing to do.']);
});

test('a proposed step actually runs through the real executor, then done', async () => {
  const skills = new SkillRegistry({ capabilities: () => ['ui-automation', 'window-control'] });
  let ran = 0;
  skills.register(
    windowListSkill(async () => {
      ran += 1;
      return { ok: true, message: '', data: [{ id: '1', title: 'Discord' }] };
    }),
  );

  const provider = fakeProvider((call) =>
    call === 1
      ? JSON.stringify({ skill: 'window.list', args: {} })
      : JSON.stringify({ done: true, summary: 'Found it.' }),
  );

  const report = await runUiTask('goal', deps(skills, registryWith(provider)), fakeContext());

  assert.equal(ran, 1, 'the skill must actually have been invoked, not just parsed');
  assert.equal(report.steps.length, 1);
  assert.isTrue(report.steps[0].ok);
  assert.equal(report.stoppedBecause, 'done');
});

test('no active provider stops immediately without ever asking anything', async () => {
  const skills = new SkillRegistry({ capabilities: () => ['ui-automation', 'window-control'] });
  const ctx = fakeContext();

  const report = await runUiTask('goal', deps(skills, registryWith(null)), ctx);

  assert.isFalse(report.ok);
  assert.equal(report.stoppedBecause, 'no-provider');
  assert.match(ctx.said[0], /cortex/i);
});

test('the exact same failed call is never retried — the loop stops and says why', async () => {
  const skills = new SkillRegistry({ capabilities: () => ['ui-automation', 'window-control'] });
  let ran = 0;
  skills.register(
    windowListSkill(async () => {
      ran += 1;
      return { ok: false, error: 'boom' };
    }),
  );

  const provider = fakeProvider(() => JSON.stringify({ skill: 'window.list', args: {} }));

  const report = await runUiTask('goal', deps(skills, registryWith(provider)), fakeContext());

  assert.equal(report.stoppedBecause, 'repeated-failure');
  assert.equal(ran, 1, 'a call that already failed must not run again');
  assert.equal(report.steps.length, 1);
});

test('a skill outside UI_AGENT_SKILLS is never invoked, even if proposed — including one sharing its domain', async () => {
  // `os.power` and `window.list` both carry `domain: 'system'` on the real
  // registry (see `uiagent/loop.ts`'s module doc) — this is exactly the case
  // a domain-set check would have let through and the explicit id set does
  // not.
  const skills = new SkillRegistry({ capabilities: () => ['ui-automation', 'window-control', 'os'] });
  let powerRan = false;
  skills.register({
    id: 'os.power',
    label: 'Power',
    domain: 'system',
    description: 'shut down or restart',
    risk: 'confirm',
    params: { action: { type: 'string', required: true, description: 'a' } },
    run: async () => {
      powerRan = true;
      return { ok: true };
    },
  });

  const provider = fakeProvider((call) =>
    call === 1
      ? JSON.stringify({ skill: 'os.power', args: { action: 'shutdown' } })
      : JSON.stringify({ done: true, summary: 'Stopped.' }),
  );

  await runUiTask('goal', deps(skills, registryWith(provider)), fakeContext());

  assert.isFalse(
    powerRan,
    'a skill outside the UI-driving allowlist must never run from this loop, domain match or not',
  );
});

test('two malformed replies in a row stop the task rather than looping forever', async () => {
  const skills = new SkillRegistry({ capabilities: () => ['ui-automation', 'window-control'] });
  const provider = fakeProvider(() => 'not json at all');

  const report = await runUiTask('goal', deps(skills, registryWith(provider)), fakeContext());

  assert.equal(report.stoppedBecause, 'malformed');
  assert.equal(provider.calls, 2);
});

test('declining a confirm-tier step ends the task, matching Executor.run elsewhere', async () => {
  const skills = new SkillRegistry({ capabilities: () => ['ui-automation', 'window-control'] });
  let ran = false;
  skills.register({
    id: 'window.close',
    label: 'Close',
    domain: 'system',
    description: 'close',
    risk: 'confirm',
    params: { name: { type: 'string', required: true, description: 'n' } },
    run: async () => {
      ran = true;
      return { ok: true };
    },
  });

  const provider = fakeProvider(() =>
    JSON.stringify({ skill: 'window.close', args: { name: 'discord' } }),
  );

  const report = await runUiTask('goal', deps(skills, registryWith(provider)), fakeContext(false));

  assert.equal(report.stoppedBecause, 'declined');
  assert.isFalse(ran, 'a declined step must never run');
});

test('the loop never exceeds its iteration budget', async () => {
  const skills = new SkillRegistry({ capabilities: () => ['ui-automation', 'window-control'] });
  skills.register(windowListSkill(async () => ({ ok: true, message: 'ok' })));

  const provider = fakeProvider(() => JSON.stringify({ skill: 'window.list', args: {} }));

  const report = await runUiTask('goal', deps(skills, registryWith(provider)), fakeContext());

  assert.equal(report.stoppedBecause, 'budget');
  assert.equal(report.steps.length, MAX_UI_ITERATIONS);
  assert.equal(provider.calls, MAX_UI_ITERATIONS);
});

// ---- the actual point of this loop: observing a read skill's .data --------
//
// `window.list`/`uia.tree` keep `message` empty by the chat-card convention
// (see `agent/loop.ts`'s module doc) — the real payload is in `data`. A
// replanning model that never saw that payload could not have decided a
// sensible next click from it; this proves it reaches the next prompt.

test('a read skill reporting through .data (not .message) still reaches the next prompt', async () => {
  const skills = new SkillRegistry({ capabilities: () => ['ui-automation', 'window-control'] });
  skills.register(
    windowListSkill(async () => ({
      ok: true,
      message: '', // deliberately empty — the chat-card convention this test exists for
      data: [{ id: '42', title: 'Discord — #general' }],
    })),
  );

  const report = await runUiTask(
    'find the window with Discord in its title',
    deps(
      skills,
      registryWith(
        fakeProvider((call, prompt) => {
          if (call === 1) return JSON.stringify({ skill: 'window.list', args: {} });
          // The second prompt's history is the only place the id "42" or the
          // title "Discord — #general" could have come from — window.list's
          // own `message` was empty, so this only passes if `data` reached it.
          assert.include(prompt, '42');
          assert.include(prompt, 'Discord');
          return JSON.stringify({ done: true, summary: 'Found window 42.' });
        }),
      ),
    ),
    fakeContext(),
  );

  assert.equal(report.stoppedBecause, 'done');
  assert.equal(report.steps.length, 1);
});
