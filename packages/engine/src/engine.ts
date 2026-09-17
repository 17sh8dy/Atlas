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
 *
 * ── Halting ─────────────────────────────────────────────────────────────────
 * `halt()` aborts every run in flight. It is not how the emergency stop
 * *works* — that happens natively, below this, before this method is even
 * called (see `models/halt.ts` in `@atlas/core`). It is how the engine stops
 * *thinking about* what was just stopped: no further step, no further model
 * call, no reply to a request the person has already abandoned. Every wait
 * goes through `untilHalted`, so a run ends within a turn of the event loop
 * whatever it was waiting on.
 */

import type {
  ExecutionMode,
  IntelligenceProvider,
  IntelligenceRegistry,
  Plan,
  PlanOutcome,
  ResultRow,
  Skill,
  SkillArgs,
  SkillContext,
  VoiceProfile,
} from '@atlas/core';
import { DEFAULT_EXECUTION_MODE, HaltController, HaltedError, untilHalted } from '@atlas/core';
import type { HaltSignal } from '@atlas/core';
import { Bus } from './bus';
import { Grammar } from './planner/grammar';
import { Executor } from './planner/executor';
import { SkillRegistry } from './skills/registry';
import { createPhrasing, type Phrasing } from './phrasing';
import { WorkingMemory } from './working-memory';
import { buildAugmentedPrompt, formatSourcesFooter, needsWebSearch, runSearch } from './research';
import { refusalFor, screenRequest } from './safety/content-policy';
import { normalizeRequest } from './text/normalize';
import { readSmallTalk } from './text/smalltalk';
import { correctLeadingVerb } from './text/verb-typo';

/** How the engine talks back. Supplied by whatever surface is driving it. */
export interface EngineIO {
  /**
   * `aloud: false` means show it but do not read it out — see
   * `SkillResult.aloud`. Surfaces that cannot speak may ignore it entirely.
   */
  say(text: string, options?: { aloud?: boolean }): void;
  confirm(question: string, detail?: string): Promise<boolean>;
  showResults?(items: ResultRow[], meta?: { title?: string; subtitle?: string }): void;
  /** Streaming conversation, when the surface supports it. */
  stream?(): { append(chunk: string): void; finish(full: string): void } | null;
  typing?(on: boolean): void;
}

export type AskOutcome =
  | { ok: boolean; mode: 'command'; plan: Plan; outcome: PlanOutcome }
  | { ok: false; mode: 'halted' }
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
  /**
   * Read at the moment each plan runs, not captured at construction — cycling
   * modes (Shift+Tab) has to take effect on the very next thing Atlas does,
   * not the next time the engine happens to be rebuilt. A function rather
   * than a value for exactly that reason; see `useAtlas`'s `speechRef` for
   * the same pattern applied to speech preferences.
   */
  getExecutionMode?: () => ExecutionMode;
  /** Forwarded to the executor unchanged — see `ExecutorOptions.isPreapproved`'s doc comment. */
  isPreapproved?(skill: Skill, args: SkillArgs): Promise<boolean>;
}

export class Engine {
  readonly skills: SkillRegistry;
  readonly grammar: Grammar;
  readonly bus: Bus;
  private readonly executor: Executor;
  private readonly intelligence?: IntelligenceRegistry;
  private readonly threshold: number;
  private readonly working: WorkingMemory;
  /**
   * Shared with the executor rather than built twice. Both of them speak as
   * Atlas, so both have to agree about his name and tone — which is the whole
   * reason `phrasing.ts` exists.
   */
  private readonly phrasing: Phrasing;
  private readonly getExecutionMode: () => ExecutionMode;
  private readonly isPreapproved?: (skill: Skill, args: SkillArgs) => Promise<boolean>;
  /** One per run in flight. A Set because `run` (a button) can overlap `ask`. */
  private readonly live = new Set<HaltController>();

  constructor(options: EngineOptions) {
    this.skills = options.skills;
    this.grammar = options.grammar;
    this.bus = options.bus ?? new Bus();
    this.intelligence = options.intelligence;
    this.threshold = options.confidenceThreshold ?? 0.5;
    this.working = options.working ?? new WorkingMemory();
    this.phrasing = createPhrasing(options.voice);
    this.executor = new Executor(this.skills, this.phrasing);
    this.getExecutionMode = options.getExecutionMode ?? (() => DEFAULT_EXECUTION_MODE);
    this.isPreapproved = options.isPreapproved;
  }

  /** The one thing every `executor.run(...)` call site below shares. */
  private executorOptions(signal: HaltSignal) {
    return { mode: this.getExecutionMode(), isPreapproved: this.isPreapproved, signal };
  }

  /** Stop every run in flight. See "Halting" in this file's header. */
  halt(): void {
    const running = [...this.live];
    this.live.clear();
    for (const controller of running) controller.abort();
    this.bus.emit('engine:halted', { runs: running.length });
  }

  async ask(text: string, io: EngineIO): Promise<AskOutcome> {
    const raw = String(text ?? '').trim();
    if (!raw) return { ok: false, mode: 'chat', error: 'empty' };

    const controller = new HaltController();
    this.live.add(controller);
    try {
      return await this.askWith(raw, io, controller.signal);
    } catch (err) {
      if (err instanceof HaltedError) return { ok: false, mode: 'halted' };
      throw err;
    } finally {
      this.live.delete(controller);
    }
  }

  private async askWith(raw: string, io: EngineIO, signal: HaltSignal): Promise<AskOutcome> {
    this.bus.emit('engine:ask', { text: raw });
    const ctx = this.context(io, signal);

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

    // 1c. Third attempt: an obvious typo in the leading word only — "openn
    //     fortnite", "launh discord" — corrected against the closed
    //     instruction-verb vocabulary and re-parsed through the same rules
    //     a correctly-spelled verb would have reached. See
    //     `text/verb-typo.ts` for why this is safe: it only ever resolves to
    //     one unambiguous verb, never changes which verb was meant, and runs
    //     before any rule (and therefore any risk check) sees the text —
    //     a typo'd "delete" still reaches `file.delete` with its usual
    //     confirmation gate, exactly as if it had been spelled correctly.
    //
    //     Runs on whichever text got this far — the filler-stripped version
    //     when there was filler to strip, the raw text otherwise — since the
    //     verb is only ever the first word once a leading greeting is gone.
    const verbCorrected = correctLeadingVerb(didNormalize ? normalized : raw);
    if (!matched && verbCorrected) {
      // Set even if the retry below still doesn't match anything — rare,
      // since a corrected verb almost always completes a rule, but when it
      // doesn't, the corrected text is still more useful than the original
      // typo to whatever reads `understood` next: the AI planner, or the
      // clarifying question in `unresolvedReply`.
      understood = verbCorrected;
      const retry = this.grammar.parse(verbCorrected);
      if (retry) matched = retry;
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
      (didNormalize && this.grammar.looksActionable(normalized)) ||
      Boolean(verbCorrected && this.grammar.looksActionable(verbCorrected));
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
      const outcome = await this.executor.run(matched, ctx, this.executorOptions(signal));
      this.bus.emit('engine:done', { mode: 'command', plan: matched, outcome });
      if (outcome.halted) throw new HaltedError();
      return { ok: outcome.ok, mode: 'command', plan: matched, outcome };
    }

    // 3. Triage — questions are conversation, not planning. Skipping this is
    //    how assistants end up trying to "run" a question.
    const instruction = actionable && !this.isQuestion(raw);
    if (instruction) {
      const proposed = await this.planWithAI(understood, signal);
      if (proposed) {
        const outcome = await this.executor.run(proposed, ctx, this.executorOptions(signal));
        this.bus.emit('engine:done', { mode: 'command', plan: proposed, outcome });
        if (outcome.halted) throw new HaltedError();
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

    // 3c. Small talk — the last deterministic tier.
    //
    //     Placed here, and not earlier, on purpose: the grammar, the AI
    //     planner and the unresolved-instruction reply have all had their
    //     turn already, so nothing that could possibly be an action can be
    //     intercepted by a greeting table. What is left is the set of
    //     messages that are *only* sociable — and answering those never
    //     needed a model, just a closed list. See `text/smalltalk.ts`.
    //
    //     Reads the raw text, not the tidied one: `readSmallTalk` does its
    //     own filler-stripping as a second pass, and "hey" is a greeting that
    //     `normalizeRequest` would quite reasonably treat as filler to remove.
    const social = readSmallTalk(raw);
    if (social) {
      const reply = this.phrasing.smallTalk(social, this.skills.available().length);
      io.say(reply);
      return { ok: true, mode: 'chat', text: reply };
    }

    // 4. Conversation.
    return this.converse(understood, io, ctx, signal);
  }

  /** Question-shaped, and therefore conversation rather than an instruction. */
  private isQuestion(text: string): boolean {
    return text.trim().endsWith('?');
  }

  /** Run a plan built elsewhere — a button, a result row, a saved routine. */
  async run(plan: Plan, io: EngineIO): Promise<PlanOutcome> {
    const controller = new HaltController();
    this.live.add(controller);
    try {
      return await this.executor.run(
        plan,
        this.context(io, controller.signal),
        this.executorOptions(controller.signal),
      );
    } finally {
      this.live.delete(controller);
    }
  }

  private context(io: EngineIO, signal: HaltSignal): SkillContext {
    return {
      signal,
      say: (t: string, options?: { aloud?: boolean }) => io.say(t, options),
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
  private async planWithAI(text: string, signal: HaltSignal): Promise<Plan | null> {
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

    const asked = new Promise<string | null>((resolve) => {
      let settled = false;
      const finish = (v: string | null) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      provider.ask(
        prompt,
        {
          onDelta: () => {},
          onDone: (full) => finish(full),
          onError: () => finish(null),
        },
        { signal },
      );
    });
    const reply = await untilHalted(asked, signal);
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
  private async converse(
    text: string,
    io: EngineIO,
    ctx: SkillContext,
    signal: HaltSignal,
  ): Promise<AskOutcome> {
    const provider = this.intelligence?.active();
    const searchSkill = this.skills.get('research.search');
    const canSearch = searchSkill ? this.skills.isAvailable(searchSkill) : false;

    if (canSearch && needsWebSearch(text)) {
      // Only render the raw result rows when there's no model to turn them
      // into an actual answer — with a provider, the synthesized reply plus
      // its sources footer *is* the answer, and showing both would be noise.
      const searchCtx: SkillContext = provider ? { ...ctx, showResults: undefined } : ctx;
      const results = await untilHalted(runSearch(text, this.skills, searchCtx), signal);

      if (results.length) {
        if (provider) {
          return this.converseWithProvider(
            provider,
            buildAugmentedPrompt(text, results),
            io,
            signal,
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

    return this.converseWithProvider(provider, text, io, signal);
  }

  private async converseWithProvider(
    provider: IntelligenceProvider,
    promptText: string,
    io: EngineIO,
    signal: HaltSignal,
    sourcesFooter = '',
  ): Promise<AskOutcome> {
    io.typing?.(true);
    return new Promise<AskOutcome>((resolve, reject) => {
      let stream: ReturnType<NonNullable<EngineIO['stream']>> = null;
      let soFar = '';
      let over = false;

      // A halted reply keeps what had already arrived (it was on screen, and
      // taking it back would be stranger than leaving it) but gets nothing
      // more, and the provider's late onDone is ignored.
      const onHalt = () => {
        if (over) return;
        over = true;
        io.typing?.(false);
        stream?.finish(soFar);
        reject(new HaltedError());
      };
      if (signal.aborted) {
        onHalt();
        return;
      }
      signal.addEventListener('abort', onHalt, { once: true });
      const settle = () => {
        over = true;
        signal.removeEventListener('abort', onHalt);
      };

      const handlers = {
        onDelta: (chunk: string) => {
          if (over) return;
          soFar += chunk;
          if (!stream) {
            io.typing?.(false);
            stream = io.stream?.() ?? null;
          }
          stream?.append(chunk);
        },
        onDone: (full: string) => {
          if (over) return;
          settle();
          io.typing?.(false);
          const withSources = sourcesFooter ? full + sourcesFooter : full;
          if (stream) stream.finish(withSources);
          else if (withSources) io.say(withSources);
          resolve({ ok: true, mode: 'chat', text: withSources });
        },
        onError: (reason: string) => {
          if (over) return;
          settle();
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
      };
      provider.ask(promptText, handlers, { signal });
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
   * What to say when a free-form question arrives and there is no model to
   * answer it with.
   *
   * Led by what works, not by what's missing. An external model is an optional
   * accessory here; opening with "I'm not connected" would imply the assistant
   * were broken, when in fact every action still runs and always did.
   *
   * The older version of this string opened with "That one needs an external
   * model … (Settings → Developer)", which was accurate and still wrong: it
   * was the reply to *anything* unmatched, so it is what someone got for
   * saying hello. Greetings now stop at tier 3c and never reach here, and what
   * is left is a genuine question — so the reply names the one thing that
   * would actually answer it rather than a settings page.
   */
  private offlineReply(): string {
    const n = this.skills.available().length;
    const searchSkill = this.skills.get('research.search');
    const canSearch = searchSkill ? this.skills.isAvailable(searchSkill) : false;

    if (canSearch) {
      return (
        `I can't answer that one from what's on this machine. I can look it up ` +
        `though — say “search the web for …” and I'll go and find it. ` +
        `Otherwise there are ${n} actions I can run; “what can you do?” shows them.`
      );
    }
    return (
      `I can't answer that one — I work from what's on this machine rather ` +
      `than from a model. There are ${n} actions I can run though; ` +
      `“what can you do?” shows them.`
    );
  }
}
