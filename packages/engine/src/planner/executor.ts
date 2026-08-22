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
 *  4. A plan the content policy refuses never starts — it is not announced,
 *     not confirmed, and no step of it runs. See `safety/content-policy.ts`.
 */

import type { Plan, PlanOutcome, SkillContext, StepOutcome } from '@atlas/core';
import type { SkillRegistry } from '../skills/registry';
import { createPhrasing, type Phrasing } from '../phrasing';
import { refusalFor, screenPlan } from '../safety/content-policy';

export interface ExecutorOptions {
  /** Set false to run every step regardless of failures. */
  stopOnError?: boolean;
}

export class Executor {
  private readonly phrasing: Phrasing;

  constructor(
    private readonly skills: SkillRegistry,
    phrasing: Phrasing = createPhrasing(),
  ) {
    this.phrasing = phrasing;
  }

  async run(plan: Plan, ctx: SkillContext, options: ExecutorOptions = {}): Promise<PlanOutcome> {
    const stopOnError = options.stopOnError !== false;
    const outcomes: StepOutcome[] = [];

    if (!plan.steps.length) {
      return { ok: false, ran: 0, outcomes, aborted: false };
    }

    // Content policy, before anything is said or shown. The registry would
    // refuse these arguments anyway, but only once the step was already
    // running — by which point the plan has announced itself and, for a
    // `confirm` skill, put a card on screen offering to do the thing. A plan
    // is refused whole, matching rule 3 above: nothing after a refusal runs.
    const screened = screenPlan(plan.steps, (id) => this.skills.get(id));
    if (!screened.allowed) {
      ctx.say(refusalFor(screened.reason));
      return {
        ok: false,
        ran: 0,
        outcomes: plan.steps.map((s) => ({
          skill: s.skill,
          ok: false,
          skipped: true,
          error: 'Refused.',
        })),
        aborted: true,
      };
    }

    // A multi-step plan says what it's about to do first, so the user can stop
    // it before it starts rather than watching it happen.
    if (plan.steps.length > 1) {
      const names = plan.steps.map((s) => this.skills.get(s.skill)?.label.toLowerCase() ?? s.skill);
      ctx.say(this.phrasing.rightThen(names));
    }

    let aborted = false;

    for (const step of plan.steps) {
      if (aborted) break;

      const skill = this.skills.get(step.skill);
      if (!skill) {
        outcomes.push({
          skill: step.skill,
          ok: false,
          error: `I don't have an action called “${step.skill}”.`,
        });
        if (stopOnError) aborted = true;
        continue;
      }

      if (step.say) ctx.say(step.say);

      // Refused outright, before anything is drawn. The registry checks this
      // too and that check is the guarantee; this one exists so that a card
      // never appears in front of an action that would then be declined —
      // which is how people are trained to click through the cards that
      // matter.
      const refusal = skill.guard?.(step.args) ?? null;
      if (refusal) {
        outcomes.push({ skill: step.skill, ok: false, error: refusal });
        ctx.say(refusal);
        aborted = true;
        break;
      }

      if (skill.risk === 'confirm') {
        const detail = Object.values(step.args)
          .filter((v) => v !== undefined && v !== null && v !== '')
          .map(String)
          .join(' · ');

        const approved = await ctx.confirm(`${skill.label}?`, detail || undefined);
        if (!approved) {
          outcomes.push({ skill: step.skill, ok: false, skipped: true, error: 'Cancelled.' });
          ctx.say(this.phrasing.declined());
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
        if (result.message && !result.spoken) {
          // `aloud` rides through to the surface, which is the only layer that
          // can actually keep quiet about it.
          // The skill's declaration is the default; a single result may
          // override it.
          ctx.say(result.message, { aloud: result.aloud ?? skill.aloud });
        }
      } else {
        ctx.say(this.phrasing.failed(result.error ?? "That didn't work."));
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
