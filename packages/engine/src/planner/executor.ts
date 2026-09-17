/**
 * The executor — runs a plan, and is where the safety model actually bites.
 *
 * Four rules, each learned from the way this goes wrong otherwise:
 *
 *  1. A `confirm` step stops and asks. One approval covers one step, never the
 *     session — "yes" to opening a file is not standing consent to open files.
 *     `planFirst` is the one deliberate exception: there, one approval can
 *     cover every step of a plan the user was just shown in full — still
 *     bounded and still explicit, just scoped to the plan rather than the
 *     step. See "Execution mode" below.
 *  2. A failed step aborts the rest by default. In a two-step plan whose first
 *     step didn't find the file, running the second against nothing is worse
 *     than stopping.
 *  3. A declined step always ends the plan. Carrying on with the remainder
 *     after the user said no is the single most alarming thing an agent can do.
 *  4. A plan the content policy refuses never starts — it is not announced,
 *     not confirmed, and no step of it runs. See `safety/content-policy.ts`.
 *
 * ── Execution mode ───────────────────────────────────────────────────────────
 * `ExecutionMode` (see `@atlas/core`) decides *when* a confirm step's question
 * is put to the user, never *whether* — that is still `Skill.risk` (and, for
 * the rare skill whose consequence depends on which call it was, `riskFor`)
 * alone. `effectiveRisk()` below is the one place that pair is read, so the
 * plan-wide scan, the plan-approval labels and the per-step gate can never
 * disagree about which steps count as consequential.
 *
 * `doIt` and `confirmActions` run the identical per-step loop: a safe step
 * runs, a confirm step asks right there, immediately before it runs. They are
 * named separately because `confirmActions` is the guarantee that this stays
 * true even once something else (like `planFirst`) exists that could batch
 * approvals — picking it means "never batch mine."
 *
 * `planFirst` only changes anything when the plan actually contains a confirm
 * step: it shows every step once, up front, and one approval covers the whole
 * plan — the individual `ctx.confirm` below is then skipped for steps that
 * were already named in it. A plan of only safe steps never shows this card;
 * matching every other mode, harmless things stay silent.
 *
 * ── `isPreapproved` — the one, narrow exception ─────────────────────────────
 * Confirm-risk is otherwise unconditional: every mode above still stops for
 * one. `isPreapproved` exists for exactly one case that isn't "genuinely
 * risky" so much as "already agreed to twice" — a plain file operation whose
 * target is already inside a folder the user explicitly added to Allowed
 * Folders (Settings → General). Adding a folder there is already an explicit,
 * deliberate grant; asking "are you sure?" again for every file inside it is
 * asking the same permission a second time. It only ever softens `doIt` (see
 * the call site below) — `confirmActions` and `planFirst` exist specifically
 * for someone who picked "ask me anyway", and this must never quietly
 * override that choice. It also never changes *whether* a step is refused —
 * `skill.guard` and the registry's own capability/allowed-folder checks still
 * run exactly as before; this only decides whether the question gets asked
 * first.
 *
 * ── The emergency stop ───────────────────────────────────────────────────────
 * A fifth rule, above the other four: once `signal` aborts, nothing further
 * starts. Every wait in `run` — a confirm card, the preapproval lookup, the
 * step itself — goes through `untilHalted`, so the plan unwinds the moment the
 * stop is pressed rather than when whatever it was waiting on finishes. The
 * step in flight is abandoned, not awaited; the native side has already
 * refused or killed anything it was doing. Every step that never ran is
 * reported `skipped` with `halted: true` on the outcome, and nothing is said:
 * the surface shows the halted state itself, and a line of apology after an
 * emergency stop would be Atlas carrying on talking.
 */

import type {
  ExecutionMode,
  Plan,
  PlanOutcome,
  Skill,
  SkillArgs,
  SkillContext,
  SkillRisk,
  StepOutcome,
} from '@atlas/core';
import { DEFAULT_EXECUTION_MODE, HaltedError, untilHalted } from '@atlas/core';
import type { HaltSignal } from '@atlas/core';
import type { SkillRegistry } from '../skills/registry';
import { createPhrasing, type Phrasing } from '../phrasing';
import { refusalFor, screenPlan } from '../safety/content-policy';

export interface ExecutorOptions {
  /** Set false to run every step regardless of failures. */
  stopOnError?: boolean;
  /** Defaults to `doIt` — today's behaviour, unchanged for callers who don't pass one. */
  mode?: ExecutionMode;
  /**
   * Downgrades one `confirm`-risk step to running without asking — see this
   * module's own doc comment for the single case this exists for. Consulted
   * only in `doIt` mode, and only for a step whose risk is already `confirm`;
   * absent entirely for a caller that never wants this (every test in this
   * package, notably, which is why every existing assertion about `doIt`
   * asking stays true without touching a single one of them).
   */
  isPreapproved?(skill: Skill, args: SkillArgs): Promise<boolean>;
  /** The emergency stop. Defaults to `ctx.signal`. */
  signal?: HaltSignal;
}

/**
 * `skill.riskFor?.(args) ?? skill.risk` — the one place that ordering is
 * written down, so every caller below (the plan-wide scan, the plan-approval
 * labels, the per-step gate) agrees with each other by construction rather
 * than by all three remembering the same two-line fallback separately.
 */
function effectiveRisk(skill: Skill | null | undefined, args: SkillArgs): SkillRisk | undefined {
  return skill?.riskFor?.(args) ?? skill?.risk;
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
    const signal = options.signal ?? ctx.signal;
    const outcomes: StepOutcome[] = [];
    try {
      return await this.runSteps(plan, { ...ctx, signal }, options, signal, outcomes);
    } catch (err) {
      if (!(err instanceof HaltedError)) throw err;
      return {
        ok: false,
        ran: outcomes.filter((o) => o.ok).length,
        outcomes: [
          ...outcomes,
          ...plan.steps
            .slice(outcomes.length)
            .map((s) => ({ skill: s.skill, ok: false, skipped: true, error: 'Halted.' })),
        ],
        aborted: true,
        halted: true,
      };
    }
  }

  private async runSteps(
    plan: Plan,
    ctx: SkillContext,
    options: ExecutorOptions,
    signal: HaltSignal | undefined,
    outcomes: StepOutcome[],
  ): Promise<PlanOutcome> {
    const stopOnError = options.stopOnError !== false;
    const mode = options.mode ?? DEFAULT_EXECUTION_MODE;
    const wait = <T>(work: Promise<T>) => untilHalted(work, signal);
    if (signal?.aborted) throw new HaltedError();

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

    // Plan First's gate: only when there is something in the plan actually
    // worth approving in advance. A plan of entirely safe steps falls through
    // to the ordinary "right then" announcement below, same as every other
    // mode — this is what keeps harmless requests just as quiet under this
    // mode as under the other two.
    const hasConsequentialStep = plan.steps.some(
      (s) => effectiveRisk(this.skills.get(s.skill), s.args) === 'confirm',
    );
    // Same reasoning as the per-step guard check below, applied to the whole
    // plan: a card must never appear in front of something that would then be
    // refused. Checked eagerly, before the card would be drawn, rather than
    // discovered mid-plan — a batch approval covering a step that can never
    // run is worse than no batching at all, so a plan with a refusal in it
    // just falls back to asking (or refusing) step by step, same as `doIt`.
    const hasGuardedStep = plan.steps.some((s) => {
      const skill = this.skills.get(s.skill);
      return Boolean(skill?.guard?.(s.args));
    });
    const usingPlanApproval = mode === 'planFirst' && hasConsequentialStep && !hasGuardedStep;

    if (usingPlanApproval) {
      const { question, detail } = this.phrasing.planApproval(
        plan.steps.map((s) => {
          const skill = this.skills.get(s.skill);
          return {
            label: skill?.label ?? s.skill,
            consequential: effectiveRisk(skill, s.args) === 'confirm',
          };
        }),
      );
      const approved = await wait(ctx.confirm(question, detail));
      if (!approved) {
        ctx.say(this.phrasing.declined());
        return {
          ok: false,
          ran: 0,
          outcomes: plan.steps.map((s) => ({
            skill: s.skill,
            ok: false,
            skipped: true,
            error: 'Cancelled.',
          })),
          aborted: true,
        };
      }
    } else if (plan.steps.length > 1) {
      // A multi-step plan says what it's about to do first, so the user can
      // stop it before it starts rather than watching it happen. Skipped
      // above because the plan-approval card already said as much.
      const names = plan.steps.map((s) => this.skills.get(s.skill)?.label.toLowerCase() ?? s.skill);
      ctx.say(this.phrasing.rightThen(names));
    }

    let aborted = false;

    for (const step of plan.steps) {
      if (aborted) break;
      if (signal?.aborted) throw new HaltedError();

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

      // Plan First already put this exact step in front of the user as part
      // of the whole-plan approval above — asking again here would be the
      // "trip back to the keyboard" this mode exists to avoid.
      if (effectiveRisk(skill, step.args) === 'confirm' && !usingPlanApproval) {
        // See this file's doc comment: the one case that quietly runs
        // without asking even though its risk is `confirm`. Checked only in
        // `doIt` — `confirmActions` picked "ask me anyway" and must keep
        // meaning that.
        const preapproved =
          mode === 'doIt' &&
          (await wait(options.isPreapproved?.(skill, step.args) ?? Promise.resolve(false)));

        if (!preapproved) {
          const argsDetail = Object.values(step.args)
            .filter((v) => v !== undefined && v !== null && v !== '')
            .map(String)
            .join(' · ');

          const { question, detail } = this.phrasing.confirmPrompt(skill.description, argsDetail);
          const approved = await wait(ctx.confirm(question, detail));
          if (!approved) {
            outcomes.push({ skill: step.skill, ok: false, skipped: true, error: 'Cancelled.' });
            ctx.say(this.phrasing.declined());
            aborted = true;
            break;
          }
        }
      }

      const result = await wait(this.skills.invoke(step.skill, step.args, ctx));
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

    // A plan that stopped early still has to account for every step it named.
    //
    // Without this, `outcomes` simply ends where the plan did, and anything
    // reading it — the transcript's "X of Y actions" disclosure above all —
    // takes Y from the steps that were *reached* rather than the steps that
    // were *planned*. A five-step plan that failed at the second reported "1
    // of 2", which reads as a plan that nearly finished instead of one that
    // barely started. The halted path in `run` has always padded for exactly
    // this reason; the other two ways a plan aborts — a failed step and a
    // declined one — now say the same thing the same way.
    //
    // `Skipped.` and not `Cancelled.`: the step the person actually declined
    // already carries that, and the steps behind it were never put to them.
    if (aborted) {
      for (const step of plan.steps.slice(outcomes.length)) {
        outcomes.push({ skill: step.skill, ok: false, skipped: true, error: 'Skipped.' });
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
