/**
 * Transactional workflows: several steps run as ONE unit, with a checkpoint after every step, a way
 * back where one exists, and a history.
 *
 * What this promises, and what it does not:
 *
 *   - VALIDATE FIRST. Every part of the request is turned into steps before anything runs. If any
 *     part is not understood, or a step names a tool that does not exist or cannot run here, nothing
 *     runs at all.
 *   - ONE APPROVAL for the whole plan, with the same summary `workflow.dryRun` gives (what asks,
 *     what changes something). It is not a way round anything: each step still goes through the
 *     normal executor, so a step that asks for approval still asks, the content policy still applies,
 *     and the execution mode still decides how. Approving the plan never approves a step in advance.
 *   - CHECKPOINTS. After every step the state is saved (a step that finished, with the undo it
 *     reported). If Atlas is stopped or closes half-way, "resume the workflow" carries on from the
 *     last step that finished. A step that was IN FLIGHT cannot be known to have finished, so it asks.
 *     "Verified" here means the tool reported success; Atlas cannot see inside a tool further than that.
 *   - ROLLBACK WHERE POSSIBLE. A tool that can be put back says how in its result (`undo`). On a
 *     failure Atlas offers to undo the finished steps, newest first, through the same executor (so
 *     an undo that asks, asks). A step with no undo (a sent message, a deleted file the tool did not
 *     keep) CANNOT be rolled back, and the report says exactly which. Nothing is "all or nothing"
 *     in the database sense; it is "all, or stop and tell you precisely what is half-done".
 *   - HISTORY. The last thirty workflows, each step with its outcome.
 */

import type { ExecutionMode, Plan, PlanStep, SkillArgs, SkillContext, Storage, StepOutcome } from '@atlas/core';
import type { Executor } from '../planner/executor';
import type { SkillRegistry } from '../skills/registry';

export type TxStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'rolled-back' | 'rollback-failed';
export type TxStatus = 'running' | 'committed' | 'failed' | 'rolled-back' | 'partly-rolled-back' | 'interrupted';

export interface TxStep {
  n: number;
  skill: string;
  args: SkillArgs;
  label: string;
  /** The part of the request this step came from. */
  from: string;
  status: TxStepStatus;
  message?: string;
  error?: string;
  /** How to put this step back, as the tool reported it. Absent: it cannot be undone. */
  undo?: { skill: string; args: SkillArgs; label: string };
  at?: number;
}

export interface Tx {
  id: string;
  request: string;
  startedAt: number;
  endedAt?: number;
  status: TxStatus;
  steps: TxStep[];
}

const KEY = 'atlas.workflow.transactions';
const KEEP = 30;

export class TxStore {
  constructor(private readonly storage: Storage) {}

  async list(): Promise<Tx[]> {
    const raw = await this.storage.get<Tx[]>(KEY).catch(() => undefined);
    return Array.isArray(raw) ? raw : [];
  }

  async save(tx: Tx): Promise<void> {
    const all = await this.list();
    const next = [...all.filter((t) => t.id !== tx.id), tx].sort((a, b) => a.startedAt - b.startedAt).slice(-KEEP);
    await this.storage.set(KEY, next);
  }
}

/** "open notepad, then open the calculator; and then close notepad" → three parts. */
export function splitRequest(text: string): string[] {
  return text
    .split(/\s*(?:;|\r?\n|,?\s+and\s+then\s+|,\s*then\s+|\s+then\s+|\s+after\s+that,?\s+|\s+next,?\s+)\s*/i)
    .map((p) => p.trim().replace(/^(?:first|1\.|2\.|3\.|4\.|5\.|6\.|7\.|8\.|9\.|\d+\))[,:]?\s*/i, '').replace(/[.]+$/, '').trim())
    .filter(Boolean);
}

export type Planned = { ok: true; steps: Array<PlanStep & { from: string }> } | { ok: false; error: string };

/** Turn every part into steps. One part that is not understood refuses the whole request. */
export async function planParts(parts: readonly string[], planFor: (text: string) => Promise<Plan | null>): Promise<Planned> {
  const steps: Array<PlanStep & { from: string }> = [];
  for (const part of parts) {
    const plan = await planFor(part).catch(() => null);
    if (!plan || !plan.steps.length) return { ok: false, error: `I couldn’t turn “${part}” into steps I know how to run, so I haven’t started any of it.` };
    for (const s of plan.steps) steps.push({ ...s, from: part });
  }
  return { ok: true, steps };
}

export interface TxDeps {
  executor: Executor;
  skills: SkillRegistry;
  store: TxStore;
  getExecutionMode: () => ExecutionMode;
  now?: () => number;
}

export const newTx = (request: string, steps: Array<PlanStep & { from: string }>, skills: SkillRegistry, now = Date.now()): Tx => ({
  id: `tx-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
  request,
  startedAt: now,
  status: 'running',
  steps: steps.map((s, i) => ({ n: i + 1, skill: s.skill, args: { ...s.args }, label: skills.get(s.skill)?.label ?? s.skill, from: s.from, status: 'pending' as const })),
});

async function runOne(deps: TxDeps, ctx: SkillContext, skill: string, args: SkillArgs): Promise<{ outcome: StepOutcome | null; halted: boolean }> {
  const result = await deps.executor.run(
    { source: 'routine', intent: 'workflow-step', steps: [{ skill, args }], confidence: 1 },
    ctx,
    { mode: deps.getExecutionMode(), signal: ctx.signal },
  );
  return { outcome: result.outcomes[0] ?? null, halted: Boolean(result.halted) };
}

/** Run the steps that have not finished, saving a checkpoint around each. Rolls back only if the person agrees. */
export async function executeTx(tx: Tx, deps: TxDeps, ctx: SkillContext): Promise<Tx> {
  const now = deps.now ?? Date.now;
  tx.status = 'running';
  await deps.store.save(tx);
  const total = tx.steps.length;

  for (const step of tx.steps) {
    if (step.status === 'done' || step.status === 'skipped' || step.status === 'rolled-back') continue;
    ctx.say(`Step ${step.n} of ${total}: ${step.label}`, { aloud: false });
    step.status = 'running';
    step.at = now();
    await deps.store.save(tx); // checkpoint: this step is in flight

    let result: Awaited<ReturnType<typeof runOne>>;
    try {
      result = await runOne(deps, ctx, step.skill, step.args);
    } catch (e) {
      step.status = 'failed';
      step.error = e instanceof Error ? e.message : 'it threw';
      tx.status = 'failed';
      await deps.store.save(tx);
      break;
    }
    if (result.halted) {
      // Stopped by the emergency stop: whether this step finished is not known, so it stays "running".
      tx.status = 'interrupted';
      await deps.store.save(tx);
      return tx;
    }
    const o = result.outcome;
    if (o?.ok) {
      step.status = 'done';
      step.message = o.message;
      if (o.undo) step.undo = { skill: o.undo.skill, args: { ...o.undo.args }, label: o.undo.label };
      await deps.store.save(tx); // checkpoint: this step finished
      continue;
    }
    step.status = 'failed';
    step.error = o?.skipped ? 'you declined it' : (o?.error ?? 'it did not run');
    tx.status = 'failed';
    await deps.store.save(tx);
    break;
  }

  if (tx.status === 'failed') {
    await offerRollback(tx, deps, ctx);
  } else if (tx.steps.every((s) => s.status === 'done' || s.status === 'skipped')) {
    tx.status = 'committed';
  }
  tx.endedAt = now();
  await deps.store.save(tx);
  return tx;
}

/** Steps that finished and can be put back, newest first. */
export const undoable = (tx: Tx) => tx.steps.filter((s) => s.status === 'done' && s.undo).reverse();
/** Steps that finished and cannot be put back. */
export const permanent = (tx: Tx) => tx.steps.filter((s) => s.status === 'done' && !s.undo);

export async function offerRollback(tx: Tx, deps: TxDeps, ctx: SkillContext): Promise<void> {
  const back = undoable(tx);
  const stuck = permanent(tx);
  if (!back.length) return;
  const failed = tx.steps.find((s) => s.status === 'failed');
  const question = failed
    ? `Step ${failed.n} (${failed.label}) didn’t finish — ${failed.error ?? 'it failed'}. Put back the ${back.length} earlier step${back.length === 1 ? '' : 's'} that can be undone?`
    : `Put back the ${back.length} step${back.length === 1 ? '' : 's'} that can be undone?`;
  const detail = [
    ...back.map((s) => `• undo step ${s.n}: ${s.undo!.label}`),
    ...stuck.map((s) => `• step ${s.n} (${s.label}) can’t be undone and will stay as it is`),
  ].join('\n');
  const yes = await ctx.confirm(question, detail);
  if (!yes) return;
  await rollbackSteps(tx, back, deps, ctx);
}

export async function rollbackSteps(tx: Tx, back: TxStep[], deps: TxDeps, ctx: SkillContext): Promise<void> {
  for (const step of back) {
    const u = step.undo!;
    let ok = false;
    try {
      const r = await runOne(deps, ctx, u.skill, u.args);
      if (r.halted) {
        tx.status = 'interrupted';
        await deps.store.save(tx);
        return;
      }
      ok = Boolean(r.outcome?.ok);
      if (!ok) step.error = r.outcome?.skipped ? 'you declined the undo' : (r.outcome?.error ?? 'the undo did not run');
    } catch (e) {
      step.error = e instanceof Error ? e.message : 'the undo threw';
    }
    step.status = ok ? 'rolled-back' : 'rollback-failed';
    await deps.store.save(tx);
  }
  const left = tx.steps.filter((s) => s.status === 'done' || s.status === 'rollback-failed');
  tx.status = left.length ? 'partly-rolled-back' : 'rolled-back';
}

const MARK: Record<TxStepStatus, string> = { pending: '○', running: '◐', done: '✓', failed: '✕', skipped: '–', 'rolled-back': '↩', 'rollback-failed': '⚠' };
const STATUS_LINE: Record<TxStatus, string> = {
  running: 'still running',
  committed: 'finished — every step is done',
  failed: 'stopped at a failed step',
  'rolled-back': 'stopped, and the finished steps were put back',
  'partly-rolled-back': 'stopped; some steps were put back and some could not be',
  interrupted: 'interrupted — it can be resumed',
};

export function formatTx(tx: Tx, opts: { detail?: boolean } = {}): string {
  const lines = [`🔁 “${tx.request.length > 90 ? `${tx.request.slice(0, 89)}…` : tx.request}” — ${STATUS_LINE[tx.status]}.`];
  for (const s of tx.steps) {
    const extra =
      s.status === 'failed' ? ` — ${s.error ?? 'failed'}` : s.status === 'rollback-failed' ? ` — couldn’t be put back (${s.error ?? 'failed'})` : s.status === 'done' && !s.undo ? ' — cannot be undone' : '';
    lines.push(`${MARK[s.status]} ${s.n}. ${s.label}${extra}`);
    if (opts.detail && s.message) lines.push(`     ${s.message.split('\n')[0]!.slice(0, 120)}`);
  }
  const stuck = permanent(tx);
  if (tx.status === 'failed' || tx.status === 'partly-rolled-back') {
    if (stuck.length) lines.push('', `⚠️ Already done and not undoable: ${stuck.map((s) => `${s.n}. ${s.label}`).join(', ')}.`);
    const back = undoable(tx);
    if (back.length) lines.push(`${back.length} finished step${back.length === 1 ? ' is' : 's are'} still in place — say “undo the last workflow” to put ${back.length === 1 ? 'it' : 'them'} back.`);
  }
  if (tx.status === 'interrupted') lines.push('', 'Say “resume the workflow” to carry on from the last step that finished.');
  return lines.join('\n');
}
