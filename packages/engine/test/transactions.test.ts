/**
 * Transactional workflows: validate first, one approval, a checkpoint per step, rollback where the
 * tools allow it, resume after an interruption, and a history. Runs the REAL executor over fake tools.
 */
import { describe, expect, test } from 'vitest';
import type { Plan, Skill, SkillContext, SkillResult, Storage } from '@atlas/core';
import { SkillRegistry } from '../src/skills/registry';
import { createTransactionSkills } from '../src/skills/transaction-skills';
import { createAssistGrammar, parseTransaction } from '../src/planner/assist-grammar';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { WorkingMemory } from '../src/working-memory';
import { splitRequest } from '../src/workflow/transaction';

type Def = { risk?: 'safe' | 'confirm'; needs?: string[]; run: (args: Record<string, unknown>, n: number) => SkillResult };

function rig(defs: Record<string, Def>, opts: { answers?: boolean[]; capabilities?: string[] } = {}) {
  const calls: string[] = [];
  const counts = new Map<string, number>();
  const skills = new SkillRegistry({ capabilities: () => (opts.capabilities ?? ['fs']) as never });
  for (const [id, d] of Object.entries(defs)) {
    skills.register({
      id,
      label: id.split('.')[1]!.toUpperCase(),
      icon: 'x',
      domain: id.split('.')[0]!,
      description: `fake ${id}`,
      risk: d.risk ?? 'safe',
      needs: d.needs as never,
      params: {},
      run: (args) => {
        const n = (counts.get(id) ?? 0) + 1;
        counts.set(id, n);
        calls.push(id);
        return d.run(args as Record<string, unknown>, n);
      },
    } as Skill);
  }
  const data = new Map<string, unknown>();
  const storage: Storage = { get: async <T>(k: string) => data.get(k) as T | undefined, set: async (k, v) => void data.set(k, v) } as Storage;
  let aborted = false;
  const asked: string[] = [];
  const answers = [...(opts.answers ?? [])];
  const ctx = {
    say: () => undefined,
    confirm: async (q: string) => {
      asked.push(q);
      return answers.length ? answers.shift()! : true;
    },
    get signal() {
      return { get aborted() { return aborted; }, addEventListener() {}, removeEventListener() {} };
    },
  } as unknown as SkillContext;
  const plans = new Map<string, Plan>();
  const planFor = async (text: string) => plans.get(text.toLowerCase()) ?? null;
  const say = (text: string, steps: Array<[string, Record<string, unknown>?]>) =>
    plans.set(text.toLowerCase(), { source: 'grammar', intent: 'x', confidence: 1, steps: steps.map(([skill, args]) => ({ skill, args: (args ?? {}) as never })) });
  const set = createTransactionSkills({ skills, storage, getExecutionMode: () => 'doIt', planFor });
  // A failed step reports through `error` (that is what the app shows); read either as text here.
  const run = async (id: string, args: Record<string, unknown> = {}) => {
    const res = await Promise.resolve(set.find((s) => s.id === id)!.run(args, ctx));
    return { ...res, message: res.message ?? res.error, reported: res.ok ? 'message' : 'error', error: res.error };
  };
  return { calls, counts, asked, run, say, data, stop: () => void (aborted = true), restart: () => void (aborted = false) };
}

const ok = (message = 'done', undo?: { skill: string; args: Record<string, unknown>; label: string }): SkillResult => ({ ok: true, message, undo: undo as never });

describe('splitting a request', () => {
  test('then, and then, semicolons and numbering all separate steps', () => {
    expect(splitRequest('open notepad, then open the calculator; close notepad')).toEqual(['open notepad', 'open the calculator', 'close notepad']);
    expect(splitRequest('first make a folder and then open it after that close it')).toEqual(['make a folder', 'open it', 'close it']);
    expect(splitRequest('just one thing')).toEqual(['just one thing']);
  });
});

describe('a workflow that works', () => {
  test('is validated, approved once, run in order, checkpointed after every step, and committed', async () => {
    const r = rig({ 'a.one': { run: () => ok('one') }, 'a.two': { run: () => ok('two') } });
    r.say('do one', [['a.one']]);
    r.say('do two', [['a.two']]);
    const out = await r.run('workflow.transaction', { request: 'do one, then do two' });
    expect(out.ok).toBe(true);
    expect(r.calls).toEqual(['a.one', 'a.two']);
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]).toMatch(/Run these 2 steps as one workflow/);
    expect(out.message).toMatch(/finished — every step is done/);
    const saved = (r.data.get('atlas.workflow.transactions') as Array<{ status: string; steps: Array<{ status: string }> }>)[0]!;
    expect(saved.status).toBe('committed');
    expect(saved.steps.map((s) => s.status)).toEqual(['done', 'done']);
    const history = await r.run('workflow.history');
    expect(history.message).toMatch(/Recent workflows/);
    expect(history.message).toMatch(/✓ 1\. ONE/);
  });
});

describe('validation happens before anything runs', () => {
  test('a part that is not understood refuses the whole request', async () => {
    const r = rig({ 'a.one': { run: () => ok() } });
    r.say('do one', [['a.one']]);
    const out = await r.run('workflow.transaction', { request: 'do one, then flibber the gibbet' });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/couldn’t turn “flibber the gibbet” into steps.*haven’t started any of it/);
    expect(r.calls).toEqual([]);
    expect(r.asked).toEqual([]);
  });

  test('a tool that cannot run here, or does not exist, refuses it before the first step', async () => {
    const r = rig({ 'a.one': { run: () => ok() }, 'w.hidden': { needs: ['window-control'], run: () => ok() } });
    r.say('do one', [['a.one']]);
    r.say('hide it', [['w.hidden']]);
    r.say('ghost', [['no.such']]);
    const hidden = await r.run('workflow.transaction', { request: 'do one, then hide it' });
    expect(hidden.error).toMatch(/haven’t started anything: step 2 \(w\.hidden\) it needs window-control/);
    const ghost = await r.run('workflow.transaction', { request: 'do one, then ghost' });
    expect(ghost.error).toMatch(/step 2 \(no\.such\) there is no such tool/);
    expect(r.calls).toEqual([]);
  });

  test('one step is not a workflow, and fifteen is the most', async () => {
    const r = rig({ 'a.one': { run: () => ok() } });
    r.say('do one', [['a.one']]);
    expect((await r.run('workflow.transaction', { request: 'do one' })).error).toMatch(/at least two steps/);
    const sixteen = Array.from({ length: 16 }, () => 'do one').join(', then ');
    expect((await r.run('workflow.transaction', { request: sixteen })).error).toMatch(/16 steps.*at most 15/);
  });

  test('declining the plan runs nothing', async () => {
    const r = rig({ 'a.one': { run: () => ok() } }, { answers: [false] });
    r.say('do one', [['a.one']]);
    const out = await r.run('workflow.transaction', { request: 'do one, then do one' });
    expect(out.ok).toBe(true);
    expect(out.message).toMatch(/haven’t run any of it/);
    expect(r.calls).toEqual([]);
  });
});

describe('approving the plan does not approve the steps', () => {
  test('a step that asks still asks, and declining it stops the workflow', async () => {
    const r = rig({ 'a.safe': { run: () => ok() }, 'a.risky': { risk: 'confirm', run: () => ok() } }, { answers: [true, false] });
    r.say('safe', [['a.safe']]);
    r.say('risky', [['a.risky']]);
    const out = await r.run('workflow.transaction', { request: 'safe, then risky' });
    expect(r.asked.length).toBeGreaterThanOrEqual(2);
    expect(r.calls).toEqual(['a.safe']);
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/✕ 2\. RISKY — you declined it/);
  });
});

describe('a failure part-way', () => {
  const failing = () =>
    rig({
      'a.make': { run: () => ok('made', { skill: 'a.unmake', args: { what: 'x' }, label: 'remove x' }) },
      'a.send': { run: () => ok('sent') }, // no undo: cannot be rolled back
      'a.break': { run: () => ({ ok: false, error: 'disk said no' }) },
      'a.unmake': { run: () => ok('unmade') },
    });

  test('offers to put back what can be, says what cannot, and does it newest first', async () => {
    const r = failing();
    r.say('make', [['a.make']]);
    r.say('send', [['a.send']]);
    r.say('break', [['a.break']]);
    const out = await r.run('workflow.transaction', { request: 'make, then send, then break' });
    expect(out.ok).toBe(false);
    expect(out.reported).toBe('error');
    const q = r.asked.find((x) => /Put back the 1 earlier step/.test(x));
    expect(q).toBeTruthy();
    expect(r.calls).toEqual(['a.make', 'a.send', 'a.break', 'a.unmake']);
    expect(out.message).toMatch(/stopped; some steps were put back and some could not be/);
    expect(out.message).toMatch(/↩ 1\. MAKE/);
    expect(out.message).toMatch(/✓ 2\. SEND — cannot be undone/);
    expect(out.message).toMatch(/✕ 3\. BREAK — disk said no/);
    expect(out.message).toMatch(/Already done and not undoable: 2\. SEND/);
  });

  test('declining the rollback leaves everything as it is, and "undo the last workflow" can do it later', async () => {
    const r = rig(
      { 'a.make': { run: () => ok('made', { skill: 'a.unmake', args: {}, label: 'remove x' }) }, 'a.break': { run: () => ({ ok: false, error: 'no' }) }, 'a.unmake': { run: () => ok() } },
      { answers: [true, false, true] },
    );
    r.say('make', [['a.make']]);
    r.say('break', [['a.break']]);
    const out = await r.run('workflow.transaction', { request: 'make, then break' });
    expect(r.calls).toEqual(['a.make', 'a.break']);
    expect(out.message).toMatch(/stopped at a failed step/);
    expect(out.message).toMatch(/say “undo the last workflow”/);
    const later = await r.run('workflow.rollback');
    expect(r.calls).toEqual(['a.make', 'a.break', 'a.unmake']);
    expect(later.message).toMatch(/put back/);
    expect((await r.run('workflow.rollback')).message).toMatch(/no workflow with steps I can put back/);
  });

  test('when every finished step could be undone, the workflow ends fully rolled back', async () => {
    const r = rig({ 'a.make': { run: () => ok('made', { skill: 'a.unmake', args: {}, label: 'remove x' }) }, 'a.break': { run: () => ({ ok: false, error: 'no' }) }, 'a.unmake': { run: () => ok() } });
    r.say('make', [['a.make']]);
    r.say('break', [['a.break']]);
    const out = await r.run('workflow.transaction', { request: 'make, then break' });
    expect(out.message).toMatch(/stopped, and the finished steps were put back/);
  });

  test('an undo that itself fails is reported, not hidden', async () => {
    const r = rig({ 'a.make': { run: () => ok('made', { skill: 'a.unmake', args: {}, label: 'remove x' }) }, 'a.break': { run: () => ({ ok: false, error: 'no' }) }, 'a.unmake': { run: () => ({ ok: false, error: 'locked' }) } });
    r.say('make', [['a.make']]);
    r.say('break', [['a.break']]);
    const out = await r.run('workflow.transaction', { request: 'make, then break' });
    expect(out.message).toMatch(/⚠ 1\. MAKE — couldn’t be put back \(locked\)/);
  });
});

describe('interruption and resume', () => {
  const three = () => {
    const r = rig({ 'a.one': { run: () => ok() }, 'a.two': { run: (_a, n) => { if (n === 1) r.stop(); return ok(); } }, 'a.three': { run: () => ok() } });
    r.say('one', [['a.one']]);
    r.say('two', [['a.two']]);
    r.say('three', [['a.three']]);
    return r;
  };

  test('the emergency stop leaves a checkpoint: finished steps stay finished, the step it landed on is in flight', async () => {
    const r = three();
    const out = await r.run('workflow.transaction', { request: 'one, then two, then three' });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/interrupted — it can be resumed/);
    expect(out.message).toMatch(/resume the workflow/);
    expect(r.calls).toEqual(['a.one', 'a.two']);
  });

  test('resume skips what finished and asks before re-running the step that was in flight', async () => {
    const r = three();
    await r.run('workflow.transaction', { request: 'one, then two, then three' });
    r.restart();
    const out = await r.run('workflow.resume');
    expect(r.asked.some((q) => /Step 2 \(TWO\) was in progress.*can’t tell whether it finished/.test(q))).toBe(true);
    expect(r.calls).toEqual(['a.one', 'a.two', 'a.two', 'a.three']);
    expect(out.ok).toBe(true);
    expect(out.message).toMatch(/finished — every step is done/);
  });

  test('saying no leaves it interrupted and runs nothing; a second resume with nothing interrupted says so', async () => {
    const r = rig({ 'a.one': { run: () => ok() }, 'a.two': { run: (_a, n) => { if (n === 1) r.stop(); return ok(); } }, 'a.three': { run: () => ok() } }, { answers: [true, false] });
    r.say('one', [['a.one']]);
    r.say('two', [['a.two']]);
    r.say('three', [['a.three']]);
    await r.run('workflow.transaction', { request: 'one, then two, then three' });
    r.restart();
    const out = await r.run('workflow.resume');
    expect(r.calls).toEqual(['a.one', 'a.two']);
    expect(out.message).toMatch(/interrupted/);
  });

  test('a workflow left "running" by a previous session shows up as interrupted', async () => {
    const r = rig({ 'a.one': { run: () => ok() } });
    r.data.set('atlas.workflow.transactions', [
      { id: 'old', request: 'old thing', startedAt: 1, status: 'running', steps: [{ n: 1, skill: 'a.one', args: {}, label: 'ONE', from: 'x', status: 'running' }] },
    ]);
    const out = await r.run('workflow.resume', {});
    expect(r.asked[0]).toMatch(/Step 1 \(ONE\) was in progress/);
    expect(r.calls).toEqual(['a.one']);
    expect(out.message).toMatch(/finished/);
  });
});

describe('what the grammar claims', () => {
  const rules = createAssistGrammar();
  const route = (text: string) => {
    for (const r of rules) {
      const p = r.test(text.toLowerCase(), text, {} as never) as { steps: Array<{ skill: string; args: Record<string, unknown> }> } | null;
      if (p) return `${p.steps[0]!.skill} ${JSON.stringify(p.steps[0]!.args)}`;
    }
    return null;
  };
  test('starting one', () => {
    expect(parseTransaction('do these as one workflow: open notepad, then open the calculator')).toBe('open notepad, then open the calculator');
    expect(parseTransaction('all or nothing: make a folder; open it')).toBe('make a folder; open it');
    expect(parseTransaction('run open notepad then close it as a transaction')).toBe('open notepad then close it');
    expect(parseTransaction('run the tests')).toBeNull();
  });
  test('resume, undo, history', () => {
    expect(route('resume the workflow')).toMatch(/^workflow\.resume/);
    expect(route('resume the interrupted workflow')).toMatch(/^workflow\.resume/);
    expect(route('undo the last workflow')).toMatch(/^workflow\.rollback/);
    expect(route('show my workflow history')).toMatch(/^workflow\.history/);
    expect(route('resume my music')).toBeNull();
  });
});

describe('through the whole grammar, as the app sees it', () => {
  const g = new Grammar();
  g.addMany(createCoreGrammar(new WorkingMemory()));
  g.addMany(createExtraGrammar());
  test('a sentence that starts like a question (“do these…”) still starts a workflow, even when a step sounds like another command', () => {
    for (const t of [
      'do these as one workflow: open the calculator, then open notepad',
      'do these as one workflow: what time is it, then how much free space is on my C drive',
      'all or nothing: make a folder, then open it',
    ])
      expect(g.parse(t)?.steps.map((s) => s.skill), t).toEqual(['workflow.transaction']);
    expect(g.parse('resume the workflow')?.steps[0]!.skill).toBe('workflow.resume');
    expect(g.parse('undo the last workflow')?.steps[0]!.skill).toBe('workflow.rollback');
    expect(g.parse('make the buttons bigger')?.steps.map((s) => s.skill)).toEqual(['builder.change', 'project.play']);
  });
});

describe('every phrasing added in 1.0.9 reaches its tool through the whole grammar', () => {
  const g = new Grammar();
  g.addMany(createCoreGrammar(new WorkingMemory()));
  g.addMany(createExtraGrammar());
  const cases: Array<[string, string]> = [
    ['audit your tools', 'atlas.selfAudit'],
    ['check your own tools', 'atlas.selfAudit'],
    ['dry run: open the calculator', 'workflow.dryRun'],
    ['what would happen if I said organize my desktop', 'workflow.dryRun'],
    ['explain this error: ENOENT no such file', 'diagnostics.explainFailure'],
    ['what does EADDRINUSE mean', 'diagnostics.explainFailure'],
    ['what does my change affect', 'git.changeImpact'],
    ['what could my changes break?', 'git.changeImpact'],
    [String.raw`compare the config files D:\a\x.json and D:\a\y.json`, 'config.diff'],
    [String.raw`what do my notes say about the update system in D:\Dev\Atlas\docs`, 'knowledge.citeEvidence'],
    ['how do you pronounce chicken', 'text.pronounce'],
    ['how do you spell necessary', 'text.spell'],
    ['show my workflow history', 'workflow.history'],
    ['undo the last change to my game', 'builder.revert'],
    ['rebuild it', 'build.run'],
    ['preview the game', 'project.play'],
  ];
  for (const [text, skill] of cases) {
    test(text, () => expect(g.parse(text)?.steps[0]?.skill).toBe(skill));
  }
});
