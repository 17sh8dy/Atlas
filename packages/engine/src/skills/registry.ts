/**
 * The skill registry — Atlas's vocabulary of action, and the only door to it.
 *
 * Every capability the assistant has is registered here, and `invoke()` is the
 * single path by which any of them runs. That is what makes the safety model
 * checkable rather than aspirational: argument validation, capability gating
 * and unknown-skill rejection all live in one function, so there is no second
 * route that skips them — including for plans a language model wrote.
 */

import type {
  Skill,
  SkillArgs,
  SkillArgValue,
  SkillContext,
  SkillResult,
  CapabilityName,
} from '@atlas/core';

export interface RegistryOptions {
  /**
   * What the host machine can currently do. Skills needing something absent
   * are hidden rather than disabled — see `available()`.
   */
  capabilities?: () => readonly CapabilityName[];
}

export class SkillRegistry {
  private readonly skills = new Map<string, Skill>();
  private readonly capabilitiesOf: () => readonly CapabilityName[];

  constructor(options: RegistryOptions = {}) {
    this.capabilitiesOf = options.capabilities ?? (() => []);
  }

  register(skill: Skill): void {
    if (!skill?.id || typeof skill.run !== 'function') {
      throw new Error(`Malformed skill: ${String(skill?.id ?? '(no id)')}`);
    }
    this.skills.set(skill.id, skill);
  }

  registerMany(skills: readonly Skill[]): void {
    for (const s of skills) this.register(s);
  }

  get(id: string): Skill | null {
    return this.skills.get(id) ?? null;
  }

  all(): Skill[] {
    return [...this.skills.values()];
  }

  /** True when every capability this skill declares is present. */
  isAvailable(skill: Skill): boolean {
    if (!skill.needs?.length) return true;
    const have = this.capabilitiesOf();
    return skill.needs.every((n) => have.includes(n as CapabilityName));
  }

  /**
   * The skills that can actually run right now.
   *
   * The planner only ever sees this list. A skill whose capability is missing
   * is invisible, not merely disabled — so it cannot be proposed, cannot be
   * chosen, and never has to fail with an apology. Impossibility is handled
   * before planning rather than after.
   */
  available(): Skill[] {
    return this.all().filter((s) => this.isAvailable(s));
  }

  byDomain(): Map<string, Skill[]> {
    const out = new Map<string, Skill[]>();
    for (const s of this.available()) {
      const list = out.get(s.domain) ?? [];
      list.push(s);
      out.set(s.domain, list);
    }
    return out;
  }

  /**
   * Check a call without running it.
   *
   * Returns coerced arguments, because a plan from a language model arrives as
   * JSON where `"true"` and `"12"` are strings. Coercing here — against the
   * declared type — means individual skills never each reimplement it, and
   * never disagree about what counts as true.
   */
  validate(id: string, args: SkillArgs): { ok: true; args: SkillArgs } | { ok: false; error: string } {
    const skill = this.get(id);
    if (!skill) return { ok: false, error: `Unknown action “${id}”.` };
    if (!this.isAvailable(skill)) {
      const missing = (skill.needs ?? []).filter(
        (n) => !this.capabilitiesOf().includes(n as CapabilityName),
      );
      return { ok: false, error: `${skill.label} isn't available here (needs ${missing.join(', ')}).` };
    }

    const spec = skill.params ?? {};
    const out: SkillArgs = {};

    for (const [name, param] of Object.entries(spec)) {
      const raw = args[name];

      if (raw === undefined || raw === null || raw === '') {
        if (param.default !== undefined) {
          out[name] = param.default;
          continue;
        }
        if (param.required) return { ok: false, error: `${skill.label} needs “${name}”.` };
        continue;
      }

      const coerced = coerce(raw, param.type);
      if (coerced === undefined) {
        return { ok: false, error: `“${String(raw)}” isn't a valid ${param.type} for “${name}”.` };
      }
      if (param.enum && !param.enum.includes(String(coerced))) {
        return { ok: false, error: `“${name}” must be one of: ${param.enum.join(', ')}.` };
      }
      out[name] = coerced;
    }

    // Arguments the skill never declared are dropped rather than passed
    // through. A model that invents a parameter should not have it reach a
    // skill that might, one day, start reading it.
    return { ok: true, args: out };
  }

  /** Validate, then run. The only way a skill executes. */
  async invoke(id: string, args: SkillArgs, ctx: SkillContext): Promise<SkillResult> {
    const check = this.validate(id, args);
    if (!check.ok) return { ok: false, error: check.error };

    const skill = this.get(id);
    if (!skill) return { ok: false, error: `Unknown action “${id}”.` };

    try {
      return await skill.run(check.args, ctx);
    } catch (err) {
      // A crashing skill must not take the conversation down with it.
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `${skill.label} hit an error: ${detail}` };
    }
  }

  /**
   * The catalog handed to a language model when it is asked to plan.
   *
   * Only available skills, and only what a chooser needs: the id it must name,
   * what the thing does, and the arguments it takes. Deliberately compact — a
   * catalog that grows without bound eventually crowds out the conversation it
   * was meant to serve.
   */
  catalog(): string {
    const lines: string[] = [];
    for (const [domain, skills] of this.byDomain()) {
      lines.push(`# ${domain}`);
      for (const s of skills) {
        const params = Object.entries(s.params ?? {})
          .map(([n, p]) => `${n}${p.required ? '' : '?'}:${p.type}`)
          .join(', ');
        lines.push(`${s.id}(${params}) — ${s.description}`);
      }
    }
    return lines.join('\n');
  }
}

function coerce(value: SkillArgValue, type: 'string' | 'number' | 'boolean'): SkillArgValue | undefined {
  if (type === 'string') return String(value);

  if (type === 'number') {
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    return Number.isFinite(n) ? n : undefined;
  }

  if (typeof value === 'boolean') return value;
  const t = String(value).trim().toLowerCase();
  if (['true', 'yes', 'on', '1', 'enable', 'enabled'].includes(t)) return true;
  if (['false', 'no', 'off', '0', 'disable', 'disabled'].includes(t)) return false;
  return undefined;
}
