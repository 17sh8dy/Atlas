/**
 * Workflow memory — "remember this as my morning routine", run again later.
 *
 * A saved workflow is a name and a list of plan steps the person has read and approved. It is NOT a way
 * round anything:
 *
 *  - **Replaying is running.** `workflow.replay` hands the steps to the ordinary `Executor`, so every
 *    step is checked, confirmed, previewed, verified and stopped by F8 exactly as if it had just been
 *    asked for. An approval at save time is for saving; it never pre-approves a later run.
 *  - **Nothing secret is stored.** A step whose arguments look like a password, token, key or other
 *    credential is refused at save time (`secretIn`), and so is anything that could only have worked by
 *    carrying one. Nothing leaves the machine; the data lives in Atlas's own storage.
 *  - **Only skills that exist.** Replay re-checks each id against the live registry, so a step for a
 *    skill that was removed or is unavailable on this PC is reported instead of guessed at.
 *  - **Bounded.** A workflow has at most `MAX_STEPS` steps; at most `MAX_WORKFLOWS` are kept.
 *
 * Pure data plus `Storage`; no skill, no model.
 */

import type { PlanStep, Storage } from '@atlas/core';

export const WORKFLOWS_KEY = 'atlas.workflows';
export const MAX_STEPS = 12;
export const MAX_WORKFLOWS = 40;
const NAME_MAX = 60;

export interface SavedWorkflow {
  name: string;
  steps: PlanStep[];
  /** The sentence it was made from, if there was one (shown to the person, never replayed as text). */
  request?: string;
  createdAt: number;
  updatedAt: number;
  runs: number;
  lastRunAt?: number;
  /** One line about how the last replay went. */
  lastNote?: string;
}

/** "My Morning  routine!" → "morning routine". Stable, lower-case, no fluff. */
export function workflowKey(name: string): string {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\b(?:my|the|a|an|workflow|routine|macro)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
}

const SECRET_KEY = /pass(?:word|phrase|wd)?|secret|token|api[-_ ]?key|apikey|auth(?:orization)?|bearer|credential|private[-_ ]?key|session[-_ ]?id|cookie|\bpin\b|\bssn\b/i;
const SECRET_VALUE = [
  /\bsk-[A-Za-z0-9_-]{16,}/, // API-style keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, // GitHub tokens
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:password|passwd|pwd|token|secret|api[-_ ]?key)\s*[=:]\s*\S{4,}/i, // "password=hunter2" inside a script
  /\b\d{3}-\d{2}-\d{4}\b/, // a US social security number shape
  /\b(?:\d[ -]?){15,16}\b/, // a card number shape
];

/** The first thing in these steps that looks like a credential, described without repeating it. */
export function secretIn(steps: readonly PlanStep[]): string | null {
  const visit = (value: unknown, path: string): string | null => {
    if (typeof value === 'string') {
      for (const re of SECRET_VALUE) if (re.test(value)) return `${path} looks like a password, token or key`;
      return null;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (SECRET_KEY.test(k) && v !== undefined && v !== null && v !== '' && v !== false) return `"${k}" is a credential field`;
        const hit = visit(v, `${path}.${k}`);
        if (hit) return hit;
      }
    }
    return null;
  };
  for (let i = 0; i < steps.length; i++) {
    const hit = visit(steps[i]!.args ?? {}, `step ${i + 1}`);
    if (hit) return `step ${i + 1}: ${hit}`;
  }
  return null;
}

/** Skills that must never be replayed from memory, whatever approval they once got. */
const NEVER_REPLAYED = new Set(['workflow.replay', 'workflow.remember', 'devagent.run', 'uiagent.run']);

export type Validation = { ok: true; steps: PlanStep[] } | { ok: false; error: string };

/** Checks steps before they are stored. `known` answers "is this a real skill id?". */
export function validateSteps(steps: readonly PlanStep[], known: (id: string) => boolean): Validation {
  if (!steps.length) return { ok: false, error: 'There is nothing to save: no steps.' };
  if (steps.length > MAX_STEPS) return { ok: false, error: `A workflow can have at most ${MAX_STEPS} steps; this one has ${steps.length}.` };
  for (const s of steps) {
    if (!s || typeof s.skill !== 'string' || !known(s.skill)) return { ok: false, error: `I don't know how to do "${String(s?.skill)}".` };
    if (NEVER_REPLAYED.has(s.skill)) return { ok: false, error: `"${s.skill}" can't be part of a saved workflow.` };
  }
  const secret = secretIn(steps);
  if (secret) return { ok: false, error: `I won't save that: ${secret}. Saved workflows never hold credentials.` };
  return { ok: true, steps: steps.map((s) => ({ skill: s.skill, args: { ...(s.args ?? {}) } })) };
}

type Listener = (items: readonly SavedWorkflow[]) => void;

export class WorkflowMemory {
  private items: SavedWorkflow[] = [];
  private loaded: Promise<void> | null = null;
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly storage: Storage,
    private readonly now: () => number = () => Date.now(),
  ) {}

  load(): Promise<void> {
    this.loaded ??= this.storage
      .get<SavedWorkflow[]>(WORKFLOWS_KEY)
      .then((stored) => {
        this.items = Array.isArray(stored)
          ? stored.filter((w) => w && typeof w.name === 'string' && Array.isArray(w.steps)).slice(0, MAX_WORKFLOWS)
          : [];
        this.emit();
      })
      .catch(() => undefined);
    return this.loaded;
  }

  all(): readonly SavedWorkflow[] {
    return this.items;
  }

  names(): string[] {
    return this.items.map((w) => w.name);
  }

  /** By the name a person uses: "my morning routine" finds "morning". */
  get(name: string): SavedWorkflow | undefined {
    const key = workflowKey(name);
    if (!key) return undefined;
    return this.items.find((w) => w.name === key) ?? this.items.find((w) => w.name.includes(key) || key.includes(w.name));
  }

  async save(name: string, steps: PlanStep[], request?: string): Promise<{ ok: true; workflow: SavedWorkflow } | { ok: false; error: string }> {
    await this.load();
    const key = workflowKey(name);
    if (!key) return { ok: false, error: 'What should I call it?' };
    const existing = this.items.find((w) => w.name === key);
    if (!existing && this.items.length >= MAX_WORKFLOWS) {
      return { ok: false, error: `You already have ${MAX_WORKFLOWS} saved workflows. Forget one first.` };
    }
    const now = this.now();
    const workflow: SavedWorkflow = existing
      ? { ...existing, steps, request, updatedAt: now }
      : { name: key, steps, request, createdAt: now, updatedAt: now, runs: 0 };
    this.items = [workflow, ...this.items.filter((w) => w.name !== key)];
    await this.persist();
    return { ok: true, workflow };
  }

  async recordRun(name: string, note: string): Promise<void> {
    const w = this.get(name);
    if (!w) return;
    w.runs += 1;
    w.lastRunAt = this.now();
    w.lastNote = note.slice(0, 200);
    await this.persist();
  }

  async remove(name: string): Promise<SavedWorkflow | undefined> {
    await this.load();
    const w = this.get(name);
    if (!w) return undefined;
    this.items = this.items.filter((x) => x !== w);
    await this.persist();
    return w;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.items);
    return () => this.listeners.delete(listener);
  }

  private async persist(): Promise<void> {
    await this.storage.set(WORKFLOWS_KEY, this.items);
    this.emit();
  }

  private emit(): void {
    const view = [...this.items];
    for (const l of this.listeners) l(view);
  }
}
