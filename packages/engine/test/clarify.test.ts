/**
 * Asking instead of guessing.
 *
 * "Open Steam and open a game" names one app and then no game at all. Before
 * this, Atlas read the whole sentence as one app called "steam and open a
 * game" and launched whatever its fuzzy match liked best. Now the two halves
 * are separate steps, the second one is recognised as too vague to run, and
 * Atlas asks — with choices, and the original request kept intact.
 *
 * Two layers: the pure pieces (what to ask, what an answer means), and the
 * whole path through the real Engine, executor and `app.open` skill, checking
 * above all that a vague request launches *nothing* until it is answered.
 */
import { describe, expect, test } from 'vitest';
import type { Clarification, ClarifyAnswer, Platform } from '@atlas/core';
import { Engine, type EngineIO } from '../src/engine';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import {
  CHOICE,
  buildClarification,
  explainInText,
  parseValues,
  resolveAnswer,
} from '../src/planner/clarify';
import { createCoreSkills } from '../src/skills/core-skills';
import { readVagueTarget } from '../src/skills/vague';
import { SkillRegistry } from '../src/skills/registry';
import { WorkingMemory } from '../src/working-memory';

// ---------------------------------------------------------------------------
// the pure pieces
// ---------------------------------------------------------------------------

describe('readVagueTarget — what counts as too vague', () => {
  test.each([
    ['game', 'game', 'What do you mean by “open a game”?'],
    ['a game', 'game', 'What do you mean by “open a game”?'],
    ['some game', 'game', 'What do you mean by “open a game”?'],
    ['any game', 'game', 'What do you mean by “open a game”?'],
    ['an app', 'app', 'What do you mean by “open an app”?'],
    ['the program', 'app', 'What do you mean by “open a program”?'],
    ['an application', 'app', 'What do you mean by “open an application”?'],
    ['software', 'app', 'What do you mean by “open software”?'],
    ['games', 'game', 'What do you mean by “open games”?'],
    ['something', 'app', 'What would you like me to open?'],
    ['anything', 'app', 'What would you like me to open?'],
    ['A GAME.', 'game', 'What do you mean by “open a game”?'],
  ])('%s', (name, noun, question) => {
    expect(readVagueTarget(name)).toEqual({ noun, question });
  });

  test.each([
    'steam',
    'Steam',
    'discord',
    'a game called Hades',
    'hades',
    'game bar',
    'a random game',
    'my game launcher',
    'chrome and firefox',
    '',
    'it',
  ])('%s is a name, not a kind of thing', (name) => {
    expect(readVagueTarget(name)).toBeNull();
  });
});

describe('buildClarification', () => {
  const need = { param: 'name', noun: 'game', question: 'What do you mean?' };

  test('offers the four options, in a fixed order', () => {
    const c = buildClarification(need, ['open Steam']);
    expect(c.question).toBe('What do you mean?');
    expect(c.choices.map((x) => x.id)).toEqual([
      CHOICE.specific,
      CHOICE.several,
      CHOICE.skip,
      CHOICE.other,
    ]);
    expect(c.choices.map((x) => x.label)).toEqual([
      'Tell me a specific game',
      'Tell me several games',
      'Just open Steam',
      'Something else',
    ]);
  });

  test('the two typing options carry an input, the other two do not', () => {
    const c = buildClarification(need, ['open Steam']);
    expect(c.choices[0]!.input).toEqual({ placeholder: 'Which game?' });
    expect(c.choices[1]!.input).toEqual({ placeholder: 'games, separated by commas', many: true });
    expect(c.choices[2]!.input).toBeUndefined();
    expect(c.choices[3]!.input).toBeUndefined();
  });

  test('with nothing done before, the fall-back slot is a plain way out', () => {
    expect(buildClarification(need, []).choices[2]!.label).toBe('Never mind');
  });

  test('several earlier steps are all named', () => {
    expect(buildClarification(need, ['open Steam', 'open Discord']).choices[2]!.label).toBe(
      'Just open Steam and open Discord',
    );
  });

  test('a need that takes one thing offers no "several"', () => {
    const c = buildClarification({ ...need, many: false }, []);
    expect(c.choices.map((x) => x.id)).toEqual([CHOICE.specific, CHOICE.skip, CHOICE.other]);
  });

  test('plurals are right for nouns that end oddly', () => {
    const c = (noun: string) => buildClarification({ ...need, noun }, []).choices[1]!.label;
    expect(c('box')).toBe('Tell me several boxes');
    expect(c('library')).toBe('Tell me several libraries');
    expect(c('app')).toBe('Tell me several apps');
  });

  test('in words, for a surface that cannot show choices', () => {
    const text = explainInText(buildClarification(need, ['open Steam']));
    expect(text).toContain('What do you mean?');
    expect(text).toContain('1. Tell me a specific game');
    expect(text).toContain('3. Just open Steam');
    expect(text).toContain('4. Something else');
  });
});

describe('parseValues', () => {
  test('one value is one value, with quotes taken off', () => {
    expect(parseValues('  Hades ', false)).toEqual(['Hades']);
    expect(parseValues('"Hades"', false)).toEqual(['Hades']);
  });

  test('several are split on commas, semicolons and lines', () => {
    expect(parseValues('Hades, Celeste; Hollow Knight\nStardew Valley', true)).toEqual([
      'Hades',
      'Celeste',
      'Hollow Knight',
      'Stardew Valley',
    ]);
  });

  test('the word "and" does NOT split — names contain it', () => {
    expect(parseValues('Ratchet and Clank', true)).toEqual(['Ratchet and Clank']);
  });

  test('empty pieces and repeats are dropped, order kept', () => {
    expect(parseValues('Hades,, hades , Celeste,', true)).toEqual(['Hades', 'Celeste']);
    expect(parseValues('   ', true)).toEqual([]);
    expect(parseValues('', false)).toEqual([]);
  });

  test('asked for one value, a comma is part of it', () => {
    expect(parseValues('Hades, Celeste', false)).toEqual(['Hades, Celeste']);
  });
});

describe('resolveAnswer', () => {
  const need = { param: 'name', noun: 'game', question: 'q' };

  test('typed text fills the gap', () => {
    expect(resolveAnswer(need, { kind: 'text', text: 'Hades', many: false })).toEqual({
      action: 'fill',
      values: ['Hades'],
    });
  });

  test('several typed values fill it several times', () => {
    expect(resolveAnswer(need, { kind: 'text', text: 'Hades, Celeste', many: true })).toEqual({
      action: 'fill',
      values: ['Hades', 'Celeste'],
    });
  });

  test('a need that takes one thing never expands, even if asked to', () => {
    expect(
      resolveAnswer({ ...need, many: false }, { kind: 'text', text: 'a, b', many: true }),
    ).toEqual({ action: 'fill', values: ['a, b'] });
  });

  test('skip drops just that part; "something else" cancels; walking away cancels', () => {
    expect(resolveAnswer(need, { kind: 'choice', id: CHOICE.skip })).toEqual({ action: 'skip' });
    expect(resolveAnswer(need, { kind: 'choice', id: CHOICE.other })).toEqual({
      action: 'cancel',
      because: 'other',
    });
    expect(resolveAnswer(need, { kind: 'cancelled' })).toEqual({
      action: 'cancel',
      because: 'cancelled',
    });
  });

  test('typing nothing is not an answer', () => {
    expect(resolveAnswer(need, { kind: 'text', text: '   ', many: false })).toEqual({
      action: 'cancel',
      because: 'cancelled',
    });
  });
});

// ---------------------------------------------------------------------------
// the whole path
// ---------------------------------------------------------------------------

const APPS = [
  { id: 'steam', name: 'Steam', target: 'steam' },
  { id: 'hades', name: 'Hades', target: 'hades' },
  { id: 'celeste', name: 'Celeste', target: 'celeste' },
  // the thing a careless fuzzy match would launch for "game"
  { id: 'gamebar', name: 'Xbox Game Bar', target: 'gamebar' },
  { id: 'discord', name: 'Discord', target: 'discord' },
];

function rig(answers: Array<ClarifyAnswer | ((q: Clarification) => ClarifyAnswer)>) {
  const launched: string[] = [];
  const said: string[] = [];
  const asked: Clarification[] = [];
  const confirms: string[] = [];
  const foldersCreated: string[] = [];
  const queue = [...answers];

  const platform = {
    id: 'test',
    capabilities: async () => ['apps', 'fs'],
    listApps: async () => APPS,
    launchApp: async (id: string) => {
      launched.push(id);
      return true;
    },
    createFolder: async (path: string) => {
      foldersCreated.push(path);
      return true;
    },
  } as unknown as Platform;

  const skills = new SkillRegistry({ capabilities: () => ['apps', 'fs'] });
  skills.registerMany(createCoreSkills(platform, {} as never, skills));
  const working = new WorkingMemory();
  const grammar = new Grammar();
  grammar.addMany(createCoreGrammar(working));
  grammar.addMany(createExtraGrammar());
  const engine = new Engine({ skills, grammar, working });

  const io = (withClarify: boolean): EngineIO => ({
    say: (t) => said.push(t),
    confirm: async (q) => {
      confirms.push(q);
      return true;
    },
    ...(withClarify
      ? {
          clarify: async (q: Clarification) => {
            asked.push(q);
            const next = queue.shift() ?? ({ kind: 'cancelled' } as ClarifyAnswer);
            return typeof next === 'function' ? next(q) : next;
          },
        }
      : {}),
  });

  return {
    launched,
    said,
    asked,
    confirms,
    foldersCreated,
    engine,
    ask: (text: string, withClarify = true) => engine.ask(text, io(withClarify)),
    run: (plan: Parameters<Engine['run']>[0]) => engine.run(plan, io(true)),
  };
}

describe('your request: "Open Steam and open a game"', () => {
  test('asks BEFORE anything runs — Steam is not opened while the question is open', async () => {
    let launchedWhenAsked: string[] | null = null;
    const r = rig([
      () => {
        // the moment the question is on screen: has anything happened yet?
        launchedWhenAsked = [...r.launched];
        return { kind: 'cancelled' };
      },
    ]);
    await r.ask('Open Steam and open a game');
    expect(launchedWhenAsked).toEqual([]);
  });

  test('asks what you mean, with the four options, and launches nothing if you walk away', async () => {
    const r = rig([{ kind: 'cancelled' }]);
    await r.ask('Open Steam and open a game');

    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]!.question).toBe('What do you mean by “open a game”?');
    expect(r.asked[0]!.choices.map((c) => c.label)).toEqual([
      'Tell me a specific game',
      'Tell me several games',
      'Just open Steam',
      'Something else',
    ]);
    // The question exists to learn what you want; until then, nothing is done
    expect(r.launched).toEqual([]);
    expect(r.launched).not.toContain('gamebar');
  });

  test('a specific game: the answer completes the request and it carries straight on', async () => {
    const r = rig([{ kind: 'text', text: 'Hades', many: false }]);
    const out = (await r.ask('Open Steam and open a game')) as { ok: boolean; mode: string };
    expect(r.launched).toEqual(['steam', 'hades']);
    expect(out).toMatchObject({ ok: true, mode: 'command' });
    expect(r.said.join(' ')).toMatch(/Opening Hades/);
  });

  test('several games: each is opened, in the order given, after Steam', async () => {
    const r = rig([{ kind: 'text', text: 'Hades, Celeste', many: true }]);
    await r.ask('Open Steam and open a game');
    expect(r.launched).toEqual(['steam', 'hades', 'celeste']);
  });

  test('"Just open Steam": the rest is left out, Steam stays open, and the plan counts as done', async () => {
    const r = rig([{ kind: 'choice', id: CHOICE.skip }]);
    const out = (await r.ask('Open Steam and open a game')) as { ok: boolean };
    // the choice is made first; only then does Steam open, and nothing else does
    expect(r.launched).toEqual(['steam']);
    expect(out.ok).toBe(true);
  });

  test('"Something else": stops, and says to tell it what you would like', async () => {
    const r = rig([{ kind: 'choice', id: CHOICE.other }]);
    await r.ask('Open Steam and open a game');
    expect(r.launched).toEqual([]);
    expect(r.said.join(' ')).toMatch(/tell me what you.d like instead/i);
  });

  test('walking away leaves things alone', async () => {
    const r = rig([{ kind: 'cancelled' }]);
    await r.ask('Open Steam and open a game');
    expect(r.launched).toEqual([]);
    expect(r.said.join(' ')).toMatch(/left alone/i);
  });

  test('an answer that is still vague is asked about again, then Atlas stops rather than guess', async () => {
    const vague = { kind: 'text', text: 'a game', many: false } as const;
    const r = rig([vague, vague, vague, vague, vague]);
    await r.ask('Open Steam and open a game');
    // four tries, then it gives up instead of running on a guess
    expect(r.asked).toHaveLength(4);
    expect(r.launched).toEqual([]);
    expect(r.launched).not.toContain('gamebar');
  });

  test('a vague answer followed by a real one completes it', async () => {
    const r = rig([
      { kind: 'text', text: 'a game', many: false },
      { kind: 'text', text: 'Celeste', many: false },
    ]);
    await r.ask('Open Steam and open a game');
    expect(r.launched).toEqual(['steam', 'celeste']);
  });
});

describe('it only asks when it has to', () => {
  test('a request that names everything is not questioned', async () => {
    const r = rig([]);
    await r.ask('Open Steam and open Hades');
    expect(r.asked).toEqual([]);
    expect(r.launched).toEqual(['steam', 'hades']);
  });

  test('a single clear request is not questioned', async () => {
    const r = rig([]);
    await r.ask('open discord');
    expect(r.asked).toEqual([]);
    expect(r.launched).toEqual(['discord']);
  });

  test('two apps named together are still one launch, as before', async () => {
    const r = rig([]);
    await r.ask('open steam and discord');
    expect(r.asked).toEqual([]);
  });

  test('"open a game" on its own asks, with a plain way out instead of "Just …"', async () => {
    const r = rig([{ kind: 'cancelled' }]);
    await r.ask('open a game');
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]!.choices[2]!.label).toBe('Never mind');
    expect(r.launched).toEqual([]);
  });
});

describe('a surface that cannot ask', () => {
  test('says the question in words and stops — it does not guess', async () => {
    const r = rig([]);
    await r.ask('Open Steam and open a game', false);
    expect(r.launched).toEqual([]);
    const said = r.said.join('\n');
    expect(said).toContain('What do you mean by “open a game”?');
    expect(said).toContain('1. Tell me a specific game');
  });
});

describe('it composes with the confirmation flow', () => {
  test('a missing required detail is asked for, and the completed step is then confirmed as usual', async () => {
    const r = rig([{ kind: 'text', text: 'D:\\Dev\\Atlas\\Answered', many: false }]);
    // a plan with a consequential step whose only argument is missing
    await r.run({
      source: 'grammar',
      intent: 'test',
      confidence: 1,
      steps: [{ skill: 'files.createFolder', args: {} }],
    });
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]!.question).toMatch(/Where should I create the folder/);
    expect(r.asked[0]!.choices[0]!.label).toBe('Tell me the name and where');
    // the answer completed the step, and the step then went through its normal gate
    expect(r.confirms).toHaveLength(1);
    expect(r.foldersCreated).toEqual(['D:\\Dev\\Atlas\\Answered']);
  });

  test('declining that confirmation still stops it: asking never bypasses the risk gate', async () => {
    const r = rig([{ kind: 'text', text: 'D:\\Dev\\Atlas\\Answered', many: false }]);
    const platformIo: EngineIO = {
      say: () => {},
      confirm: async () => false,
      clarify: async () => ({ kind: 'text', text: 'D:\\Dev\\Atlas\\Answered', many: false }),
    };
    await r.engine.run(
      {
        source: 'grammar',
        intent: 'test',
        confidence: 1,
        steps: [{ skill: 'files.createFolder', args: {} }],
      },
      platformIo,
    );
    expect(r.foldersCreated).toEqual([]);
  });
});

describe('the settled plan is what is approved and run', () => {
  test('the questions come before the announcement of what is about to happen', async () => {
    const order: string[] = [];
    const r = rig([
      () => {
        order.push('asked');
        return { kind: 'text', text: 'Hades', many: false };
      },
    ]);
    const io: EngineIO = {
      say: (t) => order.push(`said:${t}`),
      confirm: async () => true,
      clarify: async (q) => {
        const next = { kind: 'text', text: 'Hades', many: false } as const;
        order.push(`asked:${q.question}`);
        return next;
      },
    };
    await r.engine.ask('Open Steam and open a game', io);
    const asked = order.findIndex((x) => x.startsWith('asked:'));
    const announced = order.findIndex((x) => x.startsWith('said:Right'));
    expect(asked).toBeGreaterThanOrEqual(0);
    // "Right — open …, then open …" describes the plan that will actually run,
    // so it is said only once the plan is settled
    expect(announced).toBeGreaterThan(asked);
  });

  test('what you type is screened like anything else — an answer is not a way around the policy', async () => {
    // the policy refuses explicit destinations; the answer supplies one
    const r = rig([{ kind: 'text', text: 'porn', many: false }]);
    await r.ask('Open Steam and open a game');
    // refused by the content policy, and before Steam opened: the whole settled plan is screened
    expect(r.said.join(' ')).toMatch(/I don't search for, open, or play/);
    expect(r.launched).toEqual([]);
  });
});
