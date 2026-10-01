/**
 * Creating, listing and cancelling routines.
 *
 * `routine.create` takes the schedule as words ("every night at 2am") and what
 * to do as a sentence ("open spotify"), understands the sentence the same way
 * any request is understood, and then **refuses anything that could need asking
 * at 2am**: only steps that are safe whatever their arguments, and not on the
 * unattended-never list. What survives is shown on a card as the exact steps,
 * and only a yes makes the routine.
 */

import type { Plan, PlanStep, Skill } from '@atlas/core';
import { describeMoment, parseWhen, type Repeat } from '../text/when';
import type { RoutineScheduler } from '../routines/scheduler';
import type { SkillRegistry } from './registry';

/** Never unattended, however safe they look: ending the session, or arranging to. */
const NEVER_UNATTENDED = new Set([
  'devagent.run',
  'uiagent.run',
  'watch.create',
  'watch.cancel',
  'routine.create',
  'routine.cancel',
  'system.power',
  'system.sleep',
  'system.shutdownIn',
  'service.start',
  'service.stop',
  'service.restart',
  'environment.setSystem',
  'environment.deleteSystem',
  // Typing and clicking into whatever is in front of nobody.
  'input.typeText',
  'input.click',
  'input.drag',
  'input.hotkey',
  'input.pressKey',
  'input.holdKey',
  'input.scroll',
  'input.moveMouse',
  'uia.invoke',
  'uia.setValue',
  'uia.typeInto',
  'kbm.drag',
  'kbm.hotkey',
  'kbm.scroll',
]);

const REPEAT_WORDS: Record<Repeat, string> = { daily: 'every day', weekdays: 'every weekday', weekly: 'every week' };

export interface RoutineSkillDeps {
  scheduler: RoutineScheduler;
  skills: SkillRegistry;
  /** Understand a sentence without running it — `Engine.planFor`. */
  planFor: (text: string) => Promise<Plan | null>;
  now?: () => Date;
}

function describeStep(skills: SkillRegistry, step: PlanStep): string {
  const skill = skills.get(step.skill);
  const args = Object.entries(step.args ?? {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([, v]) => String(v))
    .join(' · ');
  return `${skill?.label ?? step.skill}${args ? ` — ${args}` : ''}`;
}

export function createRoutineSkills(deps: RoutineSkillDeps): Skill[] {
  const { scheduler, skills } = deps;
  const now = deps.now ?? (() => new Date());
  const out: Skill[] = [];

  out.push({
    id: 'routine.create',
    label: 'Make a routine',
    icon: '🔁',
    domain: 'time',
    description:
      'Do something on a schedule — "every day at 8, open spotify". You approve the exact steps once. Only things that never need asking are allowed; if one does, the routine stops and tells you.',
    risk: 'safe',
    examples: ['every day at 8 open spotify'],
    params: {
      when: { type: 'string', required: true, description: 'a repeating time: "every day at 8", "every weekday at 9am", "every monday at 7"' },
      then: { type: 'string', required: true, description: 'what to do, as a sentence' },
    },
    async run(args, ctx) {
      const when = parseWhen(String(args.when ?? ''), now());
      if (!when?.repeat) {
        return { ok: false, error: 'A routine repeats. Try "every day at 8", "every weekday at 9am" or "every monday at 7".' };
      }
      const sentence = String(args.then ?? '').trim();
      if (!sentence) return { ok: false, error: 'What should it do?' };
      const plan = await deps.planFor(sentence);
      if (!plan?.steps.length) return { ok: false, error: `I couldn't turn "${sentence}" into something I can do.` };

      // Everything here must be fine to run with nobody there.
      for (const step of plan.steps) {
        const skill = skills.get(step.skill);
        if (!skill) return { ok: false, error: `I don't know how to do "${step.skill}".` };
        if (NEVER_UNATTENDED.has(step.skill)) {
          return { ok: false, error: `A routine can't ${skill.label.toLowerCase()} — that isn't something to do with nobody watching.` };
        }
        const risk = skill.riskFor?.(step.args) ?? skill.risk;
        if (risk !== 'safe') {
          return {
            ok: false,
            error: `A routine can only run things that never need asking, and "${skill.label}" does. Do that one yourself, or ask me when you want it.`,
          };
        }
      }
      const labels = plan.steps.map((s) => describeStep(skills, s));
      const first = describeMoment(when.at, now());
      const approved = await ctx.confirm(
        `🔁 Make this routine?`,
        `${REPEAT_WORDS[when.repeat]}, starting ${first}, Atlas will, without asking again:\n${labels.map((l, i) => `${i + 1}. ${l}`).join('\n')}\n\nIt stops if anything wants to ask you, and the emergency stop pauses it.`,
      );
      if (!approved) return { ok: false, error: 'Okay — I haven\'t made it.' };

      const r = await scheduler.add({ request: sentence, steps: plan.steps, labels, at: when.at, repeat: when.repeat });
      if ('error' in r) return { ok: false, error: r.error };
      return { ok: true, message: `🔁 Routine set: ${REPEAT_WORDS[when.repeat]} (next ${first}) — ${labels.join(', ')}.`, data: r };
    },
  });

  out.push({
    id: 'routine.list',
    label: 'My routines',
    icon: '🔁',
    domain: 'time',
    description: 'List the routines that are set, when each runs next, and how the last run went.',
    risk: 'safe',
    examples: ['what are my scheduled routines'],
    params: {},
    async run() {
      const items = await scheduler.list();
      if (!items.length) return { ok: true, message: 'You have no routines set.' };
      const lines = items.map(
        (r) =>
          `${r.enabled ? '🔁' : '⏸️'} ${REPEAT_WORDS[r.repeat]} — ${r.labels.join(', ')} · next ${r.enabled ? describeMoment(r.at, now()) : 'paused'}${r.lastNote ? ` · last: ${r.lastNote}` : ''}`,
      );
      return { ok: true, message: lines.join('\n'), data: items };
    },
  });

  out.push({
    id: 'routine.cancel',
    label: 'Cancel a routine',
    icon: '🛑',
    domain: 'time',
    description: 'Cancel a routine by a word from it, or all of them.',
    risk: 'safe',
    examples: ['cancel my spotify scheduled routine', 'cancel all scheduled routines'],
    params: { which: { type: 'string', required: true, description: 'a word from the routine, or "all"' } },
    async run(args) {
      const r = await scheduler.cancel(String(args.which ?? ''));
      if ('error' in r) return { ok: false, error: r.error };
      return { ok: true, message: r.removed.length === 1 ? `🛑 Cancelled: ${r.removed[0]!.labels.join(', ')}` : `🛑 Cancelled ${r.removed.length} routines.` };
    },
  });

  out.push({
    id: 'routine.resume',
    label: 'Resume my routines',
    icon: '▶️',
    domain: 'time',
    description: 'Turn routines back on after the emergency stop paused them. They pick up at their next slot, not the ones missed.',
    risk: 'safe',
    examples: ['resume my scheduled routines'],
    params: {},
    async run() {
      const n = await scheduler.setEnabled(true);
      return { ok: true, message: n ? `▶️ Resumed ${n} routine${n === 1 ? '' : 's'}.` : 'None of your routines were paused.' };
    },
  });

  return out;
}
