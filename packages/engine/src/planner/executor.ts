/**
 * The executor — runs a plan, and is where the safety model actually bites.
 *
 * Three rules, each learned from the way this goes wrong otherwise:
 *
 *  1. A `confirm` step stops and asks. One approval covers one step, never the
 *     session — "yes" to opening a file is not standing consent to open files.
 *  2. A failed step aborts the rest by default. In a two-step plan whose first
 *     step didn't find the file, running the second against nothing is worse
 *     than stopping.
 *  3. A declined step always ends the plan. Carrying on with the remainder
 *     after the user said no is the single most alarming thing an agent can do.
 */

import type { Plan, PlanOutcome, SkillContext, StepOutcome } from '@atlas/core';
import type { SkillRegistry } from '../skills/registry';

export interface ExecutorOptions {
  /** Set false to run every step regardless of failures. */
  stopOnError?: boolean;
}

export class Executor {
  constructor(private readonly skills: SkillRegistry) {}

  async run(plan: Plan, ctx: SkillContext, options: ExecutorOptions = {}): Promise<PlanOutcome> {
    const stopOnError = options.stopOnError !== false;
    const outcomes: StepOutcome[] = [];

    if (!plan.steps.length) {
      return { ok: false, ran: 0, outcomes, aborted: false };
    }

    // A multi-step plan says what it's about to do first, so the user can stop
    // it before it starts rather than watching it happen.
    if (plan.steps.length > 1) {
      const names = plan.steps.map((s) => this.skills.get(s.skill)?.label.toLowerCase() ?? s.skill);
      const last = names.pop();
      ctx.say(`Right — ${names.length ? `${names.join(', ')}, then ${last}` : last}.`);
    }

    let aborted = false;

    for (const step of plan.steps) {
      if (aborted) break;

      const skill = this.skills.get(step.skill);
      if (!skill) {
        outcomes.push({ skill: step.skill, ok: false, error: `I don't have an action called “${step.skill}”.` });
        if (stopOnError) aborted = true;
        continue;
      }

      if (step.say) ctx.say(step.say);

      if (skill.risk === 'confirm') {
        const detail = Object.values(step.args)
          .filter((v) => v !== undefined && v !== null && v !== '')
          .map(String)
          .join(' · ');

        const approved = await ctx.confirm(`${skill.label}?`, detail || undefined);
        if (!approved) {
          outcomes.push({ skill: step.skill, ok: false, skipped: true, error: 'Cancelled.' });
          ctx.say('Okay — left alone.');
          aborted = true;
          break;
        }
      }

      const result = await this.skills.invoke(step.skill, step.args, ctx);
      outcomes.push({
        skill: step.skill,
        ok: result.ok,
        message: result.message,
        error: result.error,
      });

      if (result.ok) {
        // Quiet when the skill rendered its own output, so the transcript
        // never says the same thing twice.
        if (result.message && !result.spoken) ctx.say(result.message);
      } else {
        ctx.say(`⚠️ ${result.error ?? "That didn't work."}`);
        if (stopOnError) aborted = true;
      }
    }

    const ran = outcomes.filter((o) => o.ok).length;
    return {
      ok: ran > 0 && outcomes.every((o) => o.ok),
      ran,
      outcomes,
      aborted,
    };
  }
}
