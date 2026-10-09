/**
 * Transactional workflows as skills (1.0.9): `workflow.transaction`, `workflow.resume`,
 * `workflow.rollback`, `workflow.history`. The mechanism, and exactly what it does and does not
 * promise, is in `../workflow/transaction.ts`.
 *
 * These skills are coordinators: they change nothing themselves. Every change is made by a step
 * that goes through the normal executor, so each step keeps its own risk rating, its own approval
 * and the content policy. The one approval asked here is for the PLAN as a whole.
 */

import type { ExecutionMode, Plan, Skill, Storage } from '@atlas/core';
import { Executor } from '../planner/executor';
import { createPhrasing, type Phrasing } from '../phrasing';
import type { SkillRegistry } from './registry';
import { dryRunSteps, describeArgs } from './assist-skills';
import {
  TxStore,
  executeTx,
  formatTx,
  newTx,
  offerRollback,
  planParts,
  splitRequest,
  undoable,
  type Tx,
  type TxDeps,
} from '../workflow/transaction';

export interface TransactionDeps {
  skills: SkillRegistry;
  storage: Storage;
  getExecutionMode: () => ExecutionMode;
  phrasing?: Phrasing;
  /** Understand a sentence without running it — `Engine.planFor`. */
  planFor: (text: string) => Promise<Plan | null>;
}

/** More than this is a script, not a workflow someone can read and approve in one go. */
export const MAX_STEPS = 15;

export function createTransactionSkills(deps: TransactionDeps): Skill[] {
  const store = new TxStore(deps.storage);
  const executor = new Executor(deps.skills, deps.phrasing ?? createPhrasing());
  const txDeps: TxDeps = { executor, skills: deps.skills, store, getExecutionMode: deps.getExecutionMode };
  let active: string | null = null;

  /** A stored "running" workflow that is not the one running now was cut off. */
  const normalised = async (): Promise<Tx[]> => {
    const all = await store.list();
    for (const t of all) {
      if (t.status === 'running' && t.id !== active) {
        t.status = 'interrupted';
        await store.save(t);
      }
    }
    return all;
  };

  const guarded = async <T>(tx: Tx, work: () => Promise<T>): Promise<T> => {
    active = tx.id;
    try {
      return await work();
    } finally {
      active = null;
    }
  };

  const transaction: Skill = {
    id: 'workflow.transaction',
    label: 'Run steps as one workflow',
    icon: '🔁',
    domain: 'workflow',
    description:
      'Run several steps as one unit: every part is understood and checked before anything starts, the whole plan is shown for one approval, each step still asks for its own approval as usual, progress is saved after every step, and if a step fails Atlas offers to undo the finished steps that can be undone and says which cannot. Steps are separated by "then" or a semicolon.',
    risk: 'safe',
    examples: ['do these as one workflow: open notepad, then open the calculator', 'all or nothing: create a folder D:\\Test, then open it'],
    params: { request: { type: 'string', required: true, description: 'the steps, in order, separated by "then" or ";"' } },
    async run(args, ctx) {
      if (active) return { ok: false, error: 'A workflow is already running. Wait for it to finish, or press the emergency stop.' };
      const request = String(args.request ?? '').trim();
      const parts = splitRequest(request);
      if (parts.length < 2) return { ok: false, error: 'A workflow needs at least two steps, separated by “then” or a semicolon: “do these as one workflow: open Notepad, then open the calculator”.' };
      const planned = await planParts(parts, deps.planFor);
      if (!planned.ok) return { ok: false, error: planned.error };
      if (planned.steps.length > MAX_STEPS) return { ok: false, error: `That is ${planned.steps.length} steps; a workflow I can show you in one piece is at most ${MAX_STEPS}. Split it into two.` };

      const dry = dryRunSteps({ source: 'routine', intent: 'workflow', confidence: 1, steps: planned.steps }, deps.skills);
      const blocked = dry.filter((s) => s.status === 'hidden' || s.status === 'unknown');
      if (blocked.length) {
        return { ok: false, error: `I haven’t started anything: ${blocked.map((b) => `step ${b.n} (${b.skill}) ${b.why ?? 'cannot run here'}`).join('; ')}.` };
      }

      const tx = newTx(request, planned.steps, deps.skills);
      const detail = [
        ...dry.map((s) => `${s.n}. ${s.label}${s.args ? ` — ${describeArgs(planned.steps[s.n - 1]!.args as Record<string, unknown>)}` : ''}${s.status === 'asks' ? ' (asks you first)' : ''}${s.destructive ? ' (changes something)' : ''}`),
        '',
        'If a step fails I’ll offer to undo the earlier steps that can be undone, and tell you which can’t. Each step that asks for approval will still ask.',
      ].join('\n');
      if (!(await ctx.confirm(`Run these ${tx.steps.length} steps as one workflow?`, detail))) {
        return { ok: true, message: 'Okay — I haven’t run any of it.' };
      }
      const done = await guarded(tx, () => executeTx(tx, txDeps, ctx));
      return { ok: done.status === 'committed', message: formatTx(done), aloud: false, data: { id: done.id, status: done.status } };
    },
  };

  const resume: Skill = {
    id: 'workflow.resume',
    label: 'Resume the interrupted workflow',
    icon: '⏯️',
    domain: 'workflow',
    description:
      'Carry on an interrupted workflow from the last step that finished. A step that was in progress when it stopped cannot be known to have finished, so Atlas asks before running it again.',
    risk: 'safe',
    examples: ['resume the workflow', 'resume the interrupted workflow'],
    params: {},
    async run(_args, ctx) {
      if (active) return { ok: false, error: 'A workflow is running right now.' };
      const tx = [...(await normalised())].reverse().find((t) => t.status === 'interrupted');
      if (!tx) return { ok: true, message: 'There is no interrupted workflow to resume.' };
      const inflight = tx.steps.find((s) => s.status === 'running');
      if (inflight) {
        const again = await ctx.confirm(
          `Step ${inflight.n} (${inflight.label}) was in progress when the workflow stopped, so I can’t tell whether it finished. Run it again?`,
          'Choose No to leave the workflow as it is for now. I won’t assume it finished.',
        );
        if (!again) return { ok: true, message: formatTx(tx) };
        inflight.status = 'pending';
      }
      const done = await guarded(tx, () => executeTx(tx, txDeps, ctx));
      return { ok: done.status === 'committed', message: formatTx(done), aloud: false, data: { id: done.id, status: done.status } };
    },
  };

  const rollback: Skill = {
    id: 'workflow.rollback',
    label: 'Undo the last workflow',
    icon: '↩️',
    domain: 'workflow',
    description:
      'Put back the steps of the most recent workflow that can be put back, newest first, and list the ones that cannot. Each undo goes through the usual approval.',
    risk: 'safe',
    examples: ['undo the last workflow'],
    params: {},
    async run(_args, ctx) {
      if (active) return { ok: false, error: 'A workflow is running right now.' };
      const tx = [...(await normalised())].reverse().find((t) => undoable(t).length > 0);
      if (!tx) return { ok: true, message: 'There is no workflow with steps I can put back.' };
      await guarded(tx, async () => {
        await offerRollback(tx, txDeps, ctx);
        await store.save(tx);
      });
      return { ok: true, message: formatTx(tx), aloud: false, data: { id: tx.id, status: tx.status } };
    },
  };

  const history: Skill = {
    id: 'workflow.history',
    label: 'Workflow history',
    icon: '🗂️',
    domain: 'workflow',
    description: 'List the most recent workflows Atlas ran as a unit, with how each step went. Read-only.',
    risk: 'safe',
    examples: ['show my workflow history'],
    params: {},
    async run() {
      const all = (await normalised()).slice(-5).reverse();
      if (!all.length) return { ok: true, message: 'I haven’t run any workflows yet. Try “do these as one workflow: open Notepad, then open the calculator”.' };
      const when = (t: number) => new Date(t).toLocaleString();
      const lines = ['🗂️ Recent workflows:', ''];
      for (const t of all) lines.push(`${when(t.startedAt)}`, formatTx(t), '');
      return { ok: true, message: lines.join('\n').trimEnd(), aloud: false, data: all.map((t) => ({ id: t.id, status: t.status })) };
    },
  };

  return [transaction, resume, rollback, history];
}
