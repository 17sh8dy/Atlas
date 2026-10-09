/**
 * The same account of every run: what finished, what failed, what was skipped, what changed, what is
 * left, and where to find the results.
 *
 * It is built from the executor's own `PlanOutcome` and nothing else, so every number is a real
 * result — nothing is estimated and nothing is inferred from how a step "looked". A step is in
 * exactly one state:
 *
 *   done      it ran and succeeded
 *   failed    it ran and did not
 *   declined  you said no to its confirmation
 *   halted    the emergency stop ended it (or it was waiting behind the step that was stopped)
 *   notRun    the plan stopped before it was reached
 *
 * “Changes made” are the steps that did something to the machine (anything not `safe`), in the words
 * the step itself reported. “Where to find it” are the paths those steps named. Both are read out of
 * messages the skills already wrote; the report adds no claims of its own.
 */

import type { PlanOutcome, SkillRisk } from '@atlas/core';

export type WorkflowStepState = 'done' | 'failed' | 'declined' | 'halted' | 'notRun';

export interface WorkflowStep {
  n: number;
  skill: string;
  label: string;
  state: WorkflowStepState;
  /** The failure, or why it didn't run. */
  detail?: string;
  /** What a finished step said it did, first line only — so “done” always says what was done. */
  result?: string;
}

export interface WorkflowReport {
  headline: string;
  steps: WorkflowStep[];
  counts: Record<WorkflowStepState, number>;
  /** What the steps that changed something said they did. */
  changes: string[];
  /** Places the steps named: files, folders, backups. */
  locations: string[];
  /** What is still to do, by step label. */
  remaining: string[];
  /** One sentence on what to do next, when there is something to do. */
  next?: string;
  halted: boolean;
}

export interface ReportOptions {
  labelFor(skillId: string): string;
  /** `safe` skills read; anything else is counted as having changed something. */
  riskOf?(skillId: string): SkillRisk | undefined;
}

const WIN_PATH = /[A-Za-z]:\\(?:[^\s"'“”<>|?*\\]+\\)*[^\s"'“”<>|?*\\]*/g;

export function stateOf(o: { ok: boolean; skipped?: boolean; error?: string }): WorkflowStepState {
  if (o.ok) return 'done';
  if (o.error === 'Halted.') return 'halted';
  if (o.error === 'Cancelled.') return 'declined';
  if (o.skipped) return 'notRun';
  return 'failed';
}

const firstLine = (text: string) => text.split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';
const clip = (text: string, max = 140) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const stripIcon = (text: string) => text.replace(/^[^\p{L}\p{N}"“'(\\]+/u, '').trim();

/** Paths mentioned in a skill's own message or structured data (path / output / backup / folder). */
export function pathsNamedBy(message: string | undefined, data: unknown): string[] {
  const found: string[] = [];
  const add = (p: unknown) => {
    if (typeof p === 'string' && /^[A-Za-z]:\\/.test(p) && !found.includes(p)) found.push(p);
  };
  // A sentence's own punctuation after a path ("…out.zip.") is not part of the path.
  for (const m of (message ?? '').matchAll(WIN_PATH)) add(m[0].replace(/[.,;:!)]+$/, ''));
  if (data && typeof data === 'object') {
    for (const key of ['path', 'output', 'backup', 'folder', 'destination', 'file']) add((data as Record<string, unknown>)[key]);
  }
  return found;
}

export function buildWorkflowReport(outcome: PlanOutcome, opts: ReportOptions): WorkflowReport {
  const steps: WorkflowStep[] = outcome.outcomes.map((o, i) => ({
    n: i + 1,
    skill: o.skill,
    label: opts.labelFor(o.skill),
    state: stateOf(o),
    detail: o.ok ? undefined : o.error && o.error !== 'Skipped.' && o.error !== 'Cancelled.' && o.error !== 'Halted.' ? firstLine(o.error) : undefined,
    result: o.ok && o.message ? clip(stripIcon(firstLine(o.message)), 90) || undefined : undefined,
  }));
  const counts: Record<WorkflowStepState, number> = { done: 0, failed: 0, declined: 0, halted: 0, notRun: 0 };
  for (const s of steps) counts[s.state] += 1;

  const changes: string[] = [];
  const locations: string[] = [];
  outcome.outcomes.forEach((o, i) => {
    if (!o.ok) return;
    const risk = opts.riskOf?.(o.skill);
    const changed = risk !== undefined && risk !== 'safe';
    const said = o.message ? clip(stripIcon(firstLine(o.message))) : '';
    if (changed && said) changes.push(said);
    else if (changed) changes.push(`${steps[i]!.label}`);
    if (changed) for (const p of pathsNamedBy(o.message, o.data)) if (!locations.includes(p)) locations.push(p);
  });
  // Reads can name where the thing they found lives; keep those too, after the changes.
  outcome.outcomes.forEach((o) => {
    if (!o.ok || (opts.riskOf?.(o.skill) ?? 'safe') !== 'safe') return;
    for (const p of pathsNamedBy(o.message, o.data)) if (!locations.includes(p) && locations.length < 8) locations.push(p);
  });

  const remaining = steps.filter((s) => s.state === 'notRun' || s.state === 'halted' || s.state === 'failed').map((s) => s.label);
  const total = steps.length;
  const halted = outcome.halted === true || counts.halted > 0;

  let headline: string;
  if (halted) headline = `Stopped after ${counts.done} of ${total} step${total === 1 ? '' : 's'}.`;
  else if (counts.failed) headline = `${counts.done} of ${total} step${total === 1 ? '' : 's'} finished; step ${steps.find((s) => s.state === 'failed')!.n} failed.`;
  else if (counts.declined) headline = `${counts.done} of ${total} step${total === 1 ? '' : 's'} finished; you declined ${counts.declined}.`;
  else headline = `All ${total} step${total === 1 ? '' : 's'} finished.`;

  let next: string | undefined;
  if (halted) next = 'Nothing further will run. Tell me when you want me to carry on with the rest.';
  else if (counts.failed) next = 'Sort out what the failed step reported, then ask me to try again — the finished steps need not be repeated.';
  else if (counts.declined) next = 'Say the word and I will do the steps you declined.';

  return { headline, steps, counts, changes, locations, remaining, next, halted };
}

const MARK: Record<WorkflowStepState, string> = { done: '✓', failed: '✕', declined: '–', halted: '■', notRun: '·' };
const WORD: Record<WorkflowStepState, string> = { done: 'done', failed: 'failed', declined: 'declined', halted: 'stopped', notRun: 'not run' };

/** The report as plain text — one shape, whatever ran. */
export function formatWorkflowReport(r: WorkflowReport): string {
  const lines = [r.headline, '', ...r.steps.map((s) => `${MARK[s.state]} ${s.n}. ${s.label} — ${WORD[s.state]}${s.detail ? `: ${s.detail}` : s.result ? `: ${s.result}` : ''}`)];
  if (r.changes.length) lines.push('', 'What changed:', ...r.changes.map((c) => `• ${c}`));
  // Not “nothing happened”: small actions such as pressing a control never ask for approval, and each
  // finished step's own result is on its line above. This only says nothing needed approval.
  else if (r.counts.done) lines.push('', 'What changed: nothing that needed your approval.');
  if (r.remaining.length) lines.push('', 'Still to do:', ...r.remaining.map((c) => `• ${c}`));
  if (r.locations.length) lines.push('', 'Where to find it:', ...r.locations.slice(0, 8).map((p) => `• ${p}`));
  if (r.next) lines.push('', r.next);
  return lines.join('\n');
}

/** Holds the latest reports so "what did you just do" can answer. In memory only: it never leaves the session. */
export class WorkflowLog {
  private reports: WorkflowReport[] = [];
  constructor(private readonly limit = 10) {}

  record(report: WorkflowReport): void {
    this.reports.push(report);
    if (this.reports.length > this.limit) this.reports.shift();
  }

  latest(): WorkflowReport | null {
    return this.reports[this.reports.length - 1] ?? null;
  }

  /** The most recent run with two or more steps, which is the one a person means by “the task”. */
  latestMulti(): WorkflowReport | null {
    for (let i = this.reports.length - 1; i >= 0; i -= 1) if (this.reports[i]!.steps.length >= 2) return this.reports[i]!;
    return null;
  }

  clear(): void {
    this.reports = [];
  }
}
