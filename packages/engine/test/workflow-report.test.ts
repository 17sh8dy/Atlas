/**
 * The standard account of a run. Driven through the REAL Executor, so the states come from what the
 * executor actually reports (failed / declined / halted / padded-as-not-reached), not from a
 * hand-written outcome.
 */
import { describe, expect, test } from 'vitest';
import type { Plan, Skill, SkillContext, SkillResult } from '@atlas/core';
import { Executor } from '../src/planner/executor';
import { SkillRegistry } from '../src/skills/registry';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { WorkingMemory } from '../src/working-memory';
import { WorkflowLog, buildWorkflowReport, formatWorkflowReport, pathsNamedBy, stateOf } from '../src/workflow/report';
import { createWorkflowSkills } from '../src/skills/workflow-skills';

const skill = (id: string, risk: 'safe' | 'confirm', result: SkillResult | (() => SkillResult)): Skill => ({
  id,
  label: id.split('.')[1]!.replace(/^\w/, (c) => c.toUpperCase()),
  domain: 'test',
  description: id,
  risk,
  params: {},
  async run() {
    return typeof result === 'function' ? result() : result;
  },
});

async function runPlan(skills: Skill[], steps: string[], answer = true, mode: 'doIt' | 'confirmActions' = 'doIt') {
  const registry = new SkillRegistry();
  registry.registerMany(skills);
  const ctx = { say() {}, confirm: async () => answer } as unknown as SkillContext;
  const plan: Plan = { source: 'grammar', intent: 't', confidence: 1, steps: steps.map((s) => ({ skill: s, args: {} })) };
  const outcome = await new Executor(registry).run(plan, ctx, { mode });
  const report = buildWorkflowReport(outcome, { labelFor: (id) => registry.get(id)?.label ?? id, riskOf: (id) => registry.get(id)?.risk });
  return { outcome, report };
}

describe('every run gets the same account', () => {
  test('a clean run: all done, what changed, where it is', async () => {
    const { report } = await runPlan(
      [
        skill('files.list', 'safe', { ok: true, message: 'Found 3 files in D:\\Docs.' }),
        skill('files.zip', 'confirm', { ok: true, message: '📦 Zipped 3 files to D:\\Docs\\out.zip.', data: { output: 'D:\\Docs\\out.zip' } }),
      ],
      ['files.list', 'files.zip'],
    );
    expect(report.headline).toBe('All 2 steps finished.');
    expect(report.counts).toEqual({ done: 2, failed: 0, declined: 0, halted: 0, notRun: 0 });
    expect(report.changes).toEqual(['Zipped 3 files to D:\\Docs\\out.zip.']);
    expect(report.locations[0]).toBe('D:\\Docs\\out.zip');
    expect(report.remaining).toEqual([]);
    expect(report.next).toBeUndefined();
    expect(formatWorkflowReport(report)).toMatch(/What changed:\n• Zipped 3 files/);
  });

  test('a failure: which step, what is left, and what to do — finished steps are not redone', async () => {
    const { report } = await runPlan(
      [
        skill('a.one', 'safe', { ok: true, message: 'one' }),
        skill('a.two', 'confirm', { ok: false, error: 'Access is denied.\nmore detail' }),
        skill('a.three', 'confirm', { ok: true, message: 'never' }),
        skill('a.four', 'safe', { ok: true, message: 'never' }),
      ],
      ['a.one', 'a.two', 'a.three', 'a.four'],
    );
    expect(report.steps.map((s) => s.state)).toEqual(['done', 'failed', 'notRun', 'notRun']);
    expect(report.steps[1]!.detail).toBe('Access is denied.');
    expect(report.headline).toBe('1 of 4 steps finished; step 2 failed.');
    expect(report.remaining).toEqual(['Two', 'Three', 'Four']);
    expect(report.next).toMatch(/finished steps need not be repeated/);
    const text = formatWorkflowReport(report);
    expect(text).toMatch(/✕ 2\. Two — failed: Access is denied\./);
    expect(text).toMatch(/· 3\. Three — not run/);
    expect(text).toMatch(/What changed: nothing/);
  });

  test('declining a confirmation is its own state, not a failure', async () => {
    const { report } = await runPlan(
      [skill('a.one', 'safe', { ok: true, message: 'one' }), skill('a.two', 'confirm', { ok: true, message: 'two' })],
      ['a.one', 'a.two'],
      false,
      'confirmActions',
    );
    expect(report.counts.declined).toBe(1);
    expect(report.counts.failed).toBe(0);
    expect(report.headline).toMatch(/you declined 1/);
    expect(report.next).toMatch(/steps you declined/);
  });

  test('a stop is reported as a stop, with what had already happened', () => {
    const report = buildWorkflowReport(
      { ok: false, ran: 1, aborted: true, halted: true, outcomes: [{ skill: 'a.one', ok: true, message: 'done one' }, { skill: 'a.two', ok: false, skipped: true, error: 'Halted.' }, { skill: 'a.three', ok: false, skipped: true, error: 'Halted.' }] },
      { labelFor: (id) => id },
    );
    expect(report.halted).toBe(true);
    expect(report.headline).toBe('Stopped after 1 of 3 steps.');
    expect(report.remaining).toEqual(['a.two', 'a.three']);
    expect(report.next).toMatch(/Nothing further will run/);
  });

  test('state classification from the executor’s own markers', () => {
    expect(stateOf({ ok: true })).toBe('done');
    expect(stateOf({ ok: false, error: 'boom' })).toBe('failed');
    expect(stateOf({ ok: false, skipped: true, error: 'Cancelled.' })).toBe('declined');
    expect(stateOf({ ok: false, skipped: true, error: 'Skipped.' })).toBe('notRun');
    expect(stateOf({ ok: false, skipped: true, error: 'Halted.' })).toBe('halted');
  });

  test('paths are taken from messages and data, and nothing else is invented', () => {
    expect(pathsNamedBy('Moved to D:\\A\\B.txt, then "D:\\C".', { backup: 'D:\\Dev\\.atlas-backup\\replace-1' })).toEqual(['D:\\A\\B.txt', 'D:\\C', 'D:\\Dev\\.atlas-backup\\replace-1']);
    expect(pathsNamedBy('no paths here at all', {})).toEqual([]);
    const report = buildWorkflowReport({ ok: true, ran: 1, aborted: false, outcomes: [{ skill: 'x.y', ok: true, message: 'Looked.' }] }, { labelFor: (i) => i, riskOf: () => 'safe' });
    expect(report.changes).toEqual([]);
    expect(report.locations).toEqual([]);
  });
});

describe('“what did you just do”', () => {
  test('answers from the last multi-step run, says so when nothing has run, and only reads', async () => {
    const log = new WorkflowLog();
    const [ask] = createWorkflowSkills(log);
    expect(ask!.risk).toBe('safe');
    expect(((await ask!.run({}, {} as SkillContext)) as { message: string }).message).toMatch(/haven’t done anything yet/);

    const multi = await runPlan([skill('a.one', 'safe', { ok: true, message: 'one' }), skill('a.two', 'confirm', { ok: true, message: 'two to D:\\Out' })], ['a.one', 'a.two']);
    log.record(multi.report);
    const single = await runPlan([skill('a.one', 'safe', { ok: true, message: 'one' })], ['a.one']);
    log.record(single.report);
    expect(log.latest()).toBe(single.report);
    expect(log.latestMulti()).toBe(multi.report);
    const said = ((await ask!.run({}, {} as SkillContext)) as { message: string }).message;
    expect(said).toMatch(/All 2 steps finished/);
    expect(said).toMatch(/D:\\Out/);
  });

  test('the log is capped and can be cleared', () => {
    const log = new WorkflowLog(2);
    const r = (n: number) => ({ headline: String(n), steps: [], counts: { done: 0, failed: 0, declined: 0, halted: 0, notRun: 0 }, changes: [], locations: [], remaining: [], halted: false });
    log.record(r(1));
    log.record(r(2));
    log.record(r(3));
    expect(log.latest()!.headline).toBe('3');
    log.clear();
    expect(log.latest()).toBeNull();
  });

  test('the phrasings reach it, and "what changed" keeps its file-history meaning', () => {
    const g = new Grammar();
    g.addMany(createCoreGrammar(new WorkingMemory()));
    g.addMany(createExtraGrammar());
    for (const text of ['what did you just do', 'what have you done so far', "what's left to do", 'show the last task report', 'summarize the last run']) {
      expect(g.parse(text)?.steps[0]?.skill, text).toBe('workflow.last');
    }
    expect(g.parse('what did you just change')?.steps[0]?.skill).not.toBe('workflow.last');
  });
});
