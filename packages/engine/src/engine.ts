/**
 * The engine kernel. One entry point: `engine.ask(text, io)`.
 *
 * ── The pipeline ────────────────────────────────────────────────────────────
 *
 *   text ─▶ 1. grammar    deterministic, instant, offline. Handles most of it.
 *           2. triage     is this an instruction at all, or a question?
 *           3. AI plan    only for novel phrasing. Strict JSON, validated
 *                         against the registry before a single step runs.
 *           4. conversation  anything left over.
 *
 * Each tier is cheaper and more certain than the one after it, so the common
 * case never pays for the rare one. Turn every provider off and tiers 1–2 still
 * work completely — that is the whole point of the ordering.
 *
 * ── The io object ───────────────────────────────────────────────────────────
 * The engine renders nothing. It is handed `say`/`confirm`/`showResults`, so a
 * desktop window, a command bar, a tray popover and a test all drive the same
 * engine without it knowing which. Adding a surface means supplying an io, not
 * changing anything here.
 */

import type {
  IntelligenceRegistry,
  Plan,
  PlanOutcome,
  ResultRow,
  SkillContext,
} from '@atlas/core';
import { Bus } from './bus';
import { Grammar } from './planner/grammar';
import { Executor } from './planner/executor';
import { SkillRegistry } from './skills/registry';

/** How the engine talks back. Supplied by whatever surface is driving it. */
export interface EngineIO {
  say(text: string): void;
  confirm(question: string, detail?: string): Promise<boolean>;
  showResults?(items: ResultRow[], meta?: { title?: string; subtitle?: string }): void;
  /** Streaming conversation, when the surface supports it. */
  stream?(): { append(chunk: string): void; finish(full: string): void } | null;
  typing?(on: boolean): void;
}

export type AskOutcome =
  | { ok: boolean; mode: 'command'; plan: Plan; outcome: PlanOutcome }
  | { ok: boolean; mode: 'chat'; text?: string; error?: string };

export interface EngineOptions {
  skills: SkillRegistry;
  grammar: Grammar;
  bus?: Bus;
  intelligence?: IntelligenceRegistry;
  /** Below this, a plan is described rather than run. */
  confidenceThreshold?: number;
}

export class Engine {
  readonly skills: SkillRegistry;
  readonly grammar: Grammar;
  readonly bus: Bus;
  private readonly executor: Executor;
  private readonly intelligence?: IntelligenceRegistry;
  private readonly threshold: number;

  constructor(options: EngineOptions) {
    this.skills = options.skills;
    this.grammar = options.grammar;
    this.bus = options.bus ?? new Bus();
    this.intelligence = options.intelligence;
    this.threshold = options.confidenceThreshold ?? 0.5;
    this.executor = new Executor(this.skills);
  }

  async ask(text: string, io: EngineIO): Promise<AskOutcome> {
    const raw = String(text ?? '').trim();
    if (!raw) return { ok: false, mode: 'chat', error: 'empty' };

    this.bus.emit('engine:ask', { text: raw });
    const ctx = this.context(io);

    // 1. Grammar — the fast path.
    const matched = this.grammar.parse(raw);
    if (matched && matched.confidence >= this.threshold) {
      const outcome = await this.executor.run(matched, ctx);
      this.bus.emit('engine:done', { mode: 'command', plan: matched, outcome });
      return { ok: outcome.ok, mode: 'command', plan: matched, outcome };
    }

    // 2. Triage — questions are conversation, not planning. Skipping this is
    //    how assistants end up trying to "run" a question.
    if (this.grammar.looksActionable(raw)) {
      const proposed = await this.planWithAI(raw);
      if (proposed) {
        const outcome = await this.executor.run(proposed, ctx);
        this.bus.emit('engine:done', { mode: 'command', plan: proposed, outcome });
        return { ok: outcome.ok, mode: 'command', plan: proposed, outcome };
      }
    }

    // 3. Conversation.
    return this.converse(raw, io);
  }

  /** Run a plan built elsewhere — a button, a result row, a saved routine. */
  async run(plan: Plan, io: EngineIO): Promise<PlanOutcome> {
    return this.executor.run(plan, this.context(io));
  }

  private context(io: EngineIO): SkillContext {
    return {
      say: (t: string) => io.say(t),
      confirm: (q: string, d?: string) => io.confirm(q, d),
      showResults: io.showResults?.bind(io),
      bus: this.bus,
      skills: this.skills,
    };
  }

  /**
   * Ask a provider to turn novel phrasing into a plan.
   *
   * Returns null whenever anything at all is off — no provider, malformed
   * JSON, an unregistered skill, a bad argument. The caller then falls through
   * to conversation. A half-understood instruction must never become a
   * half-run plan, so the bar for accepting one is: it validates completely,
   * or it isn't a plan.
   */
  private async planWithAI(text: string): Promise<Plan | null> {
    const provider = this.intelligence?.active();
    if (!provider) return null;

    const prompt = [
      'Turn the user request into a JSON plan. Reply with JSON only, no prose.',
      'Schema: {"intent":string,"confidence":number,"steps":[{"skill":string,"args":object}]}',
      'You may ONLY use these actions:',
      this.skills.catalog(),
      '',
      `Request: ${text}`,
    ].join('\n');

    const reply = await new Promise<string | null>((resolve) => {
      let settled = false;
      const finish = (v: string | null) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      provider.ask(prompt, {
        onDelta: () => {},
        onDone: (full) => finish(full),
        onError: () => finish(null),
      });
    });
    if (!reply) return null;

    let parsed: unknown;
    try {
      const json = reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1);
      parsed = JSON.parse(json);
    } catch {
      return null;
    }

    const candidate = parsed as { intent?: string; confidence?: number; steps?: unknown };
    if (!Array.isArray(candidate.steps) || candidate.steps.length === 0) return null;

    const steps = [];
    for (const s of candidate.steps as Array<{ skill?: string; args?: Record<string, never> }>) {
      if (!s?.skill) return null;
      const check = this.skills.validate(s.skill, s.args ?? {});
      if (!check.ok) return null; // one bad step invalidates the whole plan
      steps.push({ skill: s.skill, args: check.args });
    }

    return {
      source: 'ai',
      intent: candidate.intent ?? 'ai',
      steps,
      confidence: typeof candidate.confidence === 'number' ? candidate.confidence : 0.7,
    };
  }

  /** Free-form answering, when a provider is connected. */
  private async converse(text: string, io: EngineIO): Promise<AskOutcome> {
    const provider = this.intelligence?.active();
    if (!provider) {
      io.say(this.offlineReply());
      return { ok: false, mode: 'chat', error: 'not-configured' };
    }

    io.typing?.(true);
    return new Promise<AskOutcome>((resolve) => {
      let stream: ReturnType<NonNullable<EngineIO['stream']>> = null;

      provider.ask(text, {
        onDelta: (chunk) => {
          if (!stream) {
            io.typing?.(false);
            stream = io.stream?.() ?? null;
          }
          stream?.append(chunk);
        },
        onDone: (full) => {
          io.typing?.(false);
          if (stream) stream.finish(full);
          else if (full) io.say(full);
          resolve({ ok: true, mode: 'chat', text: full });
        },
        onError: (reason) => {
          io.typing?.(false);
          io.say(
            reason === 'not-configured'
              ? this.offlineReply()
              : "I couldn't reach that provider. It's in Settings → Intelligence Providers.",
          );
          resolve({ ok: false, mode: 'chat', error: reason });
        },
      });
    });
  }

  /**
   * What to say when a free-form question arrives with no provider connected.
   *
   * Led by what works, not by what's missing. An external model is an optional
   * accessory here; opening with "I'm not connected" would imply the assistant
   * were broken, when in fact every action still runs and always did.
   */
  private offlineReply(): string {
    const n = this.skills.available().length;
    return (
      `That one needs an external model, which is optional and off by default ` +
      `(Settings → Intelligence Providers). Everything else works: I can run ${n} ` +
      `actions right now — say “what can you do?” to see them.`
    );
  }
}
