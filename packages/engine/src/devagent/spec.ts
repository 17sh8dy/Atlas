/**
 * What "done" means, written down before the work starts.
 *
 * `deriveSpec` turns a request into a small project specification — what kind of thing, what features were
 * named, and the acceptance criteria that the finished project is judged against — with plain rules and no
 * model, so it is the same every time and cannot be talked out of the user's actual words. The agent is shown
 * the spec on every step; `TaskState` keeps the status of each criterion from what was OBSERVED (a passing
 * build, a clean project check), never from what the model said.
 *
 * It is deliberately modest: it does not guess a framework the user did not name, and it does not invent
 * features. Anything it cannot determine is listed under `open`, and a question is asked only when that
 * missing piece would change the result.
 */

import { stripAnsi } from '../skills/build-diagnose';

export type ProjectKind = 'website' | 'web-app' | 'game' | 'desktop-app' | 'tool' | 'api' | 'fix' | 'unknown';

export interface ProjectSpec {
  goal: string;
  kind: ProjectKind;
  /** Named by the user: "react", "vite", "tauri", "godot"… */
  stack: string[];
  /** Things the user asked for, as they said them. */
  features: string[];
  acceptance: string[];
  /** What was not stated and was not assumed. */
  open: string[];
  milestones: string[];
}

const STACKS = ['react', 'vue', 'svelte', 'angular', 'next', 'nuxt', 'vite', 'tailwind', 'typescript', 'javascript', 'python', 'flask', 'django', 'fastapi', 'express', 'node', 'electron', 'tauri', 'godot', 'unity', 'unreal', 'phaser', 'three', 'sqlite', 'postgres', 'mongodb', 'rust', 'c#', 'java', 'html'];

function kindOf(g: string): ProjectKind {
  if (/\b(?:fix|repair|debug|resolve|why (?:does|is)|failing|broken|error)\b/.test(g) && !/\bbuild me\b|\bcreate\b/.test(g)) return 'fix';
  if (/\b(?:game|snake|platformer|puzzle|clicker|arcade|shooter|roguelike)\b/.test(g)) return 'game';
  if (/\b(?:desktop app|electron|tauri|windows app|gui app)\b/.test(g)) return 'desktop-app';
  if (/\b(?:api|backend|server|rest|graphql|endpoint)\b/.test(g)) return 'api';
  if (/\b(?:web ?app|dashboard|saas|crud|full-?stack|login|accounts?|database)\b/.test(g)) return 'web-app';
  if (/\b(?:website|web ?site|landing page|portfolio|blog|homepage|multi-?page|pages?)\b/.test(g)) return 'website';
  if (/\b(?:tool|utility|cli|script|converter|calculator|tracker|generator|bot)\b/.test(g)) return 'tool';
  return 'unknown';
}

function featuresOf(goal: string): string[] {
  // "with X, Y and Z", "that has …", "including …", "it must …"
  const m = /\b(?:with|including|that (?:has|can|lets?|shows?|supports?)|featuring|which (?:has|can)|it (?:must|should|needs to|has to)|has)\b\s+(.+)$/i.exec(goal);
  if (!m) return [];
  // Where the stack is named ("… using React and Tailwind") the features have ended.
  const clause = m[1]!.split(/\s+(?:using|built with|written in|made with|in)\s+/i)[0]!;
  return clause
    .split(/\s*(?:,|;|\band\b|\bplus\b|\+)\s*/i)
    .map((f) => f.replace(/^(?:a|an|the|some|also|then)\s+/i, '').replace(/[.!]+$/, '').trim())
    .filter((f) => f.length >= 3 && f.length <= 80)
    .slice(0, 8);
}

export function deriveSpec(goalRaw: string): ProjectSpec {
  const goal = goalRaw.trim().replace(/\s+/g, ' ');
  const g = goal.toLowerCase();
  const kind = kindOf(g);
  const stack = STACKS.filter((s) => new RegExp(`(?:^|[^a-z0-9])${s.replace(/[+#.]/g, '\\$&')}(?:$|[^a-z0-9])`, 'i').test(g));
  const features = featuresOf(goal);

  const acceptance: string[] = [];
  if (kind === 'fix') {
    acceptance.push('The reported problem no longer happens (the check that failed now passes)');
    acceptance.push('Nothing that passed before fails now (the other checks are re-run)');
    acceptance.push('Only files related to the problem were changed');
  } else {
    acceptance.push('The project builds or loads with no errors');
    if (kind === 'website' || kind === 'web-app') {
      acceptance.push('Every page loads, and every file it refers to exists');
      acceptance.push('Navigation links go to real pages');
      acceptance.push('The layout works on a narrow (phone) screen as well as a wide one');
    }
    if (kind === 'game') acceptance.push('It starts, responds to input, and can be won or lost / has a clear goal');
    if (kind === 'tool' || kind === 'desktop-app') acceptance.push('It starts and its main action produces a correct result on a real example');
    if (kind === 'api') acceptance.push('Each endpoint answers a real request with the documented shape');
    for (const f of features) acceptance.push(`Works: ${f}`);
    acceptance.push('No control is a placeholder: every button does what its label says');
    acceptance.push('Failures (bad input, empty states) show a clear message');
    acceptance.push('There is a README that says how to run it');
  }

  const open: string[] = [];
  if (kind === 'unknown') open.push('what kind of project this is');
  if (!stack.length && kind !== 'fix') open.push('no framework was named, so the simplest suitable one will be used');
  if ((kind === 'web-app' || kind === 'api') && /\b(?:database|accounts?|login|users?)\b/.test(g)) open.push('how data is stored and who may sign in — nothing is deployed or connected to a live service without being asked');

  const milestones =
    kind === 'fix'
      ? ['Reproduce the failure', 'Find the cause', 'Make the smallest fix', 'Re-run every check']
      : ['Set up the project', ...(features.length ? features.slice(0, 5).map((f) => `Build: ${f}`) : ['Build the main feature']), 'Run the checks and fix what fails', 'Write the README and report'];

  return { goal, kind, stack, features, acceptance, open, milestones };
}

export type CriterionStatus = 'unchecked' | 'passed' | 'failed' | 'not-applicable';

export interface TaskStateSnapshot {
  criteria: Array<{ text: string; status: CriterionStatus; evidence?: string }>;
  /** Observed, in order: the checks that actually ran. */
  checks: Array<{ name: string; ok: boolean }>;
}

/**
 * The status of each criterion, from what was observed. Only two are decidable by Atlas itself — "the project
 * builds" (a build / typecheck / test step passed after the last change) and "files exist" (project.check
 * passed). The rest stay `unchecked` and are reported that way: Atlas does not claim a feature works because
 * a model said it does.
 */
export class TaskState {
  private checks: Array<{ name: string; ok: boolean }> = [];
  private lastChange = -1;
  private seq = 0;
  private passAfterChange = new Set<string>();
  private failing = new Set<string>();

  constructor(readonly spec: ProjectSpec) {}

  /** Something in the project was written. Earlier passes no longer vouch for it. */
  changed(): void {
    this.seq += 1;
    this.lastChange = this.seq;
    this.passAfterChange.clear();
  }

  checked(name: string, ok: boolean): void {
    this.seq += 1;
    this.checks.push({ name, ok });
    if (ok) {
      this.passAfterChange.add(name);
      this.failing.delete(name);
    } else {
      this.failing.add(name);
      this.passAfterChange.delete(name);
    }
  }

  /** At least one check has passed since the last change, and none is currently failing. */
  get verified(): boolean {
    return this.passAfterChange.size > 0 && this.failing.size === 0;
  }

  get everChanged(): boolean {
    return this.lastChange >= 0;
  }

  get failingChecks(): string[] {
    return [...this.failing];
  }

  snapshot(): TaskStateSnapshot {
    const built = this.passAfterChange.has('build') || this.passAfterChange.has('typecheck') || this.passAfterChange.has('test');
    const filesOk = this.passAfterChange.has('project-check');
    const criteria = this.spec.acceptance.map((text) => {
      if (/^The project builds or loads/.test(text)) {
        return { text, status: (built || filesOk ? 'passed' : this.failing.size ? 'failed' : 'unchecked') as CriterionStatus, evidence: built ? 'a build/test step passed after the last change' : filesOk ? 'the project check passed' : undefined };
      }
      if (/^Every page loads/.test(text)) return { text, status: (filesOk ? 'passed' : 'unchecked') as CriterionStatus, evidence: filesOk ? 'project check: every referenced file exists' : undefined };
      return { text, status: 'unchecked' as CriterionStatus };
    });
    return { criteria, checks: [...this.checks] };
  }
}

export function renderSpec(spec: ProjectSpec, state?: TaskState): string {
  const snap = state?.snapshot();
  const mark = (s: CriterionStatus) => (s === 'passed' ? '✓' : s === 'failed' ? '✕' : '·');
  const lines = [
    `Kind: ${spec.kind}${spec.stack.length ? ` · named stack: ${spec.stack.join(', ')}` : ''}`,
    'Acceptance criteria (the work is done only when these hold; ✓ means Atlas observed it, · means not yet checked):',
    ...(snap ? snap.criteria.map((c) => `  ${mark(c.status)} ${c.text}`) : spec.acceptance.map((a) => `  · ${a}`)),
  ];
  if (spec.open.length) lines.push(`Not specified: ${spec.open.join('; ')}`);
  return lines.join('\n');
}

/**
 * A search query for a failure, from its tool, code and message — or null when the failure is not one a
 * documentation search would help with (a typo in the user's own code, an assertion in their own test).
 */
export function researchQueryFor(text: string): string | null {
  const t = stripAnsi(text);
  const ts = /\b(TS\d{4}):\s*([^\n]{5,160})/.exec(t);
  if (ts) return `typescript ${ts[1]} ${ts[2]!.replace(/'[^']*'/g, '').trim()}`.slice(0, 140);
  const rust = /error\[(E\d{4})\]:\s*([^\n]{5,140})/.exec(t);
  if (rust) return `rust ${rust[1]} ${rust[2]!.replace(/`[^`]*`/g, '').trim()}`.slice(0, 140);
  const mod = /Cannot find module '([^']+)'|ModuleNotFoundError: No module named '([^']+)'/.exec(t);
  if (mod) return `${mod[1] ?? mod[2]} install how to use`;
  const npm = /(ERESOLVE[^\n]{0,80}|ELIFECYCLE[^\n]{0,60}|ERR_PNPM_\w+)/.exec(t);
  if (npm) return `npm ${npm[1]}`.slice(0, 140);
  const cpp = /\b(error C\d{4}|LNK\d{4}|undefined reference to [^\n]{3,60})/.exec(t);
  if (cpp) return `${cpp[1]} msvc fix`.slice(0, 140);
  return null;
}
