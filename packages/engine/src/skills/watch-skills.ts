/**
 * Atlas Watch, as skills — "watch this download", "tell me when OBS closes",
 * "when the build finishes, run the tests, package it and open the result".
 *
 * `watch.create` does the understanding up front, while the person is here to
 * answer questions: it resolves the condition against what is running *now*
 * ("the build" → `cargo.exe`), turns the "then …" part into validated plan
 * steps, fills in a project folder if the steps need one, and shows all of it
 * on one card. Approving that card is the approval the continuation runs under
 * later, unattended — so the card says exactly that.
 *
 * The rest (`watch.list`, `watch.pause`, `watch.resume`, `watch.cancel`,
 * `watch.answer`) are the controls the person asked for: inspect, pause,
 * cancel, delete, and answer a watch that is waiting for them. They act on
 * Atlas's own watch list, never on the machine, so none of them asks first.
 */

import type {
  Clarification,
  Plan,
  PlanStep,
  Platform,
  ResultRow,
  Skill,
  SkillArgs,
  SkillContext,
  SkillPreview,
  Watch,
  WatchCondition,
} from '@atlas/core';
import { FINISHED_WATCH_STATUSES } from '@atlas/core';
import type { SkillRegistry } from './registry';
import { PACKAGE_SCRIPTS } from './devtools-skills';
import type { WatchManager } from '../watch/manager';
import {
  describeCondition,
  fingerprintSteps,
  isPartialDownload,
  stripPartial,
} from '../watch/conditions';
import {
  BUILD_PROCESSES,
  imageKey,
  matchRunningProcess,
  PROTECTED_PROCESSES,
} from '../text/processes';

export interface WatchSkillDeps {
  platform: Platform;
  skills: SkillRegistry;
  /** The live manager. A getter, because the host builds it after the skills. */
  manager: () => WatchManager | null;
  /** Understand a sentence without running it — `Engine.planFor`. */
  planFor: (text: string) => Promise<Plan | null>;
}

/**
 * Skills a continuation may not contain. An open-ended agent deciding its own
 * next steps is exactly what should not run while nobody is watching, and a
 * watch that makes watches is a loop with extra steps.
 */
const NOT_IN_A_CONTINUATION = new Set([
  'devagent.run',
  'uiagent.run',
  'watch.create',
  'watch.cancel',
  'watch.pause',
  'watch.resume',
  'watch.answer',
  'system.power',
]);

/** Continuation steps that work on a project folder, and fill it from one question. */
const PROJECT_STEPS = new Set([
  'build.run',
  'test.run',
  'project.launch',
  'project.detect',
  'build.configure',
]);

const THIS_THING =
  /^(?:this|that|it|this one|this process|this program|this app|this window|the app|the program|the process)$/i;

interface Draft {
  condition: WatchCondition;
  steps: PlanStep[];
  labels: string[];
  sawProcess?: boolean;
  ttlMs?: number;
}

type Resolved = { ok: true; draft: Draft } | { ok: false; error: string };

export function createWatchSkills(deps: WatchSkillDeps): Skill[] {
  const { platform } = deps;
  /** Drafts built for a card, waiting for its answer, by fingerprint. */
  const drafts = new Map<string, Draft>();

  const need = (): WatchManager | { error: string } =>
    deps.manager() ?? { error: 'Watches aren’t available in this build.' };

  // ── understanding "when …" ───────────────────────────────────────────────

  async function chooseOne(
    ctx: SkillContext,
    question: string,
    names: string[],
  ): Promise<string | null> {
    if (!ctx.clarify) return null;
    const clarification: Clarification = {
      question,
      choices: names.slice(0, 6).map((n, i) => ({ id: `p${i}`, label: n, value: n })),
    };
    const answer = await ctx.clarify(clarification);
    if (answer.kind !== 'choice') return null;
    return clarification.choices.find((c) => c.id === answer.id)?.value ?? null;
  }

  /** The window someone means by "this" — the frontmost one that isn't Atlas. */
  async function frontmostOther(): Promise<{ process: string; title: string } | null> {
    const windows = (await platform.listWindows?.().catch(() => [])) ?? [];
    const hit = windows.find(
      (w) => w.title.trim() && !PROTECTED_PROCESSES.includes(imageKey(w.processName)),
    );
    return hit ? { process: hit.processName, title: hit.title } : null;
  }

  async function parseCondition(
    text: string,
    ctx: SkillContext,
  ): Promise<
    { ok: true; condition: WatchCondition; sawProcess?: boolean } | { ok: false; error: string }
  > {
    const when = text
      .trim()
      .replace(/[.!]+$/, '')
      .replace(/^(?:when|once|after|as soon as|if)\s+/i, '')
      .trim();
    const lower = when.toLowerCase();

    // A length of time.
    const time =
      /^(?:in\s+|after\s+)?(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|h|m)(?:\s+(?:pass(?:es|ed)?|from now|have passed|is up|are up))?$/.exec(
        lower,
      );
    if (time) {
      const n = Number(time[1]);
      const unit = time[2]!;
      const seconds = Math.round(n * (/^h/.test(unit) ? 3600 : /^m/.test(unit) ? 60 : 1));
      if (seconds < 1 || seconds > 7 * 24 * 3600) {
        return { ok: false, error: 'I can watch for anything from a second up to a week.' };
      }
      return { ok: true, condition: { kind: 'after', seconds } };
    }

    // The network.
    if (
      /^(?:i'?m|i am|we'?re|we are|the (?:internet|wi-?fi|wifi|network|connection)(?: is)?|internet is|my (?:internet|wi-?fi|connection)(?: is)?)\s+(?:back(?:\s+(?:online|up|on))?|online|up|connected|working)(?:\s+again)?$/.test(
        lower,
      ) ||
      /^(?:the\s+)?(?:internet|wi-?fi|connection|network)\s+comes\s+back$/.test(lower)
    ) {
      return { ok: true, condition: { kind: 'online' } };
    }

    // A path appearing.
    const pathMatch = /^(.+?)\s+(?:exists|appears|is created|shows up|is there)$/i.exec(when);
    if (pathMatch && /^(?:[a-z]:[\\/]|\\\\)/i.test(pathMatch[1]!.replace(/^["']|["']$/g, ''))) {
      return {
        ok: true,
        condition: { kind: 'path-exists', path: pathMatch[1]!.replace(/^["']|["']$/g, '') },
      };
    }

    // Downloads.
    if (/\bdownload(?:s|ing|ed)?\b/.test(lower)) {
      if (!platform.knownFolder || !platform.listDir) {
        return { ok: false, error: 'I can’t see your Downloads folder in this build.' };
      }
      const folder = await platform.knownFolder('downloads');
      const partials = (await platform.listDir(folder, 500))
        .filter((e) => !e.isDirectory && isPartialDownload(e.name))
        .map((e) => e.name);
      if (!partials.length) {
        return {
          ok: false,
          error:
            'Nothing is downloading into your Downloads folder right now, so there’s nothing to wait for.',
        };
      }
      // "when Setup.exe finishes downloading" narrows to that one.
      const named = lower
        .replace(
          /\b(?:this|the|my|that|these|those|all|download(?:s|ing|ed)?|finish(?:es|ed)?|is|are|done|complete[sd]?|ends?|has|have|finishing)\b/g,
          ' ',
        )
        .trim();
      const wanted = named
        ? partials.filter((p) => stripPartial(p).toLowerCase().includes(named))
        : partials;
      return {
        ok: true,
        condition: {
          kind: 'downloads-finish',
          folder,
          partials: wanted.length ? wanted : partials,
        },
      };
    }

    const processes = (await platform.runningProcesses?.(2000).catch(() => [])) ?? [];
    const windows = (await platform.listWindows?.().catch(() => [])) ?? [];

    // "the build".
    if (/^(?:this|the|my|that)\s+(?:build|compile|compilation)\s+/.test(lower)) {
      const running = [
        ...new Set(
          processes.map((p) => imageKey(p.name)).filter((k) => BUILD_PROCESSES.includes(k)),
        ),
      ];
      if (!running.length) {
        return {
          ok: false,
          error: `I don’t see a build running (I looked for ${BUILD_PROCESSES.slice(0, 6).join(', ')} and a few more). Name the program instead — “when node.exe exits, …”.`,
        };
      }
      const pick =
        running.length === 1
          ? running[0]!
          : await chooseOne(ctx, 'Which build do you mean?', running);
      if (!pick)
        return { ok: false, error: 'Tell me which program is the build, and I’ll watch it.' };
      return {
        ok: true,
        condition: { kind: 'process-exits', name: `${pick}.exe`, label: 'The build' },
        sawProcess: true,
      };
    }

    // An app or process finishing.
    const exits =
      /^(.+?)\s+(?:finishes|is (?:done|finished|closed|complete)|closes|exits|quits|stops|ends|shuts down|crashes|completes|is no longer running|goes away)$/i.exec(
        when,
      );
    if (exits) {
      const target = exits[1]!.trim();
      if (THIS_THING.test(target)) {
        const front = await frontmostOther();
        if (!front)
          return {
            ok: false,
            error: 'I can’t tell which program you mean — name it, like “when OBS closes”.',
          };
        return {
          ok: true,
          condition: {
            kind: 'process-exits',
            name: front.process,
            label: front.title.slice(0, 60),
          },
          sawProcess: true,
        };
      }
      const match = matchRunningProcess(target, processes, windows);
      if (match.kind === 'none') {
        return {
          ok: false,
          error: `${capitalize(target)} isn’t running, so there’s nothing to wait for. If you mean when it starts, say “when ${target} starts”.`,
        };
      }
      const name =
        match.kind === 'one'
          ? match.name
          : await chooseOne(ctx, `Which one is ${target}?`, match.names);
      if (!name) return { ok: false, error: `Tell me which program is ${target}.` };
      return {
        ok: true,
        condition: { kind: 'process-exits', name, label: capitalize(target) },
        sawProcess: true,
      };
    }

    // An app starting.
    const starts =
      /^(.+?)\s+(?:starts|opens|launches|is (?:open|running|started|up)|comes up|loads|boots)$/i.exec(
        when,
      );
    if (starts) {
      const target = starts[1]!.trim();
      if (matchRunningProcess(target, processes, windows).kind !== 'none') {
        return { ok: false, error: `${capitalize(target)} is already running.` };
      }
      return {
        ok: true,
        condition: { kind: 'process-starts', name: target, label: capitalize(target) },
      };
    }

    return {
      ok: false,
      error: `I can watch for a program finishing or starting, a download, a file appearing, the internet coming back, or a length of time — I didn’t catch which “${when}” is.`,
    };
  }

  // ── understanding "then …" ───────────────────────────────────────────────

  async function askProjectFolder(ctx: SkillContext): Promise<string | null> {
    if (!ctx.clarify) return null;
    const answer = await ctx.clarify({
      question: 'Which project folder should those steps run in?',
      choices: [{ id: 'path', label: 'Project folder', input: { placeholder: 'D:\\Dev\\MyApp' } }],
    });
    if (answer.kind !== 'text') return null;
    const path = answer.text.trim().replace(/^["']|["']$/g, '');
    return path || null;
  }

  async function parseContinuation(
    text: string,
    ctx: SkillContext,
  ): Promise<{ ok: true; steps: PlanStep[]; labels: string[] } | { ok: false; error: string }> {
    const then = text
      .trim()
      .replace(/[.!]+$/, '')
      .replace(/^(?:then|and then|and)\s+/i, '')
      .replace(/^(?:continue|carry on|keep going)(?:\s+(?:with|and))?\s*/i, '')
      .trim();
    if (!then || /^(?:let me know|tell me|notify me|ping me)$/i.test(then)) {
      return { ok: true, steps: [], labels: [] };
    }

    const plan = await deps.planFor(then);
    if (!plan || !plan.steps.length) {
      return {
        ok: false,
        error: `I didn’t understand “${then}” as something I can do. Try something like “run the tests in D:\\Dev\\MyApp”.`,
      };
    }

    const blocked = plan.steps.find((s) => NOT_IN_A_CONTINUATION.has(s.skill));
    if (blocked) {
      const label = deps.skills.get(blocked.skill)?.label ?? blocked.skill;
      return {
        ok: false,
        error: `“${label}” can’t run on its own while you’re away — it decides its own next steps, or would power the PC off. Ask me for it when you’re here.`,
      };
    }

    // One project folder for every project step, asked once if none gave one.
    const raw = plan.steps.map((s) => ({ ...s, args: { ...s.args } }));
    const projectSteps = raw.filter((s) => PROJECT_STEPS.has(s.skill));
    if (projectSteps.length) {
      let folder = projectSteps
        .map((s) => s.args.path)
        .find((p) => typeof p === 'string' && p.trim()) as string | undefined;
      if (!folder) folder = (await askProjectFolder(ctx)) ?? undefined;
      if (!folder)
        return { ok: false, error: 'Those steps need a project folder — tell me which one.' };
      const info = await platform.detectProject?.(folder).catch(() => null);
      for (const s of projectSteps) {
        if (!s.args.path) s.args.path = folder;
        if ((s.skill === 'build.run' || s.skill === 'test.run') && !s.args.system) {
          const system = pickSystem(s.skill, info?.systems ?? []);
          if (!system) {
            return {
              ok: false,
              error: `I couldn’t tell how to ${s.skill === 'test.run' ? 'test' : 'build'} ${folder} — I don’t recognise a supported project there.`,
            };
          }
          s.args.system = system;
        }
        if (s.skill === 'build.run' && s.args.target === 'package') {
          const scripts = info?.npmScripts ?? [];
          const script = PACKAGE_SCRIPTS.find((n) => scripts.includes(n));
          if (!script || (s.args.system !== 'npm' && s.args.system !== 'pnpm')) {
            return {
              ok: false,
              error: `I can package a project that has a “package” or “dist” script in package.json; ${folder} doesn’t have one I recognise${scripts.length ? ` (its scripts: ${scripts.slice(0, 8).join(', ')})` : ''}.`,
            };
          }
          s.args.target = script;
        }
      }
    }

    const steps: PlanStep[] = [];
    const labels: string[] = [];
    for (const s of raw) {
      const check = deps.skills.validate(s.skill, s.args);
      if (!check.ok) return { ok: false, error: check.error };
      const skill = deps.skills.get(s.skill);
      if (skill?.guard) {
        const refusal = skill.guard(check.args);
        if (refusal) return { ok: false, error: refusal };
      }
      steps.push({ skill: s.skill, args: check.args });
      labels.push(stepLabel(skill ?? undefined, check.args));
    }
    return { ok: true, steps, labels };
  }

  async function resolveDraft(args: SkillArgs, ctx: SkillContext): Promise<Resolved> {
    const condition = await parseCondition(String(args.when ?? ''), ctx);
    if (!condition.ok) return condition;
    const continuation = await parseContinuation(String(args.then ?? ''), ctx);
    if (!continuation.ok) return continuation;
    const hours = typeof args.hours === 'number' && args.hours > 0 ? args.hours : undefined;
    return {
      ok: true,
      draft: {
        condition: condition.condition,
        sawProcess: condition.sawProcess,
        steps: continuation.steps,
        labels: continuation.labels,
        ttlMs: hours ? hours * 3600 * 1000 : undefined,
      },
    };
  }

  function cardFor(draft: Draft): string {
    const lines = [`When: ${describeCondition(draft.condition)}`];
    if (draft.steps.length) {
      lines.push('Then:');
      draft.labels.forEach((l, i) => lines.push(`  ${i + 1}. ${l}`));
      lines.push(
        '',
        'Approving now lets these steps run when it happens, even if you’re away. Anything that needs a fresh look first (like a list of files) will still stop and ask.',
      );
    }
    const hours = Math.round((draft.ttlMs ?? 24 * 3600 * 1000) / 3600_000);
    lines.push(
      `It lasts ${hours} hour${hours === 1 ? '' : 's'}, carries on if Atlas restarts, and you can pause or cancel it any time (“what are you watching?”).`,
    );
    return lines.join('\n');
  }

  // ── the skills ───────────────────────────────────────────────────────────

  const skills: Skill[] = [];

  skills.push({
    id: 'watch.create',
    label: 'Watch for something',
    icon: '👁',
    domain: 'watch',
    description:
      'Keep an eye on something — a program finishing or starting, a download, a file appearing, the internet coming back, or a length of time — then tell the person, and optionally run follow-up steps they approve now.',
    needs: ['processes', 'notifications'],
    risk: 'confirm',
    riskFor: (args) => (String(args.then ?? '').trim() ? 'confirm' : 'safe'),
    examples: [
      'watch this download',
      'let me know when OBS closes',
      'when the build finishes, run the tests in D:\\Dev\\MyApp',
      'in 20 minutes, open Spotify',
    ],
    params: {
      when: {
        type: 'string',
        required: true,
        description: 'what to wait for, e.g. "OBS closes", "this download finishes"',
      },
      then: {
        type: 'string',
        required: false,
        description: 'what to do once it happens, in plain words',
      },
      request: { type: 'string', required: false, description: 'the whole request as said' },
      hours: {
        type: 'number',
        required: false,
        description: 'how long to keep watching; defaults to 24',
      },
    },
    summarize: (args) => `watch for ${String(args.when ?? 'something')}`,
    async preview(args, ctx): Promise<SkillPreview> {
      const manager = need();
      if ('error' in manager) return { kind: 'refuse', error: manager.error };
      const resolved = await resolveDraft(args, ctx);
      if (!resolved.ok) return { kind: 'refuse', error: resolved.error };
      const fingerprint = `${fingerprintSteps(resolved.draft.steps)}|${JSON.stringify(resolved.draft.condition)}`;
      drafts.set(fingerprint, resolved.draft);
      return {
        kind: 'ask',
        question: resolved.draft.steps.length ? 'Set up this watch?' : 'Start watching?',
        detail: cardFor(resolved.draft),
        fingerprint,
      };
    },
    async run(args, ctx) {
      const manager = need();
      if ('error' in manager) return { ok: false, error: manager.error };
      let draft: Draft | undefined;
      if (ctx.approvedPreview) {
        draft = drafts.get(ctx.approvedPreview);
        drafts.delete(ctx.approvedPreview);
        if (!draft) return { ok: false, error: 'That approval expired — ask me again.' };
      } else {
        // No follow-up steps: nothing to approve, so nothing was previewed.
        const resolved = await resolveDraft(args, ctx);
        if (!resolved.ok) return { ok: false, error: resolved.error };
        if (resolved.draft.steps.length) {
          return { ok: false, error: 'Those follow-up steps need your approval first.' };
        }
        draft = resolved.draft;
      }
      const watch = await manager.create({
        request: String(args.request ?? '').trim() || `when ${String(args.when)}`,
        condition: draft.condition,
        steps: draft.steps,
        stepLabels: draft.labels,
        sawProcess: draft.sawProcess,
        ttlMs: draft.ttlMs,
      });
      const then = draft.steps.length
        ? ` Then I’ll ${draft.labels.map(lowerFirst).join(', then ')}.`
        : ' I’ll let you know.';
      return {
        ok: true,
        message: `👁 Watching until ${watch.describe}.${then}`,
        data: { id: watch.id },
      };
    },
  });

  skills.push({
    id: 'watch.list',
    label: 'Show what Atlas is watching',
    icon: '👁',
    domain: 'watch',
    description:
      'List the watches — active, paused, running, waiting for the person, and recently finished — with their progress.',
    risk: 'safe',
    examples: ['what are you watching', 'watch status'],
    params: {},
    run(_args, ctx) {
      const manager = need();
      if ('error' in manager) return { ok: false, error: manager.error };
      const watches = manager.list();
      if (!watches.length) {
        return {
          ok: true,
          message: 'I’m not watching anything. Try “let me know when this download finishes”.',
        };
      }
      const rows = watches.slice(0, 12).map(watchRow);
      const live = watches.filter((w) => !FINISHED_WATCH_STATUSES.includes(w.status)).length;
      ctx.showResults?.(rows, {
        title: live ? `Watching ${live} thing${live === 1 ? '' : 's'}` : 'Nothing active',
        subtitle: 'Pause, resume or cancel from here — or in Settings → Watches.',
      });
      return { ok: true, spoken: true, message: '', data: watches };
    },
  });

  const control = (
    id: 'watch.pause' | 'watch.resume' | 'watch.cancel',
    label: string,
    verb: string,
    applies: (w: Watch) => boolean,
    act: (m: WatchManager, id: string) => Promise<boolean>,
    examples: string[],
  ): Skill => ({
    id,
    label,
    icon: '👁',
    domain: 'watch',
    description: `${label}. "which" is a watch id, words from what it watches for, or "all".`,
    risk: 'safe',
    examples,
    params: {
      which: {
        type: 'string',
        required: false,
        description: 'which watch; defaults to the only one it could be',
      },
    },
    async run(args) {
      const manager = need();
      if ('error' in manager) return { ok: false, error: manager.error };
      const which = String(args.which ?? '')
        .trim()
        .toLowerCase();
      const candidates = manager.list().filter(applies);
      const chosen =
        which === 'all'
          ? candidates
          : which
            ? candidates.filter(
                (w) =>
                  w.id === which ||
                  w.describe.toLowerCase().includes(which) ||
                  w.request.toLowerCase().includes(which),
              )
            : candidates;
      if (!chosen.length)
        return {
          ok: false,
          error: `There’s no watch to ${verb}${which && which !== 'all' ? ` matching “${which}”` : ''}.`,
        };
      if (chosen.length > 1 && which !== 'all') {
        return {
          ok: false,
          error: `${chosen.length} watches could be meant: ${chosen.map((w) => `“${w.describe}”`).join(', ')}. Say which, or “all”.`,
        };
      }
      for (const w of chosen) await act(manager, w.id);
      return {
        ok: true,
        message:
          chosen.length === 1
            ? `${capitalize(pastTense(verb))}: ${chosen[0]!.describe}.`
            : `${capitalize(pastTense(verb))} ${chosen.length} watches.`,
      };
    },
  });

  skills.push(
    control(
      'watch.pause',
      'Pause a watch',
      'pause',
      (w) => w.status === 'active' || w.status === 'running',
      (m, id) => m.pause(id),
      ['pause the watch'],
    ),
    control(
      'watch.resume',
      'Resume a watch',
      'resume',
      (w) => w.status === 'paused',
      (m, id) => m.resume(id),
      ['resume the watch'],
    ),
    control(
      'watch.cancel',
      'Cancel a watch',
      'cancel',
      (w) => !FINISHED_WATCH_STATUSES.includes(w.status),
      (m, id) => m.cancel(id),
      ['stop watching', 'cancel all watches'],
    ),
  );

  skills.push({
    id: 'watch.answer',
    label: 'Answer a waiting watch',
    icon: '👁',
    domain: 'watch',
    description:
      'Answer a watch that stopped to ask: "approve" (go ahead / run it again), "skip" (treat that step as done), or "deny" (cancel the watch).',
    risk: 'safe',
    params: {
      id: { type: 'string', required: true, description: 'the watch id' },
      answer: {
        type: 'string',
        required: true,
        enum: ['approve', 'skip', 'deny'],
        description: 'the answer',
      },
    },
    async run(args) {
      const manager = need();
      if ('error' in manager) return { ok: false, error: manager.error };
      const ok = await manager.answer(
        String(args.id),
        String(args.answer) as 'approve' | 'skip' | 'deny',
      );
      return ok
        ? {
            ok: true,
            message: args.answer === 'deny' ? 'Cancelled that watch.' : 'Okay — carrying on.',
          }
        : { ok: false, error: 'That watch isn’t waiting for an answer any more.' };
    },
  });

  return skills;
}

// ── helpers ────────────────────────────────────────────────────────────────

const STATUS_WORDS: Record<Watch['status'], string> = {
  active: 'Watching',
  paused: 'Paused',
  running: 'Running its steps',
  'awaiting-approval': 'Waiting for you',
  done: 'Done',
  failed: 'Stopped',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

const STATUS_ICONS: Record<Watch['status'], string> = {
  active: '👁',
  paused: '⏸',
  running: '⚙️',
  'awaiting-approval': '✋',
  done: '✅',
  failed: '⚠️',
  expired: '⌛',
  cancelled: '✖️',
};

export function watchRow(w: Watch): ResultRow {
  const done = w.stepStates.filter((s) => s === 'done' || s === 'skipped').length;
  const progress = w.steps.length ? ` · steps ${done}/${w.steps.length}` : '';
  const last = w.question?.question ?? w.log[w.log.length - 1]?.text ?? '';
  const actions: NonNullable<ResultRow['actions']> = [];
  if (w.status === 'awaiting-approval') {
    actions.push({
      label: w.question?.kind === 'uncertain-step' ? 'Run it again' : 'Approve',
      skill: 'watch.answer',
      args: { id: w.id, answer: 'approve' },
    });
    if (w.question?.step !== undefined) {
      actions.push({
        label: w.question.kind === 'uncertain-step' ? 'It already happened' : 'Skip step',
        skill: 'watch.answer',
        args: { id: w.id, answer: 'skip' },
      });
    }
    actions.push({ label: 'Cancel', skill: 'watch.answer', args: { id: w.id, answer: 'deny' } });
  } else if (w.status === 'active' || w.status === 'running') {
    actions.push({ label: 'Pause', skill: 'watch.pause', args: { which: w.id } });
    actions.push({ label: 'Cancel', skill: 'watch.cancel', args: { which: w.id } });
  } else if (w.status === 'paused') {
    actions.push({ label: 'Resume', skill: 'watch.resume', args: { which: w.id } });
    actions.push({ label: 'Cancel', skill: 'watch.cancel', args: { which: w.id } });
  }
  return {
    title: capitalize(w.describe),
    subtitle: `${STATUS_WORDS[w.status]}${progress}${last ? ` — ${last}` : ''}`,
    icon: STATUS_ICONS[w.status],
    payload: w,
    actions,
  };
}

function pickSystem(skill: string, systems: readonly string[]): string | null {
  const allowed =
    skill === 'test.run'
      ? ['pnpm', 'npm', 'cargo', 'dotnet', 'cmake', 'pytest']
      : ['pnpm', 'npm', 'cargo', 'dotnet', 'cmake', 'make'];
  return allowed.find((s) => systems.includes(s as never)) ?? null;
}

function stepLabel(skill: Skill | undefined, args: SkillArgs): string {
  if (!skill) return 'an unknown step';
  const said = skill.summarize?.(args)?.trim();
  if (said) return capitalize(said);
  const where = typeof args.path === 'string' ? ` — ${args.path}` : '';
  const what =
    skill.id === 'build.run' && args.target
      ? ` (${String(args.target)})`
      : skill.id === 'app.open' && args.name
        ? ` ${String(args.name)}`
        : '';
  return `${skill.label}${what}${where}`;
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function lowerFirst(s: string): string {
  return s ? s[0]!.toLowerCase() + s.slice(1) : s;
}

function pastTense(verb: string): string {
  return verb === 'pause'
    ? 'paused'
    : verb === 'resume'
      ? 'resumed'
      : verb === 'cancel'
        ? 'cancelled'
        : `${verb}ed`;
}
