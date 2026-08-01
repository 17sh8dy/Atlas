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
  say(text: string): void;
  /** Ask for approval. Resolves false if declined. */
  confirm(question: string, detail?: string): Promise<boolean>;
  /** Render rows the user can act on. */
  showResults?(items: ResultRow[], meta?: { title?: string; subtitle?: string }): void;
  /** Anything else the host chooses to expose. */
  [key: string]: unknown;
}

/** One actionable row in a result list. */
export interface ResultRow {
  title: string;
  subtitle?: string;
  icon?: string;
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
  /** Phrasings a user might actually type. Shown as examples, and searchable. */
  examples?: readonly string[];
  params?: SkillParams;
  run(args: SkillArgs, ctx: SkillContext): SkillResult<T> | Promise<SkillResult<T>>;
}
