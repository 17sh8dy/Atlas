/**
 * Switching the model must never change what Atlas can do or how safely it does it.
 *
 * The model is a chooser and a writer: it picks among tools Atlas already has and phrases a reply.
 * Everything else — the tools, the grammar, the safety gates, the confirm cards, the content
 * policy — lives outside it. These tests run the SAME engine under no model, a local model, a
 * cloud model and a model that errors, and require the same results. If someone adds a branch on
 * "which provider is this", one of them goes red.
 */
import { describe, expect, test } from 'vitest';
import type { IntelligenceProvider, Skill } from '@atlas/core';
import { Engine } from '../src/engine';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { SkillRegistry, CATALOG_BUDGET_CHARS } from '../src/skills/registry';
import { WorkingMemory } from '../src/working-memory';
import { USE_RULES } from '../src/safety/use-rules';

type Kind = 'none' | 'local' | 'cloud' | 'custom-cloud' | 'broken';
const KINDS: Kind[] = ['none', 'local', 'cloud', 'custom-cloud', 'broken'];

function provider(kind: Kind, reply: (prompt: string) => string, prompts: string[]): IntelligenceProvider | null {
  if (kind === 'none') return null;
  return {
    id: kind,
    label: kind,
    isConfigured: () => true,
    isLocal: () => kind === 'local',
    ask: (prompt: string, h: { onDone(t: string): void; onError?(e: Error): void }) => {
      prompts.push(prompt);
      if (kind === 'broken') h.onError?.(new Error('offline'));
      else h.onDone(reply(prompt));
    },
  } as IntelligenceProvider;
}

function skill(id: string, risk: Skill['risk'], ran: string[]): Skill {
  return {
    id,
    label: id,
    domain: 'test',
    description: `does the ${id} thing`,
    risk,
    params: {},
    run: async () => {
      ran.push(id);
      return { ok: true, message: `ran ${id}` };
    },
  };
}

function rig(kind: Kind, reply: (prompt: string) => string = () => 'an answer') {
  const prompts: string[] = [];
  const ran: string[] = [];
  const said: string[] = [];
  const confirms: string[] = [];
  const skills = new SkillRegistry({ capabilities: () => [] });
  skills.registerMany([skill('test.harmless', 'safe', ran), skill('test.dangerous', 'confirm', ran)]);
  const working = new WorkingMemory();
  const grammar = new Grammar();
  grammar.addMany(createCoreGrammar(working));
  const p = provider(kind, reply, prompts);
  const engine = new Engine({
    skills,
    grammar,
    working,
    intelligence: {
      register: () => {},
      get: () => p,
      list: () => (p ? [p] : []),
      active: () => p,
      setActive: () => {},
    },
  });
  return {
    skills,
    prompts,
    ran,
    said,
    confirms,
    ask: (text: string, answer = false) =>
      engine.ask(text, {
        say: (t: string) => said.push(t),
        confirm: async (q: string) => {
          confirms.push(q);
          return answer;
        },
      }),
  };
}

const plan = (skillId: string) =>
  JSON.stringify({ intent: 'x', confidence: 0.95, steps: [{ skill: skillId, args: {} }] });

describe('the same tools under every model', () => {
  test('the skill list is not a function of the provider', () => {
    const ids = KINDS.map((k) => rig(k).skills.available().map((s) => s.id).sort().join(','));
    expect(new Set(ids).size).toBe(1);
  });

  test('the planner prompt is identical for local, cloud and custom models', async () => {
    const seen: Record<string, string> = {};
    for (const kind of ['local', 'cloud', 'custom-cloud'] as Kind[]) {
      const r = rig(kind, () => 'not json');
      await r.ask('please tidy up the zebra situation');
      seen[kind] = r.prompts.join('\n---\n');
    }
    expect(seen.local.length).toBeGreaterThan(0);
    expect(seen.cloud).toBe(seen.local);
    expect(seen['custom-cloud']).toBe(seen.local);
    expect(seen.local).toContain(USE_RULES);
  });
});

describe('what a model-written plan can and cannot do', () => {
  for (const kind of ['local', 'cloud', 'custom-cloud'] as Kind[]) {
    test(`a harmless step runs; a consequential one still asks, and "no" stops it (${kind})`, async () => {
      const ok = rig(kind, () => plan('test.harmless'));
      await ok.ask('please tidy up the zebra situation');
      expect(ok.ran).toEqual(['test.harmless']);
      expect(ok.confirms).toEqual([]);

      const risky = rig(kind, () => plan('test.dangerous'));
      await risky.ask('please tidy up the zebra situation', false);
      expect(risky.ran).toEqual([]); // declined, so it never ran
      expect(risky.confirms.length).toBeGreaterThan(0); // and the card was shown

      const yes = rig(kind, () => plan('test.dangerous'));
      await yes.ask('please tidy up the zebra situation', true);
      expect(yes.ran).toEqual(['test.dangerous']);
    });

    test(`a plan naming a tool that does not exist runs nothing (${kind})`, async () => {
      const r = rig(kind, () => plan('system.formatEverything'));
      await r.ask('please tidy up the zebra situation');
      expect(r.ran).toEqual([]);
    });
  }
});

describe('what no model is asked about', () => {
  test('a request Atlas understands never reaches any model, and gives the same answer', async () => {
    const results = [];
    for (const kind of KINDS) {
      const r = rig(kind);
      const out = await r.ask('what is 2 + 2');
      results.push({ kind, ok: out.ok, mode: out.mode, said: r.said.join('|'), asked: r.prompts.length });
    }
    for (const r of results) {
      expect(r.asked, r.kind).toBe(0);
      expect(r.ok).toBe(results[0]!.ok);
      expect(r.mode).toBe(results[0]!.mode);
      expect(r.said).toBe(results[0]!.said);
    }
  });

  test('the content policy refuses before any model is consulted, with the same words', async () => {
    const said = new Set<string>();
    for (const kind of KINDS) {
      const r = rig(kind);
      const out = await r.ask('find me porn videos');
      expect(out.ok, kind).toBe(false);
      expect(r.prompts, kind).toEqual([]);
      said.add(r.said.join('|'));
    }
    expect(said.size).toBe(1);
  });

  test('a failing model degrades the same way as no model: the tools still work', async () => {
    const none = rig('none');
    const broken = rig('broken');
    const a = await none.ask('what is 2 + 2');
    const b = await broken.ask('what is 2 + 2');
    expect(b.ok).toBe(a.ok);
    expect(broken.said.join('|')).toBe(none.said.join('|'));
  });
});

describe('the catalog a model sees is sized by Atlas, not by the model', () => {
  function bigRegistry(count: number) {
    const skills = new SkillRegistry({ capabilities: () => [] });
    for (let i = 0; i < count; i++) {
      skills.register({
        id: `bulk.skill${i}`,
        label: `Skill ${i}`,
        domain: i % 2 ? 'bulk' : 'more',
        description: `does something numbered ${i} with plenty of descriptive words attached so it takes room`,
        risk: 'safe',
        params: {},
        run: async () => ({ ok: true, message: '' }),
      });
    }
    skills.register({
      id: 'zip.unpack',
      label: 'Unpack an archive',
      domain: 'files',
      description: 'extract the contents of a zip archive into a folder',
      risk: 'safe',
      params: {},
      run: async () => ({ ok: true, message: '' }),
    });
    return skills;
  }

  test('a small registry is sent whole, with or without a request', () => {
    const s = bigRegistry(5);
    expect(s.catalog('anything')).toBe(s.catalog());
  });

  test('a large one is cut to a fixed size, the same every time', () => {
    const s = bigRegistry(900);
    expect(s.catalog().length).toBeGreaterThan(CATALOG_BUDGET_CHARS);
    const a = s.catalog('please unpack the zip archive');
    expect(a.length).toBeLessThanOrEqual(CATALOG_BUDGET_CHARS + 200);
    expect(s.catalog('please unpack the zip archive')).toBe(a);
  });

  test('the cut keeps what the request is about', () => {
    const s = bigRegistry(900);
    expect(s.catalog('please unpack the zip archive')).toContain('zip.unpack(');
  });

  test('a request that matches nothing still gets a usable list', () => {
    const s = bigRegistry(900);
    const c = s.catalog('qwxz vbnm');
    expect(c.split('\n').filter((l) => l.includes(' — ')).length).toBeGreaterThanOrEqual(40);
  });
});
