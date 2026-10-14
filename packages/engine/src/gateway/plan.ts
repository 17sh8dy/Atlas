/**
 * The model gateway: how Atlas gets a plan out of a connected model.
 *
 * One door, one job. Given a request the grammar could not read and a model that might, it asks
 * the model — by the best route that model is known to support — and returns **validated plan
 * steps or nothing**. It never runs anything, never opens a second path to the machine, and
 * never decides what is allowed.
 *
 * ── What it does ────────────────────────────────────────────────────────────
 *  1. Chooses a route from the model's declared capabilities (`route.ts`): native tool calling,
 *     a schema-held reply, or plain text.
 *  2. Offers at most `MAX_TOOLS` skills chosen by the deterministic router, plus a discovery
 *     tool for "I need something that is not here" (one extra round, answered by Atlas).
 *  3. Reads the reply in whichever shape came back (tool calls, or JSON in text, however the
 *     model wrapped it) and validates **every** step against the registry's own rules.
 *  4. On a reply that is not usable, re-asks **once**, telling the model exactly what was wrong.
 *     A second failure is not retried: the caller falls back to its ordinary ask-or-clarify path.
 *     Nothing is ever retried into an action; the only thing a retry can produce is a plan that
 *     then goes through everything a plan always goes through.
 *  5. If a server or model refuses the constraint (tools, schema), steps down one route and asks
 *     again, without counting that as a failed attempt.
 *
 * ── What it cannot do (and a test keeps it that way) ────────────────────────
 * It depends on a read-only view of the catalog (`GatewayCatalog`), not on the executor, the
 * registry's `run`, the platform or storage. See `test/gateway-no-new-door.test.ts`.
 */

import type {
  HaltSignal,
  IntelligenceProvider,
  ModelCapabilities,
  ModelTool,
  ModelToolCall,
  PlanStep,
  Skill,
  SkillArgs,
} from '@atlas/core';
import { jsonObjectsIn } from '../agent/tool-call';
import { chooseRoute, type Route } from './route';
import {
  DISCOVERY_TOOL,
  MAX_TOOLS,
  planSchema,
  selectSkills,
  skillIdOfTool,
  toolsFor,
} from './tools';

/** The read-only slice of the skill registry the gateway needs. */
export interface GatewayCatalog {
  available(): readonly Skill[];
  validate(id: string, args: SkillArgs): { ok: true; args: SkillArgs } | { ok: false; error: string };
  catalog(request?: string): string;
}

export interface GatewayOptions {
  /** The standing rules about what Atlas will not help with (`USE_RULES`). Same text on every route. */
  useRules: string;
  maxTools?: number;
}

export type GatewayOutcome =
  | {
      kind: 'steps';
      steps: PlanStep[];
      intent: string;
      confidence: number;
      route: Route;
      /** Asks made, counting a repair (1 or 2). */
      attempts: number;
    }
  | {
      kind: 'none';
      /**
       * `no-provider` nothing connected · `unavailable` it could not be reached or refused ·
       * `no-steps` it said there was nothing to do · `unreadable` / `invalid` it answered, and
       * the answer was not a usable plan even after one correction.
       */
      reason: 'no-provider' | 'unavailable' | 'no-steps' | 'unreadable' | 'invalid';
      route?: Route;
      attempts: number;
      detail?: string;
    };

/** What came back from one ask. */
interface Reply {
  text: string | null;
  calls: ModelToolCall[];
  error?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const MAX_ATTEMPTS = 2;
/** The longest a plan waits to learn what a model supports before using what was declared. */
const CAPABILITY_WAIT_MS = 4000;

/** The rules about arguments, identical on every route and to what Atlas has always said. */
function argumentRules(useRules: string): string[] {
  return [
    'Rules for the arguments:',
    '- Copy anything the user wrote out into the step that needs it, exactly as written: text in quotes, file names, paths, app names, destinations. Do not reword, correct, shorten or translate it.',
    '- Never invent an argument the user did not give. If a step cannot be filled from the request, leave that step out.',
    '- Do not add a step that asks the user for something the request already states.',
    '- Steps run in order. After opening an app, use window.await for that app before typing or clicking in it.',
    `- ${useRules}`,
  ];
}

export class ModelGateway {
  constructor(
    private readonly catalog: GatewayCatalog,
    private readonly options: GatewayOptions,
  ) {}

  /**
   * @param wait   awaits a promise but gives up on an emergency stop (the engine's `untilHalted`).
   * @param check  an extra rule applied to the steps; returns a sentence about what is wrong, or null.
   */
  async plan(
    provider: IntelligenceProvider | null,
    request: string,
    signal: HaltSignal,
    wait: <T>(p: Promise<T>) => Promise<T>,
    check?: (steps: PlanStep[]) => string | null,
  ): Promise<GatewayOutcome> {
    if (!provider) return { kind: 'none', reason: 'no-provider', attempts: 0 };

    // What the model's own server says it can do is read before the route is chosen. Without this
    // the first request after launch would see only what was declared, and a model that supports
    // tool calling would be asked the plain way. Cached by the provider and bounded here, so a
    // slow or silent server costs a few seconds at most and never blocks a plan.
    const refreshed = provider.refreshCapabilities
      ? await wait(
          Promise.race([
            provider.refreshCapabilities().catch(() => null),
            new Promise<null>((r) => setTimeout(() => r(null), CAPABILITY_WAIT_MS)),
          ]),
        )
      : null;
    const caps: ModelCapabilities | null = refreshed ?? provider.capabilities?.() ?? null;
    let route: Route = chooseRoute(caps);
    const max = this.options.maxTools ?? MAX_TOOLS;
    let selected = selectSkills(this.catalog.available(), request, max);
    let discovered = false;
    let downgraded = false;
    let attempts = 0;
    let feedback = '';

    // Bounded: two asks, one discovery round, one step down a route.
    for (let guard = 0; guard < 5; guard += 1) {
      const built = this.build(route, request, selected, feedback);
      const reply = await wait(this.askOnce(provider, built.prompt, signal, built.tools, built.schema));

      if (reply.error === 'unsupported:constraints' && !downgraded) {
        downgraded = true;
        route = route === 'tools' && caps?.structuredOutput === 'yes' ? 'schema' : 'text';
        continue;
      }
      if (reply.error && !reply.text && !reply.calls.length) {
        return { kind: 'none', reason: 'unavailable', route, attempts, detail: reply.error };
      }

      // "I need something that is not on this list": answered once, by Atlas, from the router.
      const find = reply.calls.find((c) => c.name === DISCOVERY_TOOL);
      if (find && !discovered) {
        discovered = true;
        const need = isRecord(find.arguments) && typeof find.arguments.need === 'string' ? find.arguments.need : '';
        const more = selectSkills(this.catalog.available(), `${need} ${request}`, max);
        if (more.length) selected = more;
        continue;
      }

      attempts += 1;
      const read = this.interpret(route, reply, selected);

      if (read.kind === 'empty') return { kind: 'none', reason: 'no-steps', route, attempts };

      let problems: string[];
      let steps: PlanStep[] = [];
      let intent = 'ai';
      let confidence = 0.7;
      if (read.kind === 'unreadable') {
        problems = [read.detail];
      } else {
        ({ intent, confidence } = read);
        const checked = this.validate(read.steps);
        problems = checked.problems;
        steps = checked.steps;
        if (!problems.length && check) {
          const extra = check(steps);
          if (extra) problems = [extra];
        }
      }

      if (!problems.length) return { kind: 'steps', steps, intent, confidence, route, attempts };

      if (attempts >= MAX_ATTEMPTS) {
        return {
          kind: 'none',
          reason: read.kind === 'unreadable' ? 'unreadable' : 'invalid',
          route,
          attempts,
          detail: problems.join('; '),
        };
      }
      // One correction, saying exactly what was wrong. Never an action: only another reply.
      feedback = problems.join(' ');
    }
    return { kind: 'none', reason: 'invalid', route, attempts };
  }

  // ---- building the request -------------------------------------------------------------

  private build(
    route: Route,
    request: string,
    selected: readonly Skill[],
    feedback: string,
  ): { prompt: string; tools?: ModelTool[]; schema?: Record<string, unknown> } {
    const rules = argumentRules(this.options.useRules);
    const correction = feedback
      ? [
          '',
          `Your previous reply could not be used: ${feedback}`,
          'Reply again with a corrected plan. Use only the actions and arguments described, and nothing the user did not ask for.',
        ]
      : [];

    if (route === 'tools') {
      return {
        prompt: [
          'Turn the user request into tool calls, in the order they should run. Call only the tools provided.',
          ...rules,
          'If the request is not something these tools can do, call no tool and reply with one short sentence.',
          ...correction,
          '',
          `Request: ${request}`,
        ].join('\n'),
        tools: toolsFor(this.catalog.available(), selected),
      };
    }

    const lead = 'Turn the user request into a JSON plan. Reply with JSON only, no prose.';
    const shape = 'Schema: {"intent":string,"confidence":number,"steps":[{"skill":string,"args":object}]}';
    // The text route keeps the exact wording Atlas has always sent (the rule line reads
    // "<USE_RULES> For a request like that, …" as one sentence).
    const text = [
      lead,
      shape,
      ...rules.slice(0, -1),
      `${rules[rules.length - 1]} For a request like that, reply with a plan that has no steps.`,
      'You may ONLY use these actions:',
      route === 'text' ? this.catalog.catalog(request) : selected.map((s) => `- ${s.id}: ${s.description}`).join('\n'),
      ...correction,
      '',
      `Request: ${request}`,
    ].join('\n');
    return {
      prompt: text,
      ...(route === 'schema' ? { schema: planSchema(selected.map((s) => s.id)) } : {}),
    };
  }

  // ---- asking ---------------------------------------------------------------------------

  private askOnce(
    provider: IntelligenceProvider,
    prompt: string,
    signal: HaltSignal,
    tools?: ModelTool[],
    schema?: Record<string, unknown>,
  ): Promise<Reply> {
    return new Promise<Reply>((resolve) => {
      let done = false;
      const calls: ModelToolCall[] = [];
      const finish = (r: Reply) => {
        if (!done) {
          done = true;
          resolve(r);
        }
      };
      provider.ask(
        prompt,
        {
          onDelta: () => {},
          onToolCalls: (c) => calls.push(...c),
          onDone: (full) => finish({ text: full ?? '', calls }),
          onError: (reason) => finish({ text: null, calls, error: typeof reason === 'string' ? reason : String(reason) }),
        },
        {
          signal,
          ...(tools ? { tools } : {}),
          ...(schema ? { responseSchema: schema } : {}),
        },
      );
    });
  }

  // ---- reading the reply ------------------------------------------------------------------

  private interpret(
    route: Route,
    reply: Reply,
    selected: readonly Skill[],
  ):
    | { kind: 'empty' }
    | { kind: 'unreadable'; detail: string }
    | { kind: 'steps'; steps: Array<{ skill?: string; args?: unknown }>; intent: string; confidence: number } {
    const real = reply.calls.filter((c) => c.name !== DISCOVERY_TOOL);
    if (real.length) {
      const offered = new Set(selected.map((s) => s.id));
      const steps: Array<{ skill?: string; args?: unknown }> = [];
      for (const call of real) {
        const id = skillIdOfTool(call.name);
        // A tool that was not offered is a tool that does not exist as far as this reply goes:
        // being registered is not enough, because the model was never told it could.
        if (!offered.has(id)) return { kind: 'unreadable', detail: `“${call.name}” is not one of the tools you were given.` };
        let args: unknown = call.arguments;
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args);
          } catch {
            return { kind: 'unreadable', detail: `The arguments for “${call.name}” were not a JSON object.` };
          }
        }
        steps.push({ skill: id, args: isRecord(args) ? args : {} });
      }
      return { kind: 'steps', steps, intent: 'ai', confidence: 0.7 };
    }

    const text = (reply.text ?? '').trim();
    if (!text) return { kind: 'empty' };

    // JSON in whatever wrapping the model chose: a fence, a sentence first, trailing words.
    const objects = jsonObjectsIn(text).map((o) => o.value).filter(isRecord);
    const plan = objects.find((o) => Array.isArray(o.steps));
    if (plan) {
      const steps = plan.steps as unknown[];
      if (steps.length === 0) return { kind: 'empty' };
      return {
        kind: 'steps',
        steps: steps.map((s) => (isRecord(s) ? { skill: typeof s.skill === 'string' ? s.skill : undefined, args: s.args } : {})),
        intent: typeof plan.intent === 'string' && plan.intent ? plan.intent : 'ai',
        confidence: typeof plan.confidence === 'number' ? plan.confidence : 0.7,
      };
    }
    // A reply of plain words on the tool route is a refusal or an answer, not a plan; on the other
    // routes it is an unusable reply the model gets one chance to correct.
    if (route === 'tools') return { kind: 'empty' };
    if (objects.length === 0 && !/[{[]/.test(text)) return { kind: 'unreadable', detail: 'The reply was not a JSON plan.' };
    return { kind: 'unreadable', detail: 'The reply did not contain a "steps" list.' };
  }

  // ---- validation: every step, by the registry's own rules ----------------------------------

  private validate(raw: Array<{ skill?: string; args?: unknown }>): { steps: PlanStep[]; problems: string[] } {
    const steps: PlanStep[] = [];
    const problems: string[] = [];
    raw.forEach((s, i) => {
      const where = `Step ${i + 1}`;
      if (!s.skill) {
        problems.push(`${where} names no action.`);
        return;
      }
      const args = isRecord(s.args) ? (s.args as SkillArgs) : {};
      const result = this.catalog.validate(s.skill, args);
      if (!result.ok) {
        problems.push(`${where} (${s.skill}): ${result.error}`);
        return;
      }
      steps.push({ skill: s.skill, args: result.args });
    });
    // One bad step invalidates the whole plan: a half-understood instruction must never become a
    // half-run plan.
    return { steps: problems.length ? [] : steps, problems };
  }
}
