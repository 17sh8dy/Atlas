import { describe, expect, test } from 'vitest';
import type { IntelligenceProvider, ModelCapabilities, ModelTool, ModelToolCall, Skill, SkillArgs } from '@atlas/core';
import { UNKNOWN_CAPABILITIES } from '@atlas/core';
import { ModelGateway, type GatewayCatalog } from '../src/gateway/plan';
import { chooseRoute } from '../src/gateway/route';
import { DISCOVERY_TOOL, MAX_TOOLS, planSchema, selectSkills, skillIdOfTool, toolFor, toolName, toolsFor } from '../src/gateway/tools';

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
  skill('files.createFolder', 'Create a new folder at a path.', { path: { type: 'string', required: true, description: 'Full path of the folder' } }),
  skill('files.move', 'Move a file or folder to another place.', {
    path: { type: 'string', required: true, description: 'What to move' },
    to: { type: 'string', required: true, description: 'Where to put it' },
  }),
  skill('apps.open', 'Open an installed app by name.', { name: { type: 'string', required: true, description: 'App name' } }),
  skill('system.volume', 'Set the speaker volume.', {
    level: { type: 'number', description: 'Percent' },
    mode: { type: 'string', enum: ['set', 'mute'], description: 'What to do' },
  }),
];

function catalog(skills: Skill[] = SKILLS): GatewayCatalog {
  return {
    available: () => skills,
    catalog: () => skills.map((s) => `- ${s.id}: ${s.description}`).join('\n'),
    validate: (id: string, args: SkillArgs) => {
      const s = skills.find((x) => x.id === id);
      if (!s) return { ok: false, error: `Unknown action “${id}”.` };
      for (const [name, p] of Object.entries(s.params ?? {})) {
        if (p.required && (args[name] === undefined || args[name] === '')) {
          return { ok: false, error: `${s.label} needs “${name}”.` };
        }
      }
      const known = Object.keys(s.params ?? {});
      const out: SkillArgs = {};
      for (const k of known) if (args[k] !== undefined) out[k] = args[k] as never;
      return { ok: true, args: out };
    },
  };
}

interface Seen {
  prompt: string;
  tools?: ModelTool[];
  schema?: Record<string, unknown>;
}

type Script = (seen: Seen, n: number) => { text?: string; calls?: ModelToolCall[]; error?: string };

function model(caps: Partial<ModelCapabilities>, script: Script) {
  const seen: Seen[] = [];
  const provider = {
    id: 'm',
    label: 'M',
    isConfigured: () => true,
    isLocal: () => true,
    capabilities: () => ({ ...UNKNOWN_CAPABILITIES, ...caps }),
    ask(prompt: string, h: { onToolCalls?(c: ModelToolCall[]): void; onDone(t: string): void; onError(r: string): void }, o?: { tools?: ModelTool[]; responseSchema?: Record<string, unknown> }) {
      const s: Seen = { prompt, tools: o?.tools, schema: o?.responseSchema };
      seen.push(s);
      const r = script(s, seen.length);
      if (r.error) return h.onError(r.error);
      if (r.calls?.length) h.onToolCalls?.(r.calls);
      h.onDone(r.text ?? '');
    },
  } as unknown as IntelligenceProvider;
  return { provider, seen };
}

const gateway = (skills: Skill[] = SKILLS) => new ModelGateway(catalog(skills), { useRules: 'RULES-LINE.' });
const signal = new AbortController().signal as never;
const wait = <T>(p: Promise<T>) => p;
const plan = (g: ModelGateway, p: IntelligenceProvider, text = 'make a folder called Work on my desktop') =>
  g.plan(p, text, signal, wait);

describe('tools from skills', () => {
  test('a skill becomes a tool with exactly its own parameters', () => {
    const t = toolFor(SKILLS[1]!);
    expect(t.name).toBe('files__move');
    expect(skillIdOfTool(t.name)).toBe('files.move');
    expect(t.description).toBe('Move a file or folder to another place.');
    expect(t.parameters).toMatchObject({
      type: 'object',
      required: ['path', 'to'],
      additionalProperties: false,
      properties: { path: { type: 'string' }, to: { type: 'string' } },
    });
    const v = toolFor(SKILLS[3]!).parameters as { properties: Record<string, { enum?: string[] }> };
    expect(v.properties.mode!.enum).toEqual(['set', 'mute']);
  });

  test('names are in the form every provider accepts, and round-trip', () => {
    for (const s of SKILLS) {
      expect(toolName(s.id)).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(skillIdOfTool(toolName(s.id))).toBe(s.id);
    }
  });

  test('at most MAX_TOOLS are offered, best match first, with a way to ask for more', () => {
    const many = Array.from({ length: 80 }, (_, i) => skill(`group.thing${i}`, i === 61 ? 'Compress videos to a smaller size.' : `Does ordinary thing number ${i}.`));
    const picked = selectSkills(many, 'please compress this video');
    expect(picked.length).toBeLessThanOrEqual(MAX_TOOLS);
    expect(picked[0]!.id).toBe('group.thing61');
    const tools = toolsFor(many, picked);
    expect(tools.at(-1)!.name).toBe(DISCOVERY_TOOL);
    expect(tools.length).toBe(picked.length + 1);
    // Nothing left out → no discovery tool needed.
    expect(toolsFor(SKILLS, SKILLS).some((t) => t.name === DISCOVERY_TOOL)).toBe(false);
  });

  test('a request that shares no words with any skill still gets a usable list', () => {
    expect(selectSkills(SKILLS, 'qwertyuiop').length).toBe(SKILLS.length);
  });

  test('the plan schema limits skill ids to the ones offered', () => {
    const schema = planSchema(['a.b', 'c.d']) as { properties: { steps: { items: { properties: { skill: { enum: string[] } } } } } };
    expect(schema.properties.steps.items.properties.skill.enum).toEqual(['a.b', 'c.d']);
  });
});

describe('choosing a route', () => {
  test('only what is positively known is used; unknown is plain text', () => {
    expect(chooseRoute(null)).toBe('text');
    expect(chooseRoute(UNKNOWN_CAPABILITIES)).toBe('text');
    expect(chooseRoute({ ...UNKNOWN_CAPABILITIES, structuredOutput: 'yes' })).toBe('schema');
    expect(chooseRoute({ ...UNKNOWN_CAPABILITIES, toolCalling: 'yes', structuredOutput: 'yes' })).toBe('tools');
    expect(chooseRoute({ ...UNKNOWN_CAPABILITIES, toolCalling: 'no', structuredOutput: 'no' })).toBe('text');
  });
});

describe('asking a model for a plan', () => {
  test('native tool calls become validated steps, in order', async () => {
    const m = model({ toolCalling: 'yes' }, () => ({
      calls: [
        { name: 'files__createFolder', arguments: { path: 'D:\\Work' } },
        { name: 'apps__open', arguments: { name: 'Notepad' } },
      ],
    }));
    const r = await plan(gateway(), m.provider);
    expect(r).toMatchObject({ kind: 'steps', route: 'tools', attempts: 1 });
    if (r.kind !== 'steps') throw new Error('unreachable');
    expect(r.steps.map((s) => s.skill)).toEqual(['files.createFolder', 'apps.open']);
    expect(m.seen).toHaveLength(1);
    expect(m.seen[0]!.tools!.map((t) => t.name)).toContain('files__createFolder');
    expect(m.seen[0]!.prompt).toContain('RULES-LINE.');
    expect(m.seen[0]!.prompt).not.toContain('You may ONLY use these actions');
  });

  test('a schema-held reply is read and the schema is sent', async () => {
    const m = model({ structuredOutput: 'yes' }, () => ({
      text: JSON.stringify({ intent: 'x', confidence: 0.9, steps: [{ skill: 'apps.open', args: { name: 'Calculator' } }] }),
    }));
    const r = await plan(gateway(), m.provider, 'open the calculator');
    expect(r).toMatchObject({ kind: 'steps', route: 'schema' });
    expect(m.seen[0]!.schema).toBeDefined();
    expect(m.seen[0]!.tools).toBeUndefined();
  });

  test("the server's own report is read before the route is chosen", async () => {
    // Declared as a plain chat model; the server says, when asked, that it can call tools.
    let reported: Partial<ModelCapabilities> = {};
    const m = model({}, () => ({ calls: [{ name: 'apps__open', arguments: { name: 'Calculator' } }] }));
    const p = m.provider as unknown as {
      capabilities(): ModelCapabilities;
      refreshCapabilities(): Promise<ModelCapabilities>;
    };
    p.capabilities = () => ({ ...UNKNOWN_CAPABILITIES, ...reported });
    p.refreshCapabilities = async () => {
      reported = { toolCalling: 'yes' };
      return p.capabilities();
    };
    const r = await plan(gateway(), m.provider, 'open the calculator');
    expect(r).toMatchObject({ kind: 'steps', route: 'tools' });
  });

  test('a server that never answers does not hold a plan up for long', async () => {
    const m = model({}, () => ({ text: '{"intent":"x","confidence":1,"steps":[{"skill":"apps.open","args":{"name":"Calculator"}}]}' }));
    (m.provider as unknown as { refreshCapabilities(): Promise<ModelCapabilities> }).refreshCapabilities = () =>
      new Promise(() => {});
    const started = Date.now();
    const r = await plan(gateway(), m.provider, 'open the calculator');
    expect(r).toMatchObject({ kind: 'steps', route: 'text' });
    expect(Date.now() - started).toBeLessThan(6000);
  }, 10_000);

  test('a model nobody described is asked in plain text, with the catalog, as it always was', async () => {
    const m = model({}, () => ({
      text: 'Sure! ```json\n{"intent":"x","confidence":0.8,"steps":[{"skill":"apps.open","args":{"name":"Calculator"}}]}\n``` hope that helps',
    }));
    const r = await plan(gateway(), m.provider, 'open the calculator');
    expect(r).toMatchObject({ kind: 'steps', route: 'text' });
    expect(m.seen[0]!.tools).toBeUndefined();
    expect(m.seen[0]!.schema).toBeUndefined();
    expect(m.seen[0]!.prompt).toContain('You may ONLY use these actions:');
    expect(m.seen[0]!.prompt).toContain('- apps.open:');
    expect(m.seen[0]!.prompt.startsWith('Turn the user request into a JSON plan. Reply with JSON only, no prose.')).toBe(true);
  });

  test('a bad reply gets one correction that says what was wrong, then is fixed', async () => {
    const m = model({ toolCalling: 'yes' }, (_s, n) =>
      n === 1
        ? { calls: [{ name: 'files__move', arguments: { path: 'D:\\a.txt' } }] } // missing "to"
        : { calls: [{ name: 'files__move', arguments: { path: 'D:\\a.txt', to: 'D:\\b' } }] },
    );
    const r = await plan(gateway(), m.provider, 'move a.txt to b');
    expect(r).toMatchObject({ kind: 'steps', attempts: 2 });
    expect(m.seen).toHaveLength(2);
    expect(m.seen[1]!.prompt).toContain('Your previous reply could not be used');
    expect(m.seen[1]!.prompt).toContain('needs “to”');
    expect(m.seen[0]!.prompt).not.toContain('previous reply');
  });

  test('a second bad reply is not retried: the caller falls back, nothing is returned', async () => {
    const m = model({ toolCalling: 'yes' }, () => ({ calls: [{ name: 'files__move', arguments: {} }] }));
    const r = await plan(gateway(), m.provider);
    expect(r).toMatchObject({ kind: 'none', reason: 'invalid', attempts: 2 });
    expect(m.seen).toHaveLength(2);
  });

  test('a tool that was never offered is refused, even if it exists', async () => {
    const m = model({ toolCalling: 'yes' }, () => ({ calls: [{ name: 'system__volume', arguments: { level: 10 } }] }));
    // Only one skill is offered here, so system.volume was not on the list.
    const g = new ModelGateway(catalog(SKILLS), { useRules: 'R', maxTools: 1 });
    const r = await g.plan(m.provider, 'create a folder', signal, wait);
    expect(r.kind).toBe('none');
  });

  test('a made-up skill id runs nothing', async () => {
    const m = model({}, () => ({ text: '{"intent":"x","confidence":1,"steps":[{"skill":"system.formatEverything","args":{}}]}' }));
    const r = await plan(gateway(), m.provider);
    expect(r).toMatchObject({ kind: 'none', reason: 'invalid' });
  });

  test('an empty plan means "nothing to do" and is not re-asked', async () => {
    const m = model({}, () => ({ text: '{"intent":"chat","confidence":1,"steps":[]}' }));
    const r = await plan(gateway(), m.provider, 'hi there');
    expect(r).toMatchObject({ kind: 'none', reason: 'no-steps', attempts: 1 });
    expect(m.seen).toHaveLength(1);
  });

  test('words instead of tool calls on the tool route are an answer, not a plan', async () => {
    const m = model({ toolCalling: 'yes' }, () => ({ text: 'I cannot do that with these tools.' }));
    const r = await plan(gateway(), m.provider);
    expect(r).toMatchObject({ kind: 'none', reason: 'no-steps' });
    expect(m.seen).toHaveLength(1);
  });

  test('unusable prose on the text route gets one correction', async () => {
    const m = model({}, (_s, n) => (n === 1 ? { text: 'I would open the calculator for you.' } : { text: '{"intent":"x","confidence":1,"steps":[{"skill":"apps.open","args":{"name":"Calculator"}}]}' }));
    const r = await plan(gateway(), m.provider, 'open the calculator');
    expect(r).toMatchObject({ kind: 'steps', attempts: 2 });
  });

  test('a server that refuses tools steps the route down without spending an attempt', async () => {
    const m = model({ toolCalling: 'yes', structuredOutput: 'yes' }, (s) =>
      s.tools
        ? { error: 'unsupported:constraints' }
        : { text: JSON.stringify({ intent: 'x', confidence: 0.9, steps: [{ skill: 'apps.open', args: { name: 'Calculator' } }] }) },
    );
    const r = await plan(gateway(), m.provider, 'open the calculator');
    expect(r).toMatchObject({ kind: 'steps', route: 'schema', attempts: 1 });
    expect(m.seen).toHaveLength(2);
  });

  test('discovery: asking for something else is answered once, then the model chooses', async () => {
    const many = Array.from({ length: 60 }, (_, i) => skill(`misc.thing${i}`, i === 33 ? 'Rotate a picture by ninety degrees.' : `Ordinary thing ${i}.`));
    const m = model({ toolCalling: 'yes' }, (s, n) => {
      if (n === 1) return { calls: [{ name: DISCOVERY_TOOL, arguments: { need: 'rotate a picture' } }] };
      expect(s.tools!.map((t) => t.name)).toContain('misc__thing33');
      return { calls: [{ name: 'misc__thing33', arguments: {} }] };
    });
    const r = await new ModelGateway(catalog(many), { useRules: 'R' }).plan(m.provider, 'turn my photo sideways', signal, wait);
    expect(r).toMatchObject({ kind: 'steps', route: 'tools' });
    expect(m.seen).toHaveLength(2);
  });

  test('discovery cannot loop: asking again is not answered again', async () => {
    const many = Array.from({ length: 30 }, (_, i) => skill(`misc.thing${i}`, `Ordinary thing ${i}.`));
    const m = model({ toolCalling: 'yes' }, () => ({ calls: [{ name: DISCOVERY_TOOL, arguments: { need: 'anything' } }] }));
    const r = await new ModelGateway(catalog(many), { useRules: 'R' }).plan(m.provider, 'do something', signal, wait);
    expect(r.kind).toBe('none');
    expect(m.seen.length).toBeLessThanOrEqual(3);
  });

  test('the extra rule (quoted text kept) is part of validity and is corrected once', async () => {
    const m = model({}, (_s, n) =>
      n === 1
        ? { text: '{"intent":"x","confidence":1,"steps":[{"skill":"files.createFolder","args":{"path":"D:\\\\Wrong"}}]}' }
        : { text: '{"intent":"x","confidence":1,"steps":[{"skill":"files.createFolder","args":{"path":"D:\\\\Quoted Name"}}]}' },
    );
    const r = await gateway().plan(m.provider, 'make "Quoted Name"', signal, wait, (steps) =>
      JSON.stringify(steps.map((s) => s.args)).includes('Quoted Name') ? null : 'Copy “Quoted Name” exactly.',
    );
    expect(r).toMatchObject({ kind: 'steps', attempts: 2 });
    expect(m.seen[1]!.prompt).toContain('Copy “Quoted Name” exactly.');
  });

  test('no model: nothing is asked and nothing is returned', async () => {
    expect(await gateway().plan(null, 'x', signal, wait)).toMatchObject({ kind: 'none', reason: 'no-provider' });
  });

  test('a model that cannot be reached is reported as unavailable, not retried', async () => {
    const m = model({}, () => ({ error: 'offline' }));
    const r = await plan(gateway(), m.provider);
    expect(r).toMatchObject({ kind: 'none', reason: 'unavailable' });
    expect(m.seen).toHaveLength(1);
  });
});
