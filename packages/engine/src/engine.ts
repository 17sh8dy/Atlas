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
import { createPhrasing, type Phrasing } from './phrasing';
import type { EngineStatus } from './status';
import { WorkingMemory } from './working-memory';
import { buildAugmentedPrompt, formatSourcesFooter, needsWebSearch, runSearch } from './research';
import { refusalFor, screenRequest } from './safety/content-policy';
import { normalizeRequest } from './text/normalize';

/** How the engine talks back. Supplied by whatever surface is driving it. */
export interface EngineIO {
  say(text: string): void;
  confirm(question: string, detail?: string): Promise<boolean>;
  showResults?(items: ResultRow[], meta?: { title?: string; subtitle?: string }): void;
  /** Streaming conversation, when the surface supports it. */
  stream?(): { append(chunk: string): void; finish(full: string): void } | null;
  /**
   * What Atlas is doing right now; null when it has stopped.
   *
   * Emitted whenever the KIND of work changes — most importantly when a
   * request stops being answerable locally and escalates to a model, which is
   * the one pause long enough that silence reads as a fault. A surface that
   * ignores this behaves exactly as it did before; nothing here is required.
   */
  status?(update: EngineStatus | null): void;
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
  private readonly phrasing: Phrasing;

  constructor(options: EngineOptions) {
    this.skills = options.skills;
    this.grammar = options.grammar;
    this.bus = options.bus ?? new Bus();
    this.intelligence = options.intelligence;
    this.threshold = options.confidenceThreshold ?? 0.5;
    this.working = options.working ?? new WorkingMemory();
    // One instance, shared with the executor. Two would be a way for the
    // status line and the replies underneath it to drift apart in tone.
    this.phrasing = createPhrasing(options.voice);
    this.executor = new Executor(this.skills, this.phrasing);
  }

  /**
   * Announce a stage, and mirror it onto the bus.
   *
   * The bus copy is what lets anything else in the app react to an escalation
   * without being wired into the io object — the voice layer, a tray icon,
   * a future usage log.
   */
  private announce(io: EngineIO, update: EngineStatus | null): void {
    io.status?.(update);
    this.bus.emit('engine:status', update);
  }

  /** Build the status for a hand-off to a provider. */
  private switchingTo(provider: IntelligenceProvider): EngineStatus {
    return {
      stage: 'switching',
      label: this.phrasing.switchingTo(provider.label),
      providerId: provider.id,
      local: provider.isLocal(),
    };
  }

  private thinkingWith(provider: IntelligenceProvider): EngineStatus {
    return {
      stage: 'thinking',
      label: this.phrasing.thinking(),
      providerId: provider.id,
      local: provider.isLocal(),
    };
  }

  async ask(text: string, io: EngineIO): Promise<AskOutcome> {
    const raw = String(text ?? '').trim();
    if (!raw) return { ok: false, mode: 'chat', error: 'empty' };

    this.bus.emit('engine:ask', { text: raw });
    const ctx = this.context(io);

    // 1. Grammar — the fast path. Parsing is pure: it reads the text and
    //    builds a plan object, and nothing runs until the executor is handed
    //    one, so the policy check below still sits ahead of every action.
    let matched = this.grammar.parse(raw);
    /** What the rest of the pipeline reads: the tidied text once it earned it. */
    let understood = raw;

    // 1b. Second attempt, on the request with its conversational wrapper
    //     removed. The grammar's rules are anchored on purpose — an
    //     unanchored "open X" would claim "remind me not to open Steam" — so
    //     "yo and open YouTube" misses every one of them despite being
    //     completely clear. Rather than loosen every rule, strip the greeting
    //     and run the same rules again.
    //
    //     Only ever a *second* attempt: raw text that already matched is
    //     never re-interpreted, so this cannot change how an understood
    //     sentence behaves.
    const normalized = normalizeRequest(raw);
    const didNormalize = normalized.length > 0 && normalized !== raw;
    if (!matched && didNormalize) {
      const retry = this.grammar.parse(normalized);
      if (retry) {
        matched = retry;
        understood = normalized;
      }
    }

    // 2. Content policy. Placed here, between understanding the request and
    //    executing anything, because a refusal has to happen before the first
    //    keystroke reaches a search box — not after the browser is already
    //    open on the query. A question about a sexual subject is conversation
    //    and passes; an instruction to go and fetch explicit material does
    //    not. Refusing sexual content involving minors ignores that
    //    distinction and applies to any phrasing at all.
    const actionable =
      Boolean(matched) ||
      this.grammar.looksActionable(raw) ||
      (didNormalize && this.grammar.looksActionable(normalized));
    // Screened on the raw text as well as the tidied one, so filler can never
    // be a way to smuggle something past the check.
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
    const instruction = actionable && !this.isQuestion(raw);
    if (instruction) {
      const proposed = await this.planWithAI(understood, io);
      if (proposed) {
        const outcome = await this.executor.run(proposed, ctx);
        this.bus.emit('engine:done', { mode: 'command', plan: proposed, outcome });
        return { ok: outcome.ok, mode: 'command', plan: proposed, outcome };
      }
    }

    // 3b. An instruction Atlas understood the shape of but could not resolve.
    //     Without this it falls into conversation and gets answered with a
    //     paragraph about external models — which is both wrong and useless,
    //     because no model was ever needed to open an app. Ask the one
    //     question that would settle it instead.
    if (instruction && !this.intelligence?.active()) {
      io.say(this.unresolvedReply(understood));
      return { ok: false, mode: 'chat', error: 'unresolved' };
    }

    // 4. Conversation.
    return this.converse(understood, io, ctx);
  }

  /** Question-shaped, and therefore conversation rather than an instruction. */
  private isQuestion(text: string): boolean {
    return text.trim().endsWith('?');
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
  private async planWithAI(text: string, io: EngineIO): Promise<Plan | null> {
    const provider = this.intelligence?.active();
    if (!provider) return null;

    // Planning is an escalation too, even though what comes back is a plan
    // rather than prose. From the outside it is the same several-second pause,
    // so it gets the same explanation.
    this.announce(io, this.switchingTo(provider));

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
      // After `ask` is under way, not before: "Thinking" should mean the
      // request is actually in flight. Guarded by the same `settled` flag the
      // resolver uses, so a provider that answers synchronously never shows a
      // stage it has already finished.
      if (!settled) this.announce(io, this.thinkingWith(provider));
    });

    // Cleared here rather than in each branch below. Every path out of this
    // method either runs a plan or falls through to conversation, and both
    // announce their own next stage — but a `return null` that left the last
    // status on screen would strand it there forever.
    this.announce(io, null);
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
      this.announce(io, { stage: 'searching', label: this.phrasing.searching() });
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
    // Two stages, not one. "Switching" names where the question is going;
    // "Thinking" says it has arrived. Splitting them is what turns a silent
    // multi-second gap into something legible — and with today's providers
    // being one-shot rather than streaming (see `intelligence.rs`), this is
    // the ONLY feedback between the question and the finished answer.
    this.announce(io, this.switchingTo(provider));

    return new Promise<AskOutcome>((resolve) => {
      let stream: ReturnType<NonNullable<EngineIO['stream']>> = null;
      /**
       * Whether the provider has already answered.
       *
       * A provider is free to call `onDone` synchronously inside `ask` — the
       * in-memory ones in the tests do exactly that. Without this flag the
       * "Thinking" announcement below would run AFTER the clearing one and
       * strand the label on screen forever, on precisely the fast path where
       * it should never have appeared at all.
       */
      let settled = false;

      provider.ask(promptText, {
        onDelta: (chunk) => {
          if (!stream) {
            settled = true;
            this.announce(io, null);
            stream = io.stream?.() ?? null;
          }
          stream?.append(chunk);
        },
        onDone: (full) => {
          settled = true;
          this.announce(io, null);
          const withSources = sourcesFooter ? full + sourcesFooter : full;
          if (stream) stream.finish(withSources);
          else if (withSources) io.say(withSources);
          resolve({ ok: true, mode: 'chat', text: withSources });
        },
        onError: (reason) => {
          settled = true;
          this.announce(io, null);
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

      // Announced once the request is genuinely in flight, so "Thinking" never
      // appears before anything is thinking — and skipped entirely if the
      // provider already answered, which is what `settled` is guarding.
      if (!settled) this.announce(io, this.thinkingWith(provider));
    });
  }

  /**
   * What to say when the request was clearly an instruction, but nothing
   * matched it.
   *
   * The old behaviour here was to fall through to `offlineReply()`, which
   * blamed a missing external model. That was wrong twice over: no model is
   * needed to open an application, and telling someone about a setting they
   * do not need is an implementation detail leaking into a conversation. A
   * short question gets the user moving; a paragraph about providers does not.
   */
  private unresolvedReply(text: string): string {
    const target = /^\s*(?:open|launch|start|run|go to|visit|play)\s+(.+?)\s*[?.!]*$/i.exec(text);
    const named = target?.[1]?.trim();

    if (named) {
      return `I couldn't work out what “${named}” is — I don't have an app or a site by that name. What should I open?`;
    }
    return "I didn't catch what you wanted me to do there. Say it as an instruction — “open Steam”, “find my invoices” — or ask “what can you do?” for the full list.";
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
