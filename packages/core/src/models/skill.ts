/**
 * A skill is one thing Atlas can *do*.
 *
 * Skills are the engine's entire vocabulary of action. Nothing else in Atlas
 * performs work: the planner produces steps naming skills, the executor invokes
 * them, and search surfaces them. That single choke point is what makes the
 * safety model tractable — every action is declared, typed, capability-gated
 * and risk-rated in one place, so "what can this program do to my machine?" has
 * a literal answer you can enumerate.
 */

import type { HaltSignal } from './halt';
import type { ActivityReporter } from './activity';
import type { Clarification, ClarifyAnswer, ClarifyNeed } from './clarify';

/**
 * How much damage a skill could do if invoked wrongly.
 *
 * `safe`    — reversible and contained. Runs without asking.
 * `confirm` — touches something outside Atlas: launches software, writes a
 *             file, opens a link. Stops for explicit approval, every time.
 *
 * There is deliberately no "dangerous" tier. A thing either needs asking about
 * or it doesn't; a third level only invites arguing about which bucket
 * something belongs in.
 *
 * The test for `confirm` is whether the action *changes something closing a
 * window will not undo* — writing, renaming, moving, deleting, clearing,
 * powering off. Opening, showing and searching are `safe`, even though they
 * reach outside Atlas, because asking "are you sure you want to open Steam"
 * of someone who just said "open Steam" is asking the same question twice.
 *
 * **The test is about consequence, never about mechanism.** A click, a
 * keypress and a typed string are *inputs* — how a skill happens to act —
 * not a category of consequence of their own. `input.click` is `safe` for
 * exactly the same reason `window.focus` is: most clicks, like most window
 * switches, don't change anything closing a window won't undo. A specific
 * call that *would* — Alt+F4, which closes the foreground application the
 * same way `window.close` does — is still `confirm`, via `riskFor` below,
 * not by making every click ask "are you sure" on the strength of the worst
 * thing a click could theoretically do. See `docs/ARCHITECTURE.md` §6.6 for
 * the full reasoning, including the input skills this replaced a blanket
 * `confirm` on.
 */
export type SkillRisk = 'safe' | 'confirm';

/** The type of a single skill argument, used for validation and prompting. */
export type SkillParamType = 'string' | 'number' | 'boolean';

export interface SkillParam {
  type: SkillParamType;
  /** Reject the call if this is missing. */
  required?: boolean;
  /** Used when the caller omits an optional param. */
  default?: string | number | boolean;
  /** Constrain a string param to a fixed set. */
  enum?: readonly string[];
  /**
   * What this argument means, in words. Read by humans in docs *and* by a
   * language model when it is asked to produce a plan — which is why it is
   * phrased for a reader, not as a type annotation.
   */
  description: string;
}

export type SkillParams = Record<string, SkillParam>;

/** What a skill hands back. */
export interface SkillResult<T = unknown> {
  ok: boolean;
  /** Shown to the user. Empty when `spoken` is true. */
  message?: string;
  /** Shown when `ok` is false. Always specific — never "an error occurred". */
  error?: string;
  /**
   * The skill already rendered its own output (a result list, a card), so the
   * executor must stay quiet rather than repeating itself.
   */
  spoken?: boolean;
  /**
   * May this message be read aloud? Default yes.
   *
   * Some answers are for the eyes and nothing else. A generated password read
   * out loud is worse than useless — it is the one form of output that should
   * never leave the screen — and a hash, a UUID or a page of disk statistics
   * is simply not information an ear can hold. Marking those here rather than
   * guessing at the surface keeps the decision with the skill that knows what
   * kind of answer it produced.
   *
   * It only suppresses *speech*. The message is still shown, still copyable,
   * still in the transcript.
   */
  aloud?: boolean;
  /** Structured payload for callers that want the data, not the sentence. */
  data?: T;
}

/**
 * The context a skill is given when it runs. This is how a skill reaches the
 * outside world — it never imports a platform module directly, so the same
 * skill works on desktop, on the web, and in a test.
 */
export interface SkillContext {
  /** Say something to the user. */
  say(text: string, options?: { aloud?: boolean }): void;
  /** Ask for approval. Resolves false if declined. */
  confirm(question: string, detail?: string): Promise<boolean>;
  /**
   * Ask what a request left out, with choices — see `models/clarify.ts`.
   * Optional: a surface that cannot ask (a test, a voice-only build) leaves it
   * unset, and the executor then says the question in words and stops rather
   * than guessing.
   */
  clarify?(question: Clarification): Promise<ClarifyAnswer>;
  /** Render rows the user can act on. */
  showResults?(items: ResultRow[], meta?: { title?: string; subtitle?: string }): void;
  /**
   * Aborts when the emergency stop is pressed. A skill that loops or waits
   * should check it; one that doesn't is still abandoned on time, because the
   * executor races every step against it (see `untilHalted`).
   */
  signal?: HaltSignal;
  /**
   * Report what this skill is observably doing, for the activity panel.
   *
   * Optional, and most skills rightly ignore it: a calculation that finishes
   * in a microsecond has no progress worth watching. It earns its place in
   * the ones that take a noticeable time and do several distinguishable
   * things — a web search, a directory walk, a build.
   *
   * ⚠️ Observable actions only. What was queried, where was looked, what came
   * back. Never reasoning, intent or deliberation — see `models/activity.ts`.
   */
  activity?: ActivityReporter;
  /**
   * The fingerprint of the preview the person just approved, set by the
   * executor on a skill that has `preview`. `run` re-derives its plan and
   * refuses to act if it no longer matches — a folder can change in the seconds
   * between being shown a list and saying yes, and an approval covers *that*
   * list, not whatever is there now.
   */
  approvedPreview?: string;
  /** Anything else the host chooses to expose. */
  [key: string]: unknown;
}

/**
 * What a skill says it is about to do — see `Skill.preview`.
 *
 *  - `ask`     — show `detail` on the confirmation card. `fingerprint`, when
 *                given, comes back to `run` as `ctx.approvedPreview`.
 *  - `nothing` — there is nothing to do; say so and skip the card entirely. A
 *                question with no consequence teaches people to click through.
 *  - `refuse`  — it cannot happen (nothing found, too large to do safely); no
 *                card is drawn in front of it.
 *  - `proceed` — having looked, nothing in *this* call is consequential (a
 *                setup whose apps only need opening and checking), so there is
 *                nothing to ask; run it. It is not a way round a card: whatever
 *                `run` then does still goes through the gates it always would,
 *                and `fingerprint` is still handed back so `run` acts on the plan
 *                that was looked at, not a new one.
 */
export type SkillPreview =
  | { kind: 'ask'; detail: string; question?: string; fingerprint?: string }
  | { kind: 'nothing'; message: string }
  | { kind: 'refuse'; error: string }
  | { kind: 'proceed'; fingerprint?: string };

/** One actionable row in a result list. */
export interface ResultRow {
  title: string;
  subtitle?: string;
  icon?: string;
  /**
   * Which bucket this row belongs to, when a result set has a natural
   * grouping — the skill's domain for the capability list, a date for a file
   * search that wanted one.
   *
   * Data, not layout. A surface is free to render groups as headings, as
   * collapsible sections, or to ignore them entirely and show a flat list;
   * the engine has no opinion and cannot have one, since it renders nothing.
   */
  group?: string;
  /** The underlying object, for whatever the row's actions need. */
  payload?: unknown;
  actions?: Array<{ label: string; skill: string; args: SkillArgs }>;
}

export type SkillArgValue = string | number | boolean;
export type SkillArgs = Record<string, SkillArgValue>;

export interface Skill<T = unknown> {
  /** Namespaced: `files.find`, `app.open`, `system.info`. */
  id: string;
  /** Human name, used in UI and in the planner's catalog. */
  label: string;
  icon?: string;
  /** Groups skills for help, search and prompt organisation. */
  domain: string;
  /**
   * What it does, phrased so a language model can decide whether it applies.
   * This text is the skill's entire interface to the AI planner.
   */
  description: string;
  /**
   * Capabilities that must be present, or the skill is hidden — not just
   * disabled. A planner that cannot see an impossible skill cannot propose it,
   * which removes a whole class of failure before it happens.
   */
  needs?: readonly string[];
  risk?: SkillRisk;
  /**
   * Escalates `risk` for one specific call, when the skill's mechanism is
   * usually safe but *this* invocation is a known equivalent of something
   * this codebase already gates elsewhere. Exists for exactly that shape of
   * case — see `input.hotkey`'s Alt+F4 check against `window.close` — not as
   * a general per-call risk engine: most skills need no opinion beyond the
   * static `risk` above, and most of the ones with an opinion could not form
   * one anyway (a raw click has no idea what it will hit).
   *
   * Returning `undefined` defers to `risk`. Checked wherever `risk` is, by
   * the executor alone — the same "one door" the content policy and `guard`
   * already go through — so this can never be bypassed by a caller that
   * only reads the static field.
   *
   * Synchronous and pure, for the same reason `guard` is: it sees only the
   * arguments as given, and a version that queried the machine to decide
   * would be a second, invisible execution path.
   */
  riskFor?(args: SkillArgs): SkillRisk | undefined;
  /**
   * May this skill's message be read aloud? Default yes.
   *
   * Declared on the skill rather than per result, because it is a property of
   * the *kind* of answer produced: `util.password` never has an output worth
   * hearing, and `system.info` never has one an ear can hold. A single result
   * can still override it.
   */
  aloud?: boolean;
  /** Phrasings a user might actually type. Shown as examples, and searchable. */
  examples?: readonly string[];
  params?: SkillParams;
  /**
   * A reason this particular call must not happen at all.
   *
   * The tier above `confirm`. `risk` answers "should Atlas ask first?"; this
   * answers "is there any version of this call that should go ahead?" — and
   * some are not. Stopping the RPC service is not a decision to put behind a
   * card, because a card that appears in front of it teaches people to click
   * through cards.
   *
   * Return `null` to allow, or the sentence explaining the refusal. It runs
   * before the confirmation is shown (so no card appears for something that
   * would then be refused) *and* inside `SkillRegistry.invoke` (so a caller
   * reaching past the executor is still covered) — the same layering the
   * content policy uses, and for the same reason.
   *
   * It sees the arguments as given, which for a skill that resolves a
   * friendly name into a real one means it is working with what the person
   * typed rather than with what it turned out to mean. So a guard is a
   * *pre-empt*, not the guarantee: it stops the obvious cases before a card is
   * drawn, and the authoritative refusal lives next to the machine, against
   * the resolved name. Synchronous and pure for that reason — a guard that
   * went and asked the machine would be a second, invisible execution path.
   */
  guard?(args: SkillArgs): string | null;
  /**
   * Is something needed that these arguments do not give? Return what is
   * missing, or `null` to go ahead.
   *
   * Asked before the risk gate, so a step is complete before anyone is asked
   * whether to allow it. It is for *genuine* gaps only — a value so generic it
   * could name anything. A skill that can reasonably finish the job returns
   * `null`; asking when Atlas could simply have done it is the failure this
   * exists to avoid. Required arguments that are simply absent need no hook:
   * the executor asks about those on its own.
   *
   * Synchronous and pure, like `guard`: it reads arguments and decides, and
   * never consults the machine.
   */
  clarify?(args: SkillArgs): ClarifyNeed | null;
  /**
   * Look before leaping: work out what this call *would* do and say so, so the
   * confirmation card can show the real consequence instead of the arguments.
   *
   * Exists for the bulk skills — "clean up my Downloads" is 200 moves whose
   * names only exist once the folder has been read, so a card built from the
   * arguments ("downloads") asks a person to approve something neither of them
   * can see. The executor calls this on a `confirm` skill *instead of* the
   * generic prompt, shows what it returns, and only then lets `run` start.
   *
   * ⚠️ Contract: **read-only.** It may list, stat and compute; it must never
   * create, move, write or delete. It is the one hook that runs *before* the
   * person has said yes, so anything it changed would be an action taken without
   * asking. Unlike `guard` and `riskFor` it is async, because looking at the
   * machine is the whole point — the price is that this rule is enforced by
   * convention and by review, not by the type.
   *
   * Never softened by an execution mode or Allowed Folders: a batch is exactly
   * where "just do it" is least wanted. Ignored on a skill whose risk is not
   * `confirm`.
   */
  preview?(args: SkillArgs, ctx: SkillContext): Promise<SkillPreview>;
  /**
   * These arguments as a short phrase — "open Steam" — for the places Atlas
   * refers back to a step ("Just open Steam"). Falls back to the label.
   */
  summarize?(args: SkillArgs): string;
  run(args: SkillArgs, ctx: SkillContext): SkillResult<T> | Promise<SkillResult<T>>;
}
