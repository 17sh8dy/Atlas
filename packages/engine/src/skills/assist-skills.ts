/**
 * Six read-only tools that make Atlas easier to trust and to debug (1.0.9):
 *
 *   `atlas.selfAudit`            how every tool is DECLARED (schemas, risk, hidden-by) — not whether it works
 *   `workflow.dryRun`            what a request WOULD do, step by step, without doing any of it
 *   `diagnostics.explainFailure` a pasted error → likely causes and next steps, quoted evidence, no model
 *   `git.changeImpact`           what the uncommitted change touches: dependents, tests, config
 *   `config.diff`                two config files compared by meaning; secrets never printed
 *   `knowledge.citeEvidence`     passages from local files that match a question, quoted with file + line
 *
 * Every one reads and reports. None writes, runs a program the person did not already allow
 * (`git.changeImpact` uses the same git status read as `git.status`), or sends anything anywhere.
 * The logic lives in the pure modules beside this file so it can be tested without a disk.
 */

import type { Memory, Plan, Platform, Skill } from '@atlas/core';
import type { SkillRegistry } from './registry';
import { auditSkills, formatAudit } from './self-audit';
import { explainFailure, formatExplanation } from './explain-failure';
import { analyseImpact, formatImpact } from './change-impact';
import { diffConfig, formatConfigDiff, parseConfig } from './config-diff';
import { findPassages, formatPassages } from './evidence-cite';
import { resolveTarget } from './locate';
import { baseName, readProjectFiles, resolveTreePath, trimPath } from './project-files';

export interface AssistDeps {
  platform: Platform;
  skills: SkillRegistry;
  memory?: Memory;
  /** The project the person is working on, when there is one. */
  current?: { get(): Promise<string | null> };
  /** Understand a sentence without running it — `Engine.planFor`. */
  planFor: (text: string) => Promise<Plan | null>;
}

/** Words that mean a step changes something a closing window will not undo. */
const DESTRUCTIVE = /(?:^|\.)(?:delete|remove|clear|kill|close|uninstall|format|shutdown|restart|reboot|move|rename|overwrite|replaceAll|discard|empty|wipe|erase|terminate|logoff|push|revert)/i;

export function describeArgs(args: Record<string, unknown>): string {
  const parts = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? (v.length > 60 ? `${v.slice(0, 59)}…` : v) : JSON.stringify(v)}`);
  return parts.join(', ');
}

export interface DryStep {
  n: number;
  skill: string;
  label: string;
  args: string;
  status: 'ok' | 'asks' | 'hidden' | 'unknown';
  destructive: boolean;
  why?: string;
}

export function dryRunSteps(plan: Plan, skills: SkillRegistry): DryStep[] {
  return plan.steps.map((s, i) => {
    const skill = skills.get(s.skill);
    if (!skill) return { n: i + 1, skill: s.skill, label: s.skill, args: describeArgs(s.args), status: 'unknown', destructive: false, why: 'there is no such tool' };
    const available = skills.isAvailable(skill);
    const risk = skill.riskFor?.(s.args) ?? skill.risk ?? 'safe';
    const destructive = risk === 'confirm' && DESTRUCTIVE.test(skill.id);
    return {
      n: i + 1,
      skill: s.skill,
      label: skill.label,
      args: describeArgs(s.args),
      status: !available ? 'hidden' : risk === 'confirm' ? 'asks' : 'ok',
      destructive,
      why: !available ? `it needs ${(skill.needs ?? []).join(' + ') || 'something this build lacks'}` : undefined,
    };
  });
}

export function formatDryRun(request: string, plan: Plan, steps: DryStep[]): string {
  const lines = [`🧪 Dry run — nothing below was done. “${request.length > 80 ? `${request.slice(0, 79)}…` : request}” would be ${steps.length} step${steps.length === 1 ? '' : 's'}:`, ''];
  for (const s of steps) {
    const tag = s.status === 'ok' ? 'runs' : s.status === 'asks' ? 'asks you first' : s.status === 'hidden' ? 'CANNOT run here' : 'UNKNOWN tool';
    lines.push(`${s.n}. ${s.label} (${s.skill}) — ${tag}${s.destructive ? ' · changes something' : ''}${s.why ? ` · ${s.why}` : ''}`);
    if (s.args) lines.push(`     ${s.args}`);
  }
  const asks = steps.filter((s) => s.status === 'asks').length;
  const blocked = steps.filter((s) => s.status === 'hidden' || s.status === 'unknown');
  const changes = steps.filter((s) => s.destructive);
  lines.push('');
  if (blocked.length) lines.push(`❌ ${blocked.length} step${blocked.length === 1 ? ' cannot' : 's cannot'} run on this PC (${blocked.map((b) => b.skill).join(', ')}), so the whole thing would stop there.`);
  if (changes.length) lines.push(`⚠️ ${changes.length} step${changes.length === 1 ? '' : 's'} change${changes.length === 1 ? 's' : ''} something: ${changes.map((c) => c.label).join(', ')}.`);
  lines.push(asks ? `${asks} step${asks === 1 ? '' : 's'} would ask for your approval; the rest run on their own.` : 'None of the steps would ask for approval.');
  if (plan.source !== 'grammar') lines.push(`This plan came from a model (confidence ${Math.round(plan.confidence * 100)}%), so the real run could be planned differently.`);
  lines.push('A step’s results can change what later steps do, so this is the plan, not a promise of the outcome.');
  return lines.join('\n');
}

export function createAssistSkills({ platform, skills, memory, current, planFor }: AssistDeps): Skill[] {
  const out: Skill[] = [];

  out.push({
    id: 'atlas.selfAudit',
    label: 'Audit my own tools',
    icon: '🧰',
    domain: 'atlas',
    description:
      'Check how every Atlas tool is declared: names, descriptions, parameter types, risk ratings, and which are hidden here because this build lacks something. Reads the tool list only; does not run any tool and does not prove they work.',
    risk: 'safe',
    examples: ['audit your tools', 'check your own tools'],
    params: {},
    run() {
      const views = skills.all().map((s) => ({
        id: s.id,
        label: s.label,
        domain: s.domain,
        description: s.description,
        risk: s.risk,
        needs: s.needs,
        examples: s.examples,
        hasRiskFor: Boolean(s.riskFor),
        params: s.params as never,
        available: skills.isAvailable(s),
      }));
      const report = auditSkills(views);
      return { ok: true, message: formatAudit(report), aloud: false, data: { total: report.total, available: report.available, findings: report.findings.length } };
    },
  });

  out.push({
    id: 'workflow.dryRun',
    label: 'Dry-run a request',
    icon: '🧪',
    domain: 'workflow',
    description:
      'Show what a request WOULD do — each step, which would ask for approval, which change something, which cannot run on this PC — without running any of it.',
    risk: 'safe',
    examples: ['dry run: clean up my downloads', 'what would happen if I said organize my desktop'],
    params: { request: { type: 'string', required: true, description: 'the request to plan but not run' } },
    async run(args) {
      const request = String(args.request ?? '').trim();
      if (!request) return { ok: false, error: 'What should I dry-run? Say “dry run: …” and then the request.' };
      const plan = await planFor(request).catch(() => null);
      if (!plan || !plan.steps.length) return { ok: true, message: `🧪 I couldn’t turn “${request}” into steps I know how to run, so there is nothing to preview. Try wording it as a command.` };
      const steps = dryRunSteps(plan, skills);
      return { ok: true, message: formatDryRun(request, plan, steps), aloud: false, data: { steps } };
    },
  });

  out.push({
    id: 'diagnostics.explainFailure',
    label: 'Explain an error',
    icon: '🩺',
    domain: 'diagnostics',
    description:
      'Explain a pasted error message: the kind of failure, the line that shows it, the common causes and what to try. A table of known failure shapes; says so plainly when it does not recognise one.',
    risk: 'safe',
    examples: ['explain this error: ENOENT no such file or directory', 'what does EADDRINUSE mean'],
    params: {
      error: { type: 'string', required: true, description: 'the error text, as it appeared' },
      context: { type: 'string', required: false, description: 'what was being run, if known' },
    },
    run(args) {
      const error = String(args.error ?? '').trim();
      if (!error) return { ok: false, error: 'Paste the error and I’ll look at it: “explain this error: …”.' };
      const e = explainFailure(error, String(args.context ?? ''));
      return { ok: true, message: formatExplanation(e), aloud: false, data: { recognised: e.recognised, kinds: e.matches.map((m) => m.rule.id) } };
    },
  });

  out.push({
    id: 'git.changeImpact',
    label: 'What does my change affect?',
    icon: '🧭',
    domain: 'git',
    description:
      'Look at the uncommitted changes in a project and say which files import them, which tests probably cover them, and whether they touch dependencies or configuration. An estimate from import statements; runs nothing.',
    needs: ['devtools'],
    risk: 'safe',
    examples: ['what does my change affect', 'what could my changes break'],
    params: { path: { type: 'string', required: false, description: 'the project folder (defaults to your current project)' } },
    async run(args) {
      let root = trimPath(String(args.path ?? ''));
      if (root && !/^(?:[a-z]:[\\/]|\\\\)/i.test(root)) {
        const found = await resolveTarget(platform, memory, root);
        if (!found.ok) return { ok: false, error: found.error };
        root = found.path;
      }
      if (!root) root = (await current?.get()) ?? '';
      if (!root) return { ok: false, error: 'Which project? Give me the folder, or say “use D:\\Dev\\MyApp as my project” once.' };
      if (!platform.gitStatus || !platform.dirTree) return { ok: false, error: "I can't read git or folders on this device." };
      let status;
      try {
        status = await platform.gitStatus(root);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : `I couldn’t read git status in ${root}.` };
      }
      const changed = [...new Set([...status.staged, ...status.unstaged, ...status.untracked])].map((p) => p.replace(/\\/g, '/').replace(/^"|"$/g, '').replace(/^.* -> /, ''));
      let tree;
      try {
        tree = await platform.dirTree(root, 8, 4000);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : `I couldn’t look inside ${root}.` };
      }
      const files = tree
        .filter((t) => !t.isDirectory)
        .map((t) => resolveTreePath(root, t.path)?.rel)
        .filter((r): r is string => Boolean(r) && !/(?:^|\/)(?:node_modules|\.git|\.atlas-backup)\//.test(r!));
      const gathered = await readProjectFiles(platform, root, (p) => /\.(?:[cm]?[jt]sx?|py)$/i.test(p));
      const texts = new Map<string, string>('error' in gathered ? [] : gathered.files.map((f) => [f.rel, f.text]));
      const impact = analyseImpact({ changed, files, texts });
      return { ok: true, message: formatImpact(baseName(root), impact), aloud: false, data: impact };
    },
  });

  out.push({
    id: 'config.diff',
    label: 'Compare two config files',
    icon: '⚖️',
    domain: 'files',
    description:
      'Compare two configuration files (JSON, .env, ini, TOML, simple YAML) by their settings rather than their lines, and say what was added, removed and changed. Passwords, tokens and keys are never shown. Changes nothing.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['compare the config files D:\\App\\a.json and D:\\App\\b.json'],
    params: {
      a: { type: 'string', required: true, description: 'the first file (the older or the current one)' },
      b: { type: 'string', required: true, description: 'the second file (the newer one)' },
    },
    async run(args) {
      if (!platform.readTextFile) return { ok: false, error: "I can't read files on this device." };
      const read = async (spec: unknown) => {
        const found = await resolveTarget(platform, memory, String(spec ?? ''));
        if (!found.ok) return { error: found.error } as const;
        try {
          return { path: found.path, text: await platform.readTextFile!(found.path) } as const;
        } catch (e) {
          return { error: e instanceof Error ? e.message : `I couldn’t read ${found.path}.` } as const;
        }
      };
      const [fa, fb] = [await read(args.a), await read(args.b)];
      if ('error' in fa) return { ok: false, error: fa.error };
      if ('error' in fb) return { ok: false, error: fb.error };
      const pa = parseConfig(fa.path, fa.text);
      if ('error' in pa) return { ok: false, error: pa.error };
      const pb = parseConfig(fb.path, fb.text);
      if ('error' in pb) return { ok: false, error: pb.error };
      const d = diffConfig(pa.values, pb.values);
      return { ok: true, message: formatConfigDiff(baseName(fa.path), baseName(fb.path), d), aloud: false, data: { added: d.added.length, removed: d.removed.length, changed: d.changed.length, same: d.same } };
    },
  });

  out.push({
    id: 'knowledge.citeEvidence',
    label: 'Find the evidence in my files',
    icon: '📎',
    domain: 'files',
    description:
      'Answer a question from the text files in a folder by quoting the matching passages exactly, with the file and line numbers. Retrieval only: it never adds words of its own, and says so when nothing matches.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['what do my notes say about the update system in D:\\Dev\\Atlas\\docs'],
    params: {
      question: { type: 'string', required: true, description: 'what to find, in a few specific words' },
      folder: { type: 'string', required: false, description: 'the folder to look in (defaults to your current project)' },
    },
    async run(args) {
      const question = String(args.question ?? '').trim();
      if (!question) return { ok: false, error: 'What should I look for?' };
      let root = trimPath(String(args.folder ?? ''));
      if (root && !/^(?:[a-z]:[\\/]|\\\\)/i.test(root)) {
        const found = await resolveTarget(platform, memory, root);
        if (!found.ok) return { ok: false, error: found.error };
        root = found.path;
      }
      if (!root) root = (await current?.get()) ?? '';
      if (!root) return { ok: false, error: 'Which folder should I look in? Name it: “… in D:\\Dev\\Atlas\\docs”.' };
      const gathered = await readProjectFiles(platform, root, (p) => /\.(?:md|markdown|txt|rst|adoc|json|ya?ml|toml|ini|csv|html?|[cm]?[jt]sx?|py|rs|cs|go|java|css)$/i.test(p));
      if ('error' in gathered) return { ok: false, error: gathered.error };
      const result = findPassages(question, gathered.files.map((f) => ({ rel: f.rel, text: f.text })));
      const tail = gathered.skipped ? `\n(${gathered.skipped} file${gathered.skipped === 1 ? ' was' : 's were'} too large or past the cap, so not searched.)` : '';
      return { ok: true, message: formatPassages(question, result, gathered.files.length) + tail, aloud: false, data: { passages: result.passages.map((p) => ({ file: p.file, from: p.from, to: p.to })) } };
    },
  });

  return out;
}
