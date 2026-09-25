/**
 * Setups — "get my PC ready for recording" — as skills.
 *
 * A setup is a named, saved list of things to open, close, arrange and check
 * (`SetupItem`). `setup.run` is the whole feature from the person's side:
 *
 *  - **Known setup** → read the machine, work out what would change *now*
 *    (OBS already open? Chrome running?), and ask only if something will
 *    close. Then act, check each thing actually worked, and report what was
 *    found (see `setup/runner.ts`).
 *  - **Unknown setup** → ask what "ready for streaming" means, a few short
 *    questions with the real answers offered (your actual default mic, your
 *    actual drives), then show the whole thing on one card: save and run?
 *  - **Inline** — "get my PC ready for streaming: open OBS, close Chrome" —
 *    skips the questions; anything it can't read is said back, not guessed.
 *
 * Never asks a question it could answer itself, and never guesses one it
 * can't: a vague "get my PC ready" with nothing saved asks "ready for what?".
 */

import type {
  ClarifyNeed,
  ExecutionMode,
  Platform,
  ResultRow,
  Setup,
  SetupItem,
  Skill,
  SkillContext,
  SkillPreview,
} from '@atlas/core';
import type { SkillRegistry } from './registry';
import { Executor } from '../planner/executor';
import { createPhrasing, type Phrasing } from '../phrasing';
import type { SetupStore } from '../setup/store';
import { describeItem, parseSpec, setupKey, splitNames } from '../setup/spec';
import {
  planCard,
  planFingerprint,
  planSetup,
  readState,
  runSetup,
  type SetupRunDeps,
} from '../setup/runner';

export interface SetupSkillDeps {
  platform: Platform;
  skills: SkillRegistry;
  store: SetupStore;
  getExecutionMode: () => ExecutionMode;
  phrasing?: Phrasing;
  /** Test seam: timings for the runner. */
  runner?: Partial<Omit<SetupRunDeps, 'platform' | 'runStep'>>;
}

interface Draft {
  setup: Setup;
  isNew: boolean;
}

type Guided = { ok: true; items: SetupItem[] } | { ok: false; error: string; cancelled?: boolean };

export function createSetupSkills(deps: SetupSkillDeps): Skill[] {
  const { platform, store } = deps;
  const executor = new Executor(deps.skills, deps.phrasing ?? createPhrasing());
  const drafts = new Map<string, Draft>();

  const runnerDeps: SetupRunDeps = {
    ...deps.runner,
    platform,
    runStep: async (step, ctx) => {
      // Quietly: the setup reports once, at the end, from what it checked.
      const quiet: SkillContext = { ...ctx, say: () => {} };
      const outcome = await executor.run(
        { source: 'routine', intent: 'setup-step', steps: [step], confidence: 1 },
        quiet,
        { mode: deps.getExecutionMode(), signal: ctx.signal },
      );
      return outcome.outcomes[0];
    },
  };

  // ── the guided questions ─────────────────────────────────────────────────

  async function guided(name: string, ctx: SkillContext): Promise<Guided> {
    if (!ctx.clarify) {
      return {
        ok: false,
        error: `I need to ask a couple of questions to set up “ready for ${name}”. Or tell me in one go: “get my PC ready for ${name}: open OBS, close Chrome, check my mic”.`,
      };
    }
    const items: SetupItem[] = [];
    const cancelled = { ok: false as const, error: 'Okay — nothing saved.', cancelled: true };

    // 1. Open.
    const opens = await ctx.clarify({
      question: `What should be open when you’re ready for ${name}?`,
      choices: [
        { id: 'apps', label: 'These apps', input: { placeholder: 'OBS, Discord', many: true } },
        { id: 'none', label: 'Nothing to open' },
      ],
    });
    if (opens.kind === 'cancelled') return cancelled;
    if (opens.kind === 'text')
      for (const app of splitNames(opens.text)) items.push({ kind: 'open', app });

    // 2. Close.
    const closes = await ctx.clarify({
      question: 'Anything I should close first?',
      choices: [
        { id: 'apps', label: 'Close these', input: { placeholder: 'Chrome, Steam', many: true } },
        { id: 'none', label: 'Nothing' },
      ],
    });
    if (closes.kind === 'cancelled') return cancelled;
    if (closes.kind === 'text')
      for (const app of splitNames(closes.text)) items.push({ kind: 'close', app });

    // 3. Microphone — offering the one that's actually selected.
    const audio = await platform.audioDevices?.().catch(() => null);
    if (platform.audioDevices) {
      const mic = await ctx.clarify({
        question: 'Should I check your microphone?',
        choices: [
          ...(audio?.input ? [{ id: 'expect', label: `Yes — it should be ${audio.input}` }] : []),
          { id: 'report', label: 'Yes, just tell me which one is on' },
          { id: 'no', label: 'No' },
        ],
      });
      if (mic.kind === 'cancelled') return cancelled;
      if (mic.kind === 'choice' && mic.id === 'expect' && audio?.input)
        items.push({ kind: 'mic', expect: audio.input });
      if (mic.kind === 'choice' && mic.id === 'report') items.push({ kind: 'mic' });
    }

    // 4. Space — offering the drives that actually exist.
    const info = await platform.systemInfo?.().catch(() => null);
    const disks = (info?.disks ?? [])
      .map((d) => ({
        letter: d.mount.slice(0, 2).toUpperCase(),
        free: Math.floor((d.totalBytes - d.usedBytes) / 1024 ** 3),
      }))
      .filter((d) => /^[A-Z]:$/.test(d.letter))
      .slice(0, 4);
    if (disks.length) {
      const space = await ctx.clarify({
        question: `Make sure there’s room for ${name}? I’ll check for at least 20 GB free.`,
        choices: [
          ...disks.map((d) => ({
            id: `d:${d.letter}`,
            label: `On ${d.letter} — ${d.free} GB free now`,
          })),
          { id: 'no', label: 'No' },
        ],
      });
      if (space.kind === 'cancelled') return cancelled;
      if (space.kind === 'choice' && space.id.startsWith('d:')) {
        items.push({ kind: 'storage', drive: space.id.slice(2), minGb: 20 });
      }
    }

    // 5. Windows.
    const arrange = await ctx.clarify({
      question: 'Put any windows somewhere in particular?',
      choices: [
        {
          id: 'place',
          label: 'Yes',
          input: { placeholder: 'Discord on the left, OBS on the right' },
        },
        { id: 'no', label: 'No' },
      ],
    });
    if (arrange.kind === 'cancelled') return cancelled;
    if (arrange.kind === 'text') {
      const parsed = parseSpec(arrange.text);
      items.push(...parsed.items.filter((i) => i.kind === 'place'));
    }

    if (!items.length) {
      return {
        ok: false,
        error: `That leaves nothing for “ready for ${name}” to do — tell me at least one thing it should mean.`,
      };
    }
    return { ok: true, items };
  }

  // ── setup.run ────────────────────────────────────────────────────────────

  const skills: Skill[] = [];

  skills.push({
    id: 'setup.run',
    label: 'Get the PC ready for something',
    icon: '🎬',
    domain: 'setup',
    description:
      'Get the PC ready for an activity — recording, streaming, work — using a saved setup: close apps, open apps and wait for them, arrange windows, check the microphone, free space and internet, then report what was actually verified. The first time a setup is named, asks what it should mean and saves it. "spec" may give it inline: "open OBS, close Chrome, put Discord on the left, check my mic".',
    needs: ['apps', 'processes', 'window-control'],
    risk: 'confirm',
    examples: [
      'get my pc ready for recording',
      'get ready to stream',
      'run my work setup',
      'get my pc ready for streaming: open OBS and Discord, close Chrome, check my mic',
    ],
    params: {
      name: {
        type: 'string',
        required: true,
        description: 'what to get ready for, e.g. "recording"',
      },
      spec: {
        type: 'string',
        required: false,
        description: 'what the setup should do, in plain words (optional)',
      },
    },
    clarify(args): ClarifyNeed | null {
      if (String(args.name ?? '').trim()) return null;
      const names = store.names();
      return {
        param: 'name',
        noun: 'setup',
        question: 'Ready for what?',
        options: names.slice(0, 5).map((n) => ({ value: n, label: capitalize(n) })),
        tellLabel: names.length ? 'Something else' : 'Tell me',
        placeholder: 'recording',
      };
    },
    summarize: (args) => `get ready for ${setupKey(String(args.name ?? 'it'))}`,
    async preview(args, ctx): Promise<SkillPreview> {
      await store.load();
      const name = setupKey(String(args.name ?? ''));
      if (!name) return { kind: 'refuse', error: 'Tell me what to get ready for.' };
      const existing = store.get(name);
      const spec = String(args.spec ?? '').trim();

      let setup: Setup;
      let isNew = false;
      if (spec) {
        const parsed = parseSpec(spec);
        if (parsed.unknown.length) {
          return {
            kind: 'refuse',
            error: `I didn’t understand ${parsed.unknown.map((u) => `“${u}”`).join(', ')}. A setup can open, close and arrange apps, and check your mic, free space and internet.`,
          };
        }
        if (!parsed.items.length)
          return { kind: 'refuse', error: 'That setup doesn’t say to do anything yet.' };
        setup = { name, items: parsed.items, createdAt: Date.now(), updatedAt: Date.now() };
        isNew = true;
      } else if (existing) {
        setup = existing;
      } else {
        const asked = await guided(name, ctx);
        if (!asked.ok)
          return asked.cancelled
            ? { kind: 'nothing', message: asked.error }
            : { kind: 'refuse', error: asked.error };
        setup = { name, items: asked.items, createdAt: Date.now(), updatedAt: Date.now() };
        isNew = true;
      }

      const plan = planSetup(setup, await readState(platform));
      const fingerprint = planFingerprint(setup, plan);
      drafts.set(fingerprint, { setup, isNew });
      if (!isNew && !plan.toClose.length) return { kind: 'proceed', fingerprint };
      return {
        kind: 'ask',
        question: isNew ? `Save and run your ${name} setup?` : `Get ready for ${name}?`,
        detail: planCard(setup, plan, isNew),
        fingerprint,
      };
    },
    async run(_args, ctx) {
      const draft = ctx.approvedPreview ? drafts.get(ctx.approvedPreview) : undefined;
      if (!draft) return { ok: false, error: 'That approval expired — ask me again.' };
      drafts.delete(ctx.approvedPreview!);

      // What would close has to be what the card said would close.
      const plan = planSetup(draft.setup, await readState(platform));
      if (planFingerprint(draft.setup, plan) !== ctx.approvedPreview) {
        return {
          ok: false,
          error:
            'Something changed since I looked (an app opened or closed) — ask me again and I’ll show you the new list.',
        };
      }
      const setup = draft.isNew
        ? await store.save(draft.setup.name, draft.setup.items)
        : draft.setup;
      const outcome = await runSetup(setup, runnerDeps, ctx);
      await store.recordRun(setup.name, outcome.report);
      const saved = draft.isNew
        ? `Saved — say “get ready for ${setup.name}” next time, or change it in Settings → Setups.`
        : '';
      const data = { allReady: outcome.ok, checks: outcome.checks };

      // A checklist, one verified line per item, where a surface can draw one:
      // a paragraph hides the one ⚠️ that matters in the middle of the ✅s.
      if (ctx.showResults && outcome.checks.length) {
        const title = capitalize(setup.name);
        const good = outcome.checks.filter((c) => c.ok).length;
        ctx.showResults(
          outcome.checks.map((c) => ({
            title: capitalize(c.observed),
            subtitle: describeItem(c.item),
            icon: c.ok ? (c.skipped ? '➖' : '✅') : '⚠️',
          })),
          {
            title: outcome.ok
              ? `${title} setup complete`
              : `${title} setup: ${good} of ${outcome.checks.length} ready`,
            subtitle: saved || 'Each line was checked after acting, not assumed.',
          },
        );
        return { ok: true, spoken: true, message: '', data };
      }
      return {
        ok: true,
        message: saved ? `${outcome.report}\n\n${saved}` : outcome.report,
        data,
      };
    },
  });

  skills.push({
    id: 'setup.save',
    label: 'Save a setup',
    icon: '🎬',
    domain: 'setup',
    description:
      'Save (or replace) a named setup from plain words, without running it: "open OBS and Discord, close Chrome, put Discord on the left, check my mic, 50 GB on D:".',
    risk: 'safe',
    examples: ['save my streaming setup as open OBS, close Chrome and check my mic'],
    params: {
      name: { type: 'string', required: true, description: 'the setup’s name' },
      spec: { type: 'string', required: true, description: 'what it should do' },
    },
    async run(args) {
      const parsed = parseSpec(String(args.spec));
      if (parsed.unknown.length) {
        return {
          ok: false,
          error: `I didn’t understand ${parsed.unknown.map((u) => `“${u}”`).join(', ')}.`,
        };
      }
      if (!parsed.items.length) return { ok: false, error: 'That doesn’t say to do anything yet.' };
      const setup = await store.save(String(args.name), parsed.items);
      return {
        ok: true,
        message: `Saved your ${setup.name} setup: ${setup.items.map(describeItem).map(lowerFirst).join('; ')}.`,
      };
    },
  });

  skills.push({
    id: 'setup.list',
    label: 'Show saved setups',
    icon: '🎬',
    domain: 'setup',
    description: 'List the saved setups and what each one does.',
    risk: 'safe',
    examples: ['show my setups'],
    params: {},
    async run(_args, ctx) {
      await store.load();
      const setups = store.all();
      if (!setups.length) {
        return {
          ok: true,
          message:
            'No setups yet. Try “get my PC ready for recording” and I’ll ask what that means.',
        };
      }
      ctx.showResults?.(setups.map(setupRow), {
        title: `${setups.length} setup${setups.length === 1 ? '' : 's'}`,
        subtitle: 'Run one here, or edit them in Settings → Setups.',
      });
      return { ok: true, spoken: true, message: '' };
    },
  });

  skills.push({
    id: 'setup.delete',
    label: 'Delete a setup',
    icon: '🎬',
    domain: 'setup',
    description: 'Delete a saved setup.',
    risk: 'confirm',
    examples: ['delete my streaming setup'],
    params: { name: { type: 'string', required: true, description: 'which setup' } },
    summarize: (args) => `delete the ${setupKey(String(args.name ?? ''))} setup`,
    async run(args) {
      await store.load();
      const setup = store.get(String(args.name));
      if (!setup) return { ok: false, error: `There’s no ${setupKey(String(args.name))} setup.` };
      await store.remove(setup.name);
      return { ok: true, message: `Deleted your ${setup.name} setup.` };
    },
  });

  return skills;
}

function setupRow(s: Setup): ResultRow {
  return {
    title: capitalize(s.name),
    subtitle: s.items.map(describeItem).join(' · '),
    icon: '🎬',
    payload: s,
    actions: [
      { label: 'Run', skill: 'setup.run', args: { name: s.name } },
      { label: 'Delete', skill: 'setup.delete', args: { name: s.name } },
    ],
  };
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function lowerFirst(s: string): string {
  return s ? s[0]!.toLowerCase() + s.slice(1) : s;
}
