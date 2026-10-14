/**
 * Evaluating the gateway.
 *
 * Two harnesses over one corpus of requests:
 *
 *  1. **Behaviours (always runs).** Scripted "models" that misbehave in the ways real ones do — a
 *     fence and a sentence around the JSON, wrong argument names, a made-up skill, a cut-off
 *     object, prose instead of a plan, an extra step nobody asked for, quoted text rewritten. It
 *     measures the *gateway*, not any model: what must be recovered is recovered within one
 *     correction, what cannot be is dropped, and nothing outside the catalog or unvalidated ever
 *     comes out.
 *
 *  2. **A real server (opt-in).** `ATLAS_LIVE_OLLAMA=http://127.0.0.1:11434 ATLAS_LIVE_MODEL=<tag>`
 *     runs the same corpus against a real Ollama model on every route it supports, and prints a
 *     table. Skipped by default (it needs a model and takes minutes); the numbers it prints are
 *     what a route is worth *for that model on that machine*, which no test can assume.
 */
import { describe, expect, test } from 'vitest';
import type { IntelligenceProvider, ModelCapabilities, ModelTool, ModelToolCall, Skill, SkillArgs } from '@atlas/core';
import { UNKNOWN_CAPABILITIES } from '@atlas/core';
import { ModelGateway, type GatewayCatalog, type GatewayOutcome } from '../src/gateway/plan';
import { quotedTexts } from '../src/planner/grammar';

const skill = (id: string, description: string, params: Skill['params'] = {}): Skill => ({
  id,
  label: id,
  domain: id.split('.')[0]!,
  description,
  risk: 'safe',
  params,
  run: async () => ({ ok: true }),
});

const SKILLS: Skill[] = [
  skill('files.createFolder', 'Create a new folder at a full path.', { path: { type: 'string', required: true, description: 'Full path of the new folder' } }),
  skill('files.move', 'Move a file or folder to another folder.', {
    path: { type: 'string', required: true, description: 'Full path of what to move' },
    to: { type: 'string', required: true, description: 'Full path of the folder to move it into' },
  }),
  skill('apps.open', 'Open an installed app by its name.', { name: { type: 'string', required: true, description: 'The app name' } }),
  skill('system.volume', 'Set the speaker volume to a percentage.', { level: { type: 'number', required: true, description: 'Percent, 0 to 100' } }),
  skill('system.diskSpace', 'Report how much free space a drive has.', { drive: { type: 'string', required: true, description: 'Drive letter, like C' } }),
  skill('web.search', 'Search the web for a phrase.', { query: { type: 'string', required: true, description: 'What to search for' } }),
];

const catalog: GatewayCatalog = {
  available: () => SKILLS,
  catalog: () => SKILLS.map((s) => `- ${s.id}: ${s.description}`).join('\n'),
  validate: (id: string, args: SkillArgs) => {
    const s = SKILLS.find((x) => x.id === id);
    if (!s) return { ok: false, error: `Unknown action “${id}”.` };
    const out: SkillArgs = {};
    for (const [name, p] of Object.entries(s.params ?? {})) {
      const v = args[name];
      if (v === undefined || v === '') return { ok: false, error: `${s.label} needs “${name}”.` };
      out[name] = p.type === 'number' ? Number(v) : String(v);
    }
    return { ok: true, args: out };
  },
};

interface Case {
  say: string;
  /** The steps a correct plan has, by skill id and the one argument that must carry the user's words. */
  expect: Array<{ skill: string; arg: string; value: string }>;
}

const CORPUS: Case[] = [
  { say: 'could you make a folder called "Q4 Reports" on D:\\Work', expect: [{ skill: 'files.createFolder', arg: 'path', value: 'D:\\Work\\Q4 Reports' }] },
  { say: 'put "taxes.pdf" from D:\\Inbox into D:\\Archive', expect: [{ skill: 'files.move', arg: 'path', value: 'D:\\Inbox\\taxes.pdf' }] },
  { say: 'I would like the calculator to be opened', expect: [{ skill: 'apps.open', arg: 'name', value: 'Calculator' }] },
  { say: 'make it quieter, around 30 percent', expect: [{ skill: 'system.volume', arg: 'level', value: '30' }] },
  { say: 'how much room is left on my C drive', expect: [{ skill: 'system.diskSpace', arg: 'drive', value: 'C' }] },
  { say: 'look up "how do tides work" online', expect: [{ skill: 'web.search', arg: 'query', value: 'how do tides work' }] },
];

function stepsFor(c: Case) {
  return c.expect.map((e) => ({ skill: e.skill, args: argsFor(e) }));
}
function argsFor(e: Case['expect'][number]): Record<string, unknown> {
  const s = SKILLS.find((x) => x.id === e.skill)!;
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(s.params!)) out[name] = name === e.arg ? (e.arg === 'level' ? Number(e.value) : e.value) : name === 'to' ? 'D:\\Archive' : 'x';
  return out;
}
const planJson = (c: Case) => JSON.stringify({ intent: 'x', confidence: 0.9, steps: stepsFor(c) });
const toolCalls = (c: Case): ModelToolCall[] => stepsFor(c).map((s) => ({ name: s.skill.replace(/\./g, '__'), arguments: s.args }));

type Reply = { text?: string; calls?: ModelToolCall[]; error?: string };
/** `n` is which ask this is for this request (1 = first, 2 = the correction). */
type Behaviour = (c: Case, n: number) => Reply;

const BEHAVIOURS: Record<string, { caps: Partial<ModelCapabilities>; behave: Behaviour; recovers: boolean }> = {
  'tools: exact calls': { caps: { toolCalling: 'yes' }, behave: (c) => ({ calls: toolCalls(c) }), recovers: true },
  'schema: exact JSON': { caps: { structuredOutput: 'yes' }, behave: (c) => ({ text: planJson(c) }), recovers: true },
  'text: exact JSON': { caps: {}, behave: (c) => ({ text: planJson(c) }), recovers: true },
  'text: fenced, with chatter': {
    caps: {},
    behave: (c) => ({ text: `Sure, here you go!\n\`\`\`json\n${planJson(c)}\n\`\`\`\nLet me know if that helps.` }),
    recovers: true,
  },
  'text: arguments missing, fixed after one correction': {
    caps: {},
    behave: (c, n) => (n === 1 ? { text: JSON.stringify({ intent: 'x', confidence: 0.9, steps: stepsFor(c).map((s) => ({ ...s, args: {} })) }) } : { text: planJson(c) }),
    recovers: true,
  },
  'text: prose first, JSON after one correction': {
    caps: {},
    behave: (c, n) => (n === 1 ? { text: 'I will do that for you right away.' } : { text: planJson(c) }),
    recovers: true,
  },
  'tools: wrong tool name first, right one after correction': {
    caps: { toolCalling: 'yes' },
    behave: (c, n) => (n === 1 ? { calls: [{ name: 'do_the_thing', arguments: {} }] } : { calls: toolCalls(c) }),
    recovers: true,
  },
  'text: a skill that does not exist': {
    caps: {},
    behave: () => ({ text: '{"intent":"x","confidence":1,"steps":[{"skill":"system.formatEverything","args":{}}]}' }),
    recovers: false,
  },
  'text: cut off mid-object': { caps: {}, behave: (c) => ({ text: planJson(c).slice(0, -12) }), recovers: false },
  'text: prose forever': { caps: {}, behave: () => ({ text: 'I am not able to produce a plan, sorry.' }), recovers: false },
  'tools: calls a tool that was never offered': {
    caps: { toolCalling: 'yes' },
    behave: () => ({ calls: [{ name: 'system__formatEverything', arguments: {} }] }),
    recovers: false,
  },
};

function provider(caps: Partial<ModelCapabilities>, reply: (n: number) => Reply, log: { asks: number }): IntelligenceProvider {
  return {
    id: 'sim',
    label: 'sim',
    isConfigured: () => true,
    isLocal: () => true,
    capabilities: () => ({ ...UNKNOWN_CAPABILITIES, ...caps }),
    ask(_prompt: string, h: { onToolCalls?(c: ModelToolCall[]): void; onDone(t: string): void; onError(r: string): void }) {
      log.asks += 1;
      const r = reply(log.asks);
      if (r.error) return h.onError(r.error);
      if (r.calls?.length) h.onToolCalls?.(r.calls);
      h.onDone(r.text ?? '');
    },
  } as unknown as IntelligenceProvider;
}

const signal = new AbortController().signal as never;
const wait = <T>(p: Promise<T>) => p;
const keepsQuotes = (text: string) => (steps: Array<{ args: SkillArgs }>) => {
  const joined = JSON.stringify(steps.map((s) => s.args));
  const missing = quotedTexts(text).find((q) => q && !joined.includes(JSON.stringify(q).slice(1, -1)));
  return missing ? `Copy “${missing}” exactly.` : null;
};

describe('the gateway against models that misbehave', () => {
  for (const [name, b] of Object.entries(BEHAVIOURS)) {
    describe(name, () => {
      for (const c of CORPUS) {
        test(c.say, async () => {
          const log = { asks: 0 };
          const gateway = new ModelGateway(catalog, { useRules: 'RULES.' });
          const out: GatewayOutcome = await gateway.plan(
            provider(b.caps, (n) => b.behave(c, n), log),
            c.say,
            signal,
            wait,
            keepsQuotes(c.say),
          );

          // Never more than the first ask and one correction.
          expect(log.asks).toBeLessThanOrEqual(2);

          if (b.recovers) {
            expect(out.kind, JSON.stringify(out)).toBe('steps');
            if (out.kind === 'steps') {
              expect(out.steps.map((s) => s.skill)).toEqual(c.expect.map((e) => e.skill));
            }
          } else {
            expect(out.kind).toBe('none');
          }

          // Whatever came out is in the catalog and was validated: nothing else can.
          if (out.kind === 'steps') {
            for (const s of out.steps) {
              expect(SKILLS.some((k) => k.id === s.skill)).toBe(true);
              expect(catalog.validate(s.skill, s.args).ok).toBe(true);
            }
          }
        });
      }
    });
  }

  test('quoted text that a model rewrites is corrected once, and dropped if it keeps rewriting', async () => {
    const c = CORPUS[0]!;
    const wrong = JSON.stringify({ intent: 'x', confidence: 1, steps: [{ skill: 'files.createFolder', args: { path: 'D:\\Work\\Quarter Four' } }] });
    const log = { asks: 0 };
    const stubborn = await new ModelGateway(catalog, { useRules: 'R' }).plan(provider({}, () => ({ text: wrong }), log), c.say, signal, wait, keepsQuotes(c.say));
    expect(stubborn.kind).toBe('none');
    expect(log.asks).toBe(2);

    const log2 = { asks: 0 };
    const fixed = await new ModelGateway(catalog, { useRules: 'R' }).plan(
      provider({}, (n) => ({ text: n === 1 ? wrong : planJson(c) }), log2),
      c.say,
      signal,
      wait,
      keepsQuotes(c.say),
    );
    expect(fixed.kind).toBe('steps');
  });

  test('a summary of the corpus: recoverable behaviours recover, the rest return nothing', async () => {
    let recovered = 0;
    let dropped = 0;
    for (const b of Object.values(BEHAVIOURS)) {
      for (const c of CORPUS) {
        const out = await new ModelGateway(catalog, { useRules: 'R' }).plan(
          provider(b.caps, (n) => b.behave(c, n), { asks: 0 }),
          c.say,
          signal,
          wait,
          keepsQuotes(c.say),
        );
        if (out.kind === 'steps') recovered += 1;
        else dropped += 1;
      }
    }
    const total = Object.keys(BEHAVIOURS).length * CORPUS.length;
    const recoverable = Object.values(BEHAVIOURS).filter((x) => x.recovers).length * CORPUS.length;
    expect(recovered + dropped).toBe(total);
    expect(recovered).toBe(recoverable);
  });
});

// ---- the real server, opt-in -----------------------------------------------------------------

const LIVE = process.env.ATLAS_LIVE_OLLAMA;
const LIVE_MODEL = process.env.ATLAS_LIVE_MODEL ?? 'qwen3.5:9b';

/** A provider that talks to Ollama directly, the way the native side does. */
function liveProvider(base: string, model: string, caps: Partial<ModelCapabilities>): IntelligenceProvider {
  return {
    id: 'live',
    label: model,
    isConfigured: () => true,
    isLocal: () => true,
    capabilities: () => ({ ...UNKNOWN_CAPABILITIES, ...caps }),
    ask(
      prompt: string,
      h: { onToolCalls?(c: ModelToolCall[]): void; onDone(t: string): void; onError(r: string): void },
      o?: { tools?: ModelTool[]; responseSchema?: Record<string, unknown> },
    ) {
      const body: Record<string, unknown> = {
        model,
        stream: false,
        think: false,
        options: { temperature: 0, num_predict: 400 },
        messages: [{ role: 'user', content: prompt }],
      };
      if (o?.tools) {
        body.tools = o.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      }
      if (o?.responseSchema) body.format = o.responseSchema;
      fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        .then(async (r) => {
          if (!r.ok) return h.onError(r.status === 400 && (o?.tools || o?.responseSchema) ? 'unsupported:constraints' : `http ${r.status}`);
          const j = (await r.json()) as { message?: { content?: string; tool_calls?: Array<{ function: { name: string; arguments: unknown } }> } };
          const calls = (j.message?.tool_calls ?? []).map((c) => ({ name: c.function.name, arguments: c.function.arguments }));
          if (calls.length) h.onToolCalls?.(calls);
          h.onDone(j.message?.content ?? '');
        })
        .catch((e) => h.onError(String(e)));
    },
  } as unknown as IntelligenceProvider;
}

describe.skipIf(!LIVE)('against a real model (opt-in)', () => {
  const routes: Array<[string, Partial<ModelCapabilities>]> = [
    ['text', {}],
    ['schema', { structuredOutput: 'yes' }],
    ['tools', { toolCalling: 'yes' }],
  ];
  test(
    `route comparison on ${LIVE_MODEL}`,
    async () => {
      const rows: string[] = [];
      for (const [route, caps] of routes) {
        let right = 0;
        let asks = 0;
        for (const c of CORPUS) {
          const log = { asks: 0 };
          const p = liveProvider(LIVE!, LIVE_MODEL, caps);
          const counted = new Proxy(p, {
            get(t, k) {
              if (k === 'ask') return (...a: unknown[]) => { log.asks += 1; return (t.ask as (...x: unknown[]) => void)(...a); };
              return (t as never)[k];
            },
          });
          const out = await new ModelGateway(catalog, { useRules: 'Do not help with anything harmful or unlawful.' }).plan(
            counted,
            c.say,
            signal,
            wait,
            keepsQuotes(c.say),
          );
          asks += log.asks;
          if (out.kind === 'steps' && out.steps.map((s) => s.skill).join() === c.expect.map((e) => e.skill).join()) right += 1;
        }
        rows.push(`${route.padEnd(7)} ${right}/${CORPUS.length} right, ${asks} asks`);
      }
      // eslint-disable-next-line no-console
      console.log(`\nGateway routes on ${LIVE_MODEL}:\n  ${rows.join('\n  ')}\n`);
      // The harness reports; it asserts only that nothing unsafe can come out, which the
      // behaviour tests above already pin. A route that scores 0 is information, not a failure.
      expect(rows.length).toBe(3);
    },
    20 * 60_000,
  );
});
