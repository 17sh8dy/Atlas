/**
 * Routines: "every night at 2am, do this" — approved once, safe things only, and
 * stopped by anything unexpected.
 */

import { assert, test } from 'vitest';
import type { Plan, PlanOutcome, PlanStep, Skill, Storage } from '@atlas/core';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { WorkingMemory } from '../src/working-memory';
import { RoutineScheduler } from '../src/routines/scheduler';
import { createRoutineSkills } from '../src/skills/routine-skills';
import { SkillRegistry } from '../src/skills/registry';

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

// ---- understanding -----------------------------------------------------------------------

test('a repeating time and what to do, in either order', () => {
  assert.deepEqual(plan('every day at 8 open spotify'), [['routine.create', { when: 'every day at 8', then: 'open spotify' }]]);
  assert.deepEqual(plan('open spotify every weekday at 9am'), [['routine.create', { when: 'every weekday at 9am', then: 'open spotify' }]]);
  assert.deepEqual(plan('run backup every night at 2am'), [['routine.create', { when: 'every night at 2am', then: 'run backup' }]]);
});

test('reminders and alarms keep their own sentences', () => {
  assert.equal(grammar().parse('remind me to stretch every day at 3pm')?.steps[0]?.skill, 'reminder.set');
  assert.equal(grammar().parse('set an alarm every day at 7')?.steps[0]?.skill !== 'routine.create', true);
});

test('list, cancel, resume', () => {
  assert.deepEqual(plan('what are my scheduled routines'), [['routine.list', {}]]);
  assert.deepEqual(plan('cancel my spotify scheduled routine'), [['routine.cancel', { which: 'spotify' }]]);
  assert.deepEqual(plan('cancel all scheduled routines'), [['routine.cancel', { which: 'all' }]]);
  assert.deepEqual(plan('resume my scheduled routines'), [['routine.resume', {}]]);
  // "my routines" on its own is still the saved setups
  assert.equal(grammar().parse('what are my routines')?.steps[0]?.skill, 'setup.list');
});

// ---- the scheduler -------------------------------------------------------------------------

function storage(): Storage {
  const data = new Map<string, unknown>();
  return {
    async get<T>(k: string) {
      return data.get(k) as T | undefined;
    },
    async set(k: string, v: unknown) {
      data.set(k, JSON.parse(JSON.stringify(v)));
    },
    async remove(k: string) {
      data.delete(k);
    },
  };
}

const NOW = new Date(2026, 9, 7, 15, 0, 0).getTime();
const DAY = 86_400_000;
const STEP: PlanStep = { skill: 'app.open', args: { name: 'spotify' } };

function rig(opts: { ask?: boolean; fail?: boolean; halted?: boolean } = {}) {
  let clock = NOW;
  const ran: string[] = [];
  const said: string[] = [];
  const s = new RoutineScheduler({
    storage: storage(),
    now: () => clock,
    announce: (t) => said.push(t),
    run: async (p: Plan, io): Promise<PlanOutcome> => {
      ran.push(p.steps[0]!.skill);
      if (opts.ask) await io.confirm('Open it?');
      if (opts.halted) return { ok: false, ran: 0, aborted: true, halted: true, outcomes: [] } as never;
      return { ok: !opts.fail, ran: 1, aborted: false, outcomes: [{ skill: p.steps[0]!.skill, ok: !opts.fail, error: opts.fail ? 'no such app' : undefined }] } as never;
    },
  });
  return { s, ran, said, advance: (ms: number) => (clock += ms), set: (t: number) => (clock = t) };
}

test('a routine runs at its time, once, and is rescheduled', async () => {
  const r = rig();
  await r.s.add({ request: 'open spotify', steps: [STEP], labels: ['Open an app — spotify'], at: NOW + 1000, repeat: 'daily' });
  await r.s.tick();
  assert.deepEqual(r.ran, []);
  r.advance(2000);
  await r.s.tick();
  await r.s.tick();
  assert.deepEqual(r.ran, ['app.open'], 'once');
  const [item] = await r.s.list();
  assert.ok(item!.at > NOW + DAY - 5000 && item!.at <= NOW + DAY + 5000, 'tomorrow');
  assert.match(r.said.join('\n'), /ran: Open an app — spotify/);
});

test('a run that is far too late is skipped and reported, not caught up', async () => {
  const r = rig();
  await r.s.add({ request: 'open spotify', steps: [STEP], labels: ['Open'], at: NOW + 1000, repeat: 'daily' });
  r.advance(3 * DAY); // the PC was off for three days
  await r.s.tick();
  assert.deepEqual(r.ran, [], 'nothing ran');
  assert.match(r.said.join('\n'), /Missed the routine/);
  const [item] = await r.s.list();
  assert.ok(item!.at > NOW + 3 * DAY, 'the next slot, not the missed ones');
});

test('a step that wants to ask is denied, and the routine stops and says so', async () => {
  const r = rig({ ask: true });
  await r.s.add({ request: 'x', steps: [STEP, { skill: 'app.open', args: { name: 'b' } }], labels: ['One', 'Two'], at: NOW + 1000, repeat: 'daily' });
  r.advance(2000);
  await r.s.tick();
  assert.deepEqual(r.ran, ['app.open'], 'it did not go on to step two');
  assert.match(r.said.join('\n'), /stopped — "One" wanted to ask: Open it\?/);
});

test('a failing step stops it and says why', async () => {
  const r = rig({ fail: true });
  await r.s.add({ request: 'x', steps: [STEP], labels: ['One'], at: NOW + 1000, repeat: 'daily' });
  r.advance(2000);
  await r.s.tick();
  assert.match(r.said.join('\n'), /"One" failed \(no such app\)/);
});

test('the emergency stop pauses every routine, and resuming skips what was missed', async () => {
  const r = rig();
  await r.s.add({ request: 'x', steps: [STEP], labels: ['One'], at: NOW + 1000, repeat: 'daily' });
  await r.s.pauseAll();
  r.advance(2000);
  await r.s.tick();
  assert.deepEqual(r.ran, [], 'paused means paused');
  r.advance(2 * DAY);
  assert.equal(await r.s.setEnabled(true), 1);
  const [item] = await r.s.list();
  assert.ok(item!.at > NOW + 2 * DAY, 'picks the next slot');
  await r.s.tick();
  assert.deepEqual(r.ran, []);
});

test('a record edited on disk no longer matches its approval and does not run', async () => {
  const st = storage();
  let clock = NOW;
  const ran: string[] = [];
  const said: string[] = [];
  const host = { storage: st, now: () => clock, announce: (t: string) => said.push(t), run: async (p: Plan) => { ran.push(p.steps[0]!.skill); return { ok: true, ran: 1, aborted: false, outcomes: [{ skill: 'x', ok: true }] } as never; } };
  const a = new RoutineScheduler(host);
  await a.add({ request: 'x', steps: [STEP], labels: ['One'], at: NOW + 1000, repeat: 'daily' });
  const saved = (await st.get<Array<{ steps: PlanStep[] }>>('routines.items'))!;
  saved[0]!.steps = [{ skill: 'files.delete', args: { path: 'C:\\x' } }];
  await st.set('routines.items', saved);
  const b = new RoutineScheduler(host);
  await b.start();
  b.dispose();
  clock += 2000;
  await b.tick();
  assert.deepEqual(ran, []);
  assert.match(said.join('\n'), /no longer match what you approved/);
});

test('it survives a restart', async () => {
  const st = storage();
  const host = { storage: st, now: () => NOW, announce: () => {}, run: async () => ({}) as never };
  await new RoutineScheduler(host).add({ request: 'x', steps: [STEP], labels: ['One'], at: NOW + 1000, repeat: 'weekdays' });
  const b = new RoutineScheduler(host);
  assert.equal((await b.list()).length, 1);
});

// ---- the skill: what is allowed in --------------------------------------------------------------

function skillRig(sentencePlan: PlanStep[] | null, answer = true) {
  const registry = new SkillRegistry();
  const mk = (id: string, risk: Skill['risk'], extra: Partial<Skill> = {}): Skill => ({ id, label: id.toUpperCase(), icon: 'x', domain: 'x', description: 'd', risk, params: {}, run: async () => ({ ok: true }), ...extra });
  registry.registerMany([mk('app.open', 'safe'), mk('files.delete', 'confirm'), mk('system.power', 'safe'), mk('input.typeText', 'safe'), mk('system.volumeSet', 'safe'), mk('git.stash', 'confirm', { riskFor: (a) => (a.action === 'list' ? 'safe' : undefined) })]);
  const s = new RoutineScheduler({ storage: storage(), now: () => NOW, announce: () => {}, run: async () => ({}) as never });
  const skills = Object.fromEntries(
    createRoutineSkills({ scheduler: s, skills: registry, planFor: async () => (sentencePlan ? ({ source: 'grammar', intent: 'x', steps: sentencePlan, confidence: 1 } as Plan) : null), now: () => new Date(NOW) }).map((k) => [k.id, k]),
  );
  const cards: string[] = [];
  const run = (id: string, args: Record<string, unknown>) =>
    skills[id]!.run(args, { confirm: async (q: string, d?: string) => { cards.push(`${q}\n${d ?? ''}`); return answer; } } as never) as Promise<{ ok: boolean; message?: string; error?: string }>;
  return { s, run, cards };
}

test('a safe step is allowed, shown as the exact steps, and made only on a yes', async () => {
  const yes = skillRig([{ skill: 'app.open', args: { name: 'spotify' } }]);
  const r = await yes.run('routine.create', { when: 'every day at 8', then: 'open spotify' });
  assert.equal(r.ok, true);
  assert.match(yes.cards[0]!, /every day, starting .*\n1\. APP\.OPEN — spotify/);
  assert.match(yes.cards[0]!, /It stops if anything wants to ask you/);
  assert.equal((await yes.s.list()).length, 1);

  const no = skillRig([{ skill: 'app.open', args: { name: 'spotify' } }], false);
  const declined = await no.run('routine.create', { when: 'every day at 8', then: 'open spotify' });
  assert.equal(declined.ok, false);
  assert.equal((await no.s.list()).length, 0);
});

test('anything that could need asking at 2am is refused when the routine is made', async () => {
  for (const [step, why] of [
    [{ skill: 'files.delete', args: { path: 'x' } }, /never need asking/],
    [{ skill: 'system.power', args: { action: 'shutdown' } }, /nobody watching/],
    [{ skill: 'input.typeText', args: { text: 'hi' } }, /nobody watching/],
    [{ skill: 'git.stash', args: { action: 'push' } }, /never need asking/],
  ] as Array<[PlanStep, RegExp]>) {
    const k = skillRig([step]);
    const r = await k.run('routine.create', { when: 'every day at 8', then: 'x' });
    assert.equal(r.ok, false, step.skill);
    assert.match(String(r.error), why);
    assert.equal(k.cards.length, 0, 'no card for something that could never run');
    assert.equal((await k.s.list()).length, 0);
  }
  // but the same skill with arguments that are safe is fine
  const ok = skillRig([{ skill: 'git.stash', args: { action: 'list' } }]);
  assert.equal((await ok.run('routine.create', { when: 'every day at 8', then: 'x' })).ok, true);
});

test('a time that does not repeat, or a sentence that is not understood, makes nothing', async () => {
  const k = skillRig([{ skill: 'app.open', args: { name: 'a' } }]);
  assert.equal((await k.run('routine.create', { when: 'tomorrow at 8', then: 'open a' })).ok, false);
  assert.equal((await skillRig(null).run('routine.create', { when: 'every day at 8', then: 'gibberish' })).ok, false);
});

test('list and cancel', async () => {
  const k = skillRig([{ skill: 'app.open', args: { name: 'spotify' } }]);
  await k.run('routine.create', { when: 'every weekday at 9am', then: 'open spotify' });
  assert.match(String((await k.run('routine.list', {})).message), /every weekday .* APP\.OPEN — spotify/);
  assert.equal((await k.run('routine.cancel', { which: 'zebra' })).ok, false);
  assert.match(String((await k.run('routine.cancel', { which: 'spotify' })).message), /Cancelled/);
  assert.equal((await k.s.list()).length, 0);
});
