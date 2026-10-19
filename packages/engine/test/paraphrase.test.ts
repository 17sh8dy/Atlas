/**
 * The paraphrase layer: unfamiliar SHAPES of requests the grammar already understands.
 *
 * Two kinds of claim: the pure function is safe (deterministic, faithful, never drops a "not"), and the
 * REAL engine uses it only after everything else failed and runs the result through the same rules.
 */
import { describe, expect, test } from 'vitest';
import type { Skill } from '@atlas/core';
import { Engine } from '../src/engine';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { paraphraseCandidates } from '../src/planner/paraphrase';
import { SkillRegistry } from '../src/skills/registry';
import { WorkingMemory } from '../src/working-memory';
import { understand } from './helpers/chain';

describe('paraphraseCandidates', () => {
  test('is deterministic and never returns the sentence it was given', () => {
    for (const t of ['Can you open Steam for me?', 'get steam running', 'would you mind opening steam', 'kill steam']) {
      expect(paraphraseCandidates(t)).toEqual(paraphraseCandidates(t));
      expect(paraphraseCandidates(t).map((c) => c.toLowerCase())).not.toContain(t.toLowerCase());
    }
  });

  test('rewrites the shapes people actually use', () => {
    expect(paraphraseCandidates('Can you open Steam for me?')[0]).toBe('open Steam');
    expect(paraphraseCandidates('get steam running')).toContain('open steam');
    expect(paraphraseCandidates('would you mind opening steam')).toContain('open steam');
    expect(paraphraseCandidates("I'd like steam open")).toContain('open steam');
    expect(paraphraseCandidates('okay so, open steam')).toContain('open steam');
    expect(paraphraseCandidates("where's my resume")).toContain('find my resume');
    expect(paraphraseCandidates('load steam')).toContain('open steam');
    expect(paraphraseCandidates('kill steam')).toContain('close steam');
    expect(paraphraseCandidates('get rid of old.txt')).toContain('delete old.txt');
  });

  test('never drops a word that changes the meaning', () => {
    for (const t of [
      "please don't open steam",
      'can you not close the window',
      'never delete my files',
      'open steam instead',
      'close all the windows',
      'could you open steam again',
    ]) {
      const keep = /\b(?:not|never|don't|instead|all|again)\b/i.exec(t)![0];
      for (const c of paraphraseCandidates(t)) {
        expect(c.toLowerCase(), `${t} → ${c}`).toContain(keep.toLowerCase());
      }
    }
  });

  test('does not guess a target that was not given', () => {
    expect(paraphraseCandidates('I want to play on steam, open it')).not.toContain('open it');
    expect(paraphraseCandidates('get it running')).not.toContain('open');
  });

  test('does not swap an ambiguous first word for another verb', () => {
    for (const w of ['get', 'set', 'make', 'keep', 'push']) {
      const out = paraphraseCandidates(`${w} the thing`);
      expect(out.some((c) => /^(?:open|close|find|delete|install)\b/i.test(c)), `${w} → ${out.join(' | ')}`).toBe(false);
    }
  });

  test('copes with nothing, nonsense and very long input', () => {
    expect(paraphraseCandidates('')).toEqual([]);
    expect(paraphraseCandidates('???')).toEqual([]);
    expect(paraphraseCandidates('x'.repeat(5000))).toEqual([]);
    expect(paraphraseCandidates('a b c d e f g h i j k l m n o p').length).toBeLessThanOrEqual(12);
  });
});

describe('measured against the grammar (the same chain the engine uses)', () => {
  const g = new Grammar();
  g.addMany(createCoreGrammar(new WorkingMemory()));
  g.addMany(createExtraGrammar());

  const STEAM = [
    'Open Steam.', 'Launch Steam.', 'Start Steam.', 'Can you open Steam for me?', 'please open steam', 'fire up steam',
    'get steam running', 'boot up steam', 'run steam', 'open the steam app', 'could you launch steam', 'would you mind opening steam',
    "I'd like steam open", 'okay so, open steam', 'load steam', 'how about opening steam', 'is it possible to open steam',
    'can you please launch steam?', 'hey atlas, start steam for me', 'go ahead and open steam', 'steam, open it up',
  ];

  test('the layer adds understanding and removes none', () => {
    const before = STEAM.filter((t) => understand(g, t, false).plan).length;
    const after = STEAM.filter((t) => understand(g, t, true).plan).length;
    expect(after).toBeGreaterThan(before);
    for (const t of STEAM) {
      const without = understand(g, t, false);
      const withIt = understand(g, t, true);
      // Anything that was understood before is understood the SAME way now.
      if (without.plan) expect(withIt.plan?.steps.map((s) => s.skill), t).toEqual(without.plan.steps.map((s) => s.skill));
    }
  });

  test('every wording that gets through reaches app.open for steam', () => {
    for (const t of STEAM) {
      const u = understand(g, t);
      if (!u.plan) continue;
      expect(u.plan.steps[0]!.skill, `${t} (via ${u.via})`).toBe('app.open');
      expect(JSON.stringify(u.plan.steps[0]!.args).toLowerCase(), t).toContain('steam');
    }
  });
});

describe('inside the real Engine', () => {
  function engineWithFakeOpen() {
    const opened: string[] = [];
    const open: Skill = {
      id: 'app.open',
      label: 'Open an app',
      icon: '•',
      domain: 'apps',
      description: 'Launch an installed application by name.',
      risk: 'safe',
      params: { name: { type: 'string', required: true, description: 'app name' } },
      async run(args) {
        opened.push(String(args.name));
        return { ok: true, message: `Opening ${String(args.name)}.` };
      },
    };
    const skills = new SkillRegistry({ capabilities: () => [] });
    skills.register(open);
    const working = new WorkingMemory();
    const grammar = new Grammar();
    grammar.addMany(createCoreGrammar(working));
    grammar.addMany(createExtraGrammar());
    const engine = new Engine({ skills, grammar, working, getExecutionMode: () => 'doIt' });
    const said: string[] = [];
    const io = { say: (t: string) => void said.push(t), confirm: async () => true, showResults: () => {} };
    return { engine, io, opened, said };
  }

  test('a rephrased request opens the app with no model involved', async () => {
    for (const t of ['Can you open Steam for me?', 'get steam running', 'would you mind opening steam', "I'd like steam open"]) {
      const { engine, io, opened } = engineWithFakeOpen();
      const out = await engine.ask(t, io);
      expect(out.mode, t).toBe('command');
      expect(opened.map((n) => n.toLowerCase()), t).toEqual(['steam']);
    }
  });

  test('a sentence already understood is not reinterpreted', async () => {
    const { engine, io, opened } = engineWithFakeOpen();
    await engine.ask('open steam', io);
    expect(opened).toEqual(['steam']);
  });

  test('an instruction with a "not" in it is left alone', async () => {
    const { engine, io, opened } = engineWithFakeOpen();
    await engine.ask("please don't open steam", io);
    expect(opened).toEqual([]);
  });
});
