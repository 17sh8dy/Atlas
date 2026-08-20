/**
 * The engine kernel. One entry point: `engine.ask(text, io)`.
 *
 * ── The pipeline ────────────────────────────────────────────────────────────
 *
 *   text ─▶ 1. grammar    deterministic, instant, offline. Handles most of it.
 *           2. policy     may Atlas act on this at all? Refusals stop here,
 *                         before anything is typed, opened or played.
 *           3. triage     is this an instruction at all, or a question?
 *           4. AI plan    only for novel phrasing. Strict JSON, validated
 *                         against the registry before a single step runs.
 *           5. conversation  anything left over.
 *
 * Each tier is cheaper and more certain than the one after it, so the common
 * case never pays for the rare one. Turn every provider off and tiers 1–3 still
 * work completely — that is the whole point of the ordering.
 *
 * ── The io object ───────────────────────────────────────────────────────────
 * The engine renders nothing. It is handed `say`/`confirm`/`showResults`, so a
 * desktop window, a command bar, a tray popover and a test all drive the same
 * engine without it knowing which. Adding a surface means supplying an io, not
 * changing anything here.
 */

import type {
  IntelligenceProvider,
  IntelligenceRegistry,
  Plan,
  PlanOutcome,
  ResultRow,
  SkillContext,
  VoiceProfile,
} from '@atlas/core';
import { Bus } from './bus';
import { Grammar } from './planner/grammar';
import { Executor } from './planner/executor';
import { SkillRegistry } from './skills/registry';
import { createPhrasing } from './phrasing';
import { WorkingMemory } from './working-memory';
import { buildAugmentedPrompt, formatSourcesFooter, needsWebSearch, runSearch } from './research';
import { refusalFor, screenRequest } from './safety/content-policy';

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
  /** Shapes how the executor phrases its own messages (confirmations, failures). */
  voice?: VoiceProfile;
  /**
   * Must be the same instance handed to `createCoreGrammar()`, so a result
   * list rendered here is visible to the grammar rules that resolve "it" and
   * "the second one" against it. Defaults to a fresh, empty one — which just
   * means those rules never have anything to resolve, not an error.
   */
  working?: WorkingMemory;
}

export class Engine {
  readonly skills: SkillRegistry;
  readonly grammar: Grammar;
  readonly bus: Bus;
  private readonly executor: Executor;
  private readonly intelligence?: IntelligenceRegistry;
  private readonly threshold: number;
  private readonly working: WorkingMemory;

  constructor(options: EngineOptions) {
    this.skills = options.skills;
    this.grammar = options.grammar;
    this.bus = options.bus ?? new Bus();
    this.intelligence = options.intelligence;
    this.threshold = options.confidenceThreshold ?? 0.5;
    this.working = options.working ?? new WorkingMemory();
    this.executor = new Executor(this.skills, createPhrasing(options.voice));
  }

  async ask(text: string, io: EngineIO): Promise<AskOutcome> {
    const raw = String(text ?? '').trim();
    if (!raw) return { ok: false, mode: 'chat', error: 'empty' };

    this.bus.emit('engine:ask', { text: raw });
    const ctx = this.context(io);

    // 1. Grammar — the fast path. Parsing is pure: it reads the text and
    //    builds a plan object, and nothing runs until the executor is handed
    //    one, so the policy check below still sits ahead of every action.
    const matched = this.grammar.parse(raw);

    // 2. Content policy. Placed here, between understanding the request and
    //    executing anything, because a refusal has to happen before the first
    //    keystroke reaches a search box — not after the browser is already
    //    open on the query. A question about a sexual subject is conversation
    //    and passes; an instruction to go and fetch explicit material does
    //    not. Refusing sexual content involving minors ignores that
    //    distinction and applies to any phrasing at all.
    const actionable = Boolean(matched) || this.grammar.looksActionable(raw);
    const screened = screenRequest(raw, actionable);
    if (!screened.allowed) {
      // Deliberately carries the reason and not the text. Nothing downstream
      // of a refusal — the bus, an episode, a future conversation log — has
      // any business keeping a copy of the request that caused it.
      this.bus.emit('engine:refused', { reason: screened.reason });
      io.say(refusalFor(screened.reason));
      return { ok: false, mode: 'chat', error: `refused:${screened.reason}` };
    }

    if (matched && matched.confidence >= this.threshold) {
      const outcome = await this.executor.run(matched, ctx);
      this.bus.emit('engine:done', { mode: 'command', plan: matched, outcome });
      return { ok: outcome.ok, mode: 'command', plan: matched, outcome };
    }

    // 3. Triage — questions are conversation, not planning. Skipping this is
    //    how assistants end up trying to "run" a question.
    if (this.grammar.looksActionable(raw)) {
      const proposed = await this.planWithAI(raw);
      if (proposed) {
        const outcome = await this.executor.run(proposed, ctx);
        this.bus.emit('engine:done', { mode: 'command', plan: proposed, outcome });
        return { ok: outcome.ok, mode: 'command', plan: proposed, outcome };
      }
    }

    // 4. Conversation.
    return this.converse(raw, io, ctx);
  }

  /** Run a plan built elsewhere — a button, a result row, a saved routine. */
  async run(plan: Plan, io: EngineIO): Promise<PlanOutcome> {
    return this.executor.run(plan, this.context(io));
  }

  private context(io: EngineIO): SkillContext {
    return {
      say: (t: string) => io.say(t),
      confirm: (q: string, d?: string) => io.confirm(q, d),
      showResults: (items, meta) => {
        this.working.setResults(items);
        io.showResults?.(items, meta);
      },
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

  /**
   * Free-form answering. Before falling back to a plain reply, a question
   * that smells like it needs current information (see `needsWebSearch`)
   * gets a search first — this is what makes "what happened in the latest
   * Fortnite update?" work, since no model's training data has that.
   */
  private async converse(text: string, io: EngineIO, ctx: SkillContext): Promise<AskOutcome> {
    const provider = this.intelligence?.active();
    const searchSkill = this.skills.get('research.search');
    const canSearch = searchSkill ? this.skills.isAvailable(searchSkill) : false;

    if (canSearch && needsWebSearch(text)) {
      // Only render the raw result rows when there's no model to turn them
      // into an actual answer — with a provider, the synthesized reply plus
      // its sources footer *is* the answer, and showing both would be noise.
      const searchCtx: SkillContext = provider ? { ...ctx, showResults: undefined } : ctx;
      const results = await runSearch(text, this.skills, searchCtx);

      if (results.length) {
        if (provider) {
          return this.converseWithProvider(
            provider,
            buildAugmentedPrompt(text, results),
            io,
            formatSourcesFooter(results),
          );
        }
        io.say(
          `Found ${results.length} result${results.length === 1 ? '' : 's'} for that — see below.`,
        );
        return { ok: true, mode: 'chat', text: 'search-results-shown' };
      }
      // No results, or the search itself failed — fall through below rather
      // than a dead end; a stale answer or an honest "I can't" both beat that.
    }

    if (!provider) {
      io.say(this.offlineReply());
      return { ok: false, mode: 'chat', error: 'not-configured' };
    }

    return this.converseWithProvider(provider, text, io);
  }

  private async converseWithProvider(
    provider: IntelligenceProvider,
    promptText: string,
    io: EngineIO,
    sourcesFooter = '',
  ): Promise<AskOutcome> {
    io.typing?.(true);
    return new Promise<AskOutcome>((resolve) => {
      let stream: ReturnType<NonNullable<EngineIO['stream']>> = null;

      provider.ask(promptText, {
        onDelta: (chunk) => {
          if (!stream) {
            io.typing?.(false);
            stream = io.stream?.() ?? null;
          }
          stream?.append(chunk);
        },
        onDone: (full) => {
          io.typing?.(false);
          const withSources = sourcesFooter ? full + sourcesFooter : full;
          if (stream) stream.finish(withSources);
          else if (withSources) io.say(withSources);
          resolve({ ok: true, mode: 'chat', text: withSources });
        },
        onError: (reason) => {
          io.typing?.(false);
          // 'not-configured'/'offline' are the two sentinel reasons this
          // interface always understood; anything else is a real provider
          // error (a rejected key, a rate limit) worth showing verbatim
          // rather than flattening into one generic line — see
          // ProviderStreamHandlers.onError's own doc comment.
          if (reason === 'not-configured') io.say(this.offlineReply());
          else if (reason === 'offline') {
            io.say("I couldn't reach that provider. It's in Settings → Developer.");
          } else io.say(`⚠️ ${reason}`);
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
      `(Settings → Developer). Everything else works: I can run ${n} ` +
      `actions right now — say “what can you do?” to see them.`
    );
  }
}
