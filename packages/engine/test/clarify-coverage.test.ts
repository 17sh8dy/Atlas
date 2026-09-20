/**
 * The question system across the board, not just for Steam.
 *
 * A survey of 49 vague requests found the system working for four. The rest
 * either dead-ended ("I didn't catch that") or — worse — went ahead on a junk
 * value: "close a window" asked to close a window called "a", "google it"
 * searched for "it". This file holds every one of those to the standard:
 *
 *   1. the right question is asked;
 *   2. NOTHING has run at the moment it is asked;
 *   3. the answer completes the request, and the *real* action is invoked with
 *      the right arguments (every action is real here; only its effect on the
 *      machine is recorded instead of performed).
 */
import { describe, expect, test } from 'vitest';
import type { Clarification, ClarifyAnswer, Platform, Skill } from '@atlas/core';
import { Engine, type EngineIO } from '../src/engine';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { SkillRegistry } from '../src/skills/registry';
import { createCoreSkills } from '../src/skills/core-skills';
import { createWebSearchSkills } from '../src/skills/web-search-skills';
import { createUtilitySkills } from '../src/skills/utility-skills';
import { createTextSkills } from '../src/skills/text-skills';
import { createCalcSkills } from '../src/skills/calc-skills';
import { createNotesSkills } from '../src/skills/notes-skills';
import { createOsSkills } from '../src/skills/os-skills';
import { createNetworkSkills } from '../src/skills/network-skills';
import { createServiceSkills } from '../src/skills/service-skills';
import { createEnvironmentSkills } from '../src/skills/environment-skills';
import { createStorageSkills } from '../src/skills/storage-skills';
import { createWindowSkills } from '../src/skills/window-skills';
import { createInputSkills } from '../src/skills/input-skills';
import { createUiaSkills } from '../src/skills/uia-skills';
import { createScreenSkills } from '../src/skills/screen-skills';
import { WorkingMemory } from '../src/working-memory';
import { durationSeconds, fullPath, pathOrNameInPlace, websiteAddress } from '../src/skills/asks';
import { isPlaceholder } from '../src/planner/clarify';

const ALL_CAPS = [
  'files',
  'fs',
  'apps',
  'system',
  'processes',
  'clipboard',
  'notifications',
  'os',
  'windows',
  'window-control',
  'input',
  'ui-automation',
  'screen',
  'network',
  'services',
  'environment',
  'storage',
  'devtools',
  'speech',
  'listening',
  'ai',
] as never[];

interface Call {
  id: string;
  args: Record<string, unknown>;
}

function rig() {
  const calls: Call[] = [];
  const said: string[] = [];
  const asked: Clarification[] = [];
  const confirms: string[] = [];
  const platform = {} as never as Platform;
  const skills = new SkillRegistry({ capabilities: () => ALL_CAPS });
  const memory = {} as never;
  skills.registerMany(createCoreSkills(platform, memory, skills));
  skills.registerMany(createWebSearchSkills(platform));
  skills.registerMany(createUtilitySkills());
  skills.registerMany(createTextSkills());
  skills.registerMany(createCalcSkills());
  skills.registerMany(createNotesSkills(memory));
  for (const f of [
    createOsSkills,
    createNetworkSkills,
    createServiceSkills,
    createEnvironmentSkills,
    createStorageSkills,
    createWindowSkills,
    createInputSkills,
    createUiaSkills,
    createScreenSkills,
  ]) {
    skills.registerMany((f as (p: never) => Skill[])(platform as never));
  }
  // Every action is real up to the moment it would touch the machine.
  for (const skill of skills.available()) {
    skill.run = async (args) => {
      calls.push({ id: skill.id, args: { ...args } });
      return { ok: true, message: 'ok' };
    };
  }

  const working = new WorkingMemory();
  const grammar = new Grammar();
  grammar.addMany(createCoreGrammar(working));
  grammar.addMany(createExtraGrammar());
  const engine = new Engine({ skills, grammar, working });

  return {
    calls,
    said,
    asked,
    confirms,
    engine,
    /** Run a plan directly, answering each question in turn. */
    async run(plan: Parameters<Engine['run']>[0], answers: ClarifyAnswer[] = []) {
      const queue = [...answers];
      await engine.run(plan, {
        say: (t) => said.push(t),
        confirm: async (q) => {
          confirms.push(q);
          return true;
        },
        clarify: async (q) => {
          asked.push(q);
          return queue.shift() ?? { kind: 'cancelled' };
        },
      });
    },
    /** Ask, answering each question from `answers` in turn; records what had run when it was asked. */
    async ask(text: string, answers: Array<ClarifyAnswer> = []) {
      const queue = [...answers];
      const ranWhenAsked: number[] = [];
      const io: EngineIO = {
        say: (t) => said.push(t),
        confirm: async (q) => {
          confirms.push(q);
          return true;
        },
        clarify: async (q) => {
          asked.push(q);
          ranWhenAsked.push(calls.length);
          return queue.shift() ?? { kind: 'cancelled' };
        },
      };
      await engine.ask(text, io);
      return { ranWhenAsked };
    },
  };
}

const text = (t: string, many = false): ClarifyAnswer => ({ kind: 'text', text: t, many });
const pick = (value: string): ClarifyAnswer => ({ kind: 'choice', id: `value:${value}` });

interface Case {
  say: string;
  question: RegExp;
  answers: ClarifyAnswer[];
  call: { id: string; args: Record<string, unknown> };
}

// ---------------------------------------------------------------------------

const CASES: Case[] = [
  // making things
  {
    say: 'create a folder',
    question: /Where should I create the folder/,
    answers: [text('Notes in D:\\Dev')],
    call: { id: 'files.createFolder', args: { path: 'D:\\Dev\\Notes' } },
  },
  {
    say: 'make a new folder',
    question: /Where should I create the folder/,
    answers: [text('D:\\Dev\\Projects')],
    call: { id: 'files.createFolder', args: { path: 'D:\\Dev\\Projects' } },
  },
  {
    say: 'create a file',
    question: /What should the file be called/,
    answers: [text('todo.txt in D:\\Dev')],
    call: { id: 'files.create', args: { path: 'D:\\Dev\\todo.txt' } },
  },
  {
    say: 'make a note',
    question: /What should the note say/,
    answers: [text('buy milk')],
    call: { id: 'notes.add', args: { text: 'buy milk' } },
  },
  {
    say: 'take a note',
    question: /What should the note say/,
    answers: [text('call the dentist')],
    call: { id: 'notes.add', args: { text: 'call the dentist' } },
  },
  {
    say: 'remind me',
    question: /What should I remind you about/,
    answers: [text('call mom')],
    call: { id: 'todo.add', args: { text: 'call mom' } },
  },
  {
    say: 'set a timer',
    question: /How long should the timer run/,
    answers: [text('10 minutes')],
    call: { id: 'time.timer', args: { seconds: 600 } },
  },
  // looking things up
  {
    say: 'search for something',
    question: /What should I search for/,
    answers: [text('rust tutorials')],
    call: { id: 'web.search', args: { query: 'rust tutorials' } },
  },
  {
    say: 'look something up',
    question: /What should I search for/,
    answers: [text('how tides work')],
    call: { id: 'web.search', args: { query: 'how tides work' } },
  },
  {
    say: 'google it',
    question: /What should I search for/,
    answers: [text('weather in Paris')],
    call: { id: 'web.search', args: { query: 'weather in Paris' } },
  },
  {
    say: 'play some music',
    question: /What would you like to play or watch/,
    answers: [text('lofi beats')],
    call: { id: 'web.searchYoutube', args: { query: 'lofi beats' } },
  },
  // windows: the junk-value cases
  {
    say: 'close a window',
    question: /Which window/,
    answers: [text('Notepad')],
    call: { id: 'window.close', args: { name: 'Notepad' } },
  },
  {
    say: 'minimize a window',
    question: /Which window/,
    answers: [text('Discord')],
    call: { id: 'window.minimize', args: { name: 'Discord' } },
  },
  {
    say: 'switch to a window',
    question: /Which window/,
    answers: [text('Chrome')],
    call: { id: 'window.focus', args: { name: 'Chrome' } },
  },
  // files
  {
    say: 'delete a file',
    question: /Which file should I delete/,
    answers: [text('D:\\Docs\\old.txt')],
    call: { id: 'files.delete', args: { path: 'D:\\Docs\\old.txt' } },
  },
  {
    say: 'find a file',
    question: /What is the file called/,
    answers: [text('budget')],
    call: { id: 'files.find', args: { query: 'budget' } },
  },
  {
    say: 'open a file',
    question: /What is the file called/,
    answers: [text('report')],
    call: { id: 'files.find', args: { query: 'report' } },
  },
  // apps and sites
  {
    say: 'open a website',
    question: /open a website/,
    answers: [text('youtube')],
    call: { id: 'app.open', args: { name: 'youtube' } },
  },
  // a chain: the browser is named, the site is what is missing
  {
    say: 'open chrome and go to a website',
    question: /Which website/,
    answers: [text('youtube')],
    call: { id: 'web.open', args: { url: 'https://www.youtube.com', browser: 'chrome' } },
  },
  {
    say: 'start an app',
    question: /open an app/,
    answers: [text('Discord')],
    call: { id: 'app.open', args: { name: 'Discord' } },
  },
  {
    say: 'launch a game',
    question: /open a game/,
    answers: [text('Hades')],
    call: { id: 'app.open', args: { name: 'Hades' } },
  },
  // "it" / "this" with nothing earlier to mean by it
  {
    say: 'close it',
    question: /Which window/,
    answers: [text('Notepad')],
    call: { id: 'window.close', args: { name: 'Notepad' } },
  },
  {
    say: 'close the app',
    question: /Which window/,
    answers: [text('Discord')],
    call: { id: 'window.close', args: { name: 'Discord' } },
  },
  {
    say: 'delete this',
    question: /Which file should I delete/,
    answers: [text('D:\\Docs\\old.txt')],
    call: { id: 'files.delete', args: { path: 'D:\\Docs\\old.txt' } },
  },
  // input and the machine
  {
    say: 'type something',
    question: /What should I type/,
    answers: [text('hello there')],
    call: { id: 'input.typeText', args: { text: 'hello there' } },
  },
  {
    say: 'turn the volume',
    question: /up or down/,
    answers: [pick('down')],
    call: { id: 'system.volume', args: { direction: 'down' } },
  },
];

describe('a vague request is asked about, not guessed at', () => {
  test.each(CASES.map((c) => [c.say, c] as const))('%s', async (_say, c) => {
    const r = rig();
    const { ranWhenAsked } = await r.ask(c.say, c.answers);

    // 1. the right question
    expect(r.asked.length).toBeGreaterThanOrEqual(1);
    expect(r.asked[0]!.question).toMatch(c.question);
    // 2. nothing had run when it was asked
    expect(ranWhenAsked[0]).toBe(0);
    // 3. the answer completed it, and the real action ran with the right arguments
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.id).toBe(c.call.id);
    expect(r.calls[0]!.args).toMatchObject(c.call.args);
  });

  test.each(CASES.map((c) => [c.say, c] as const))(
    '%s — walking away runs nothing',
    async (_say, c) => {
      const r = rig();
      await r.ask(c.say, [{ kind: 'cancelled' }]);
      expect(r.calls).toEqual([]);
    },
  );

  test.each(CASES.map((c) => [c.say, c] as const))(
    '%s — there is always a way out',
    async (_say, c) => {
      const r = rig();
      await r.ask(c.say, [{ kind: 'cancelled' }]);
      const labels = r.asked[0]!.choices.map((x) => x.label);
      expect(labels.at(-1)).toBe('Something else');
      expect(labels.some((l) => l === 'Never mind' || l.startsWith('Just '))).toBe(true);
    },
  );
});

describe('the junk-value cases are gone', () => {
  test('"close a window" no longer tries to close a window called "a"', async () => {
    const r = rig();
    await r.ask('close a window');
    expect(r.calls.some((c) => c.args.name === 'a')).toBe(false);
    expect(r.confirms).toEqual([]); // and no card offering to close it either
  });

  test('"google it" no longer searches for the word "it"', async () => {
    const r = rig();
    await r.ask('google it');
    expect(r.calls.some((c) => c.args.query === 'it')).toBe(false);
  });
});

describe('fixed choices become buttons', () => {
  test('volume offers exactly Up and Down, then the ways out', async () => {
    const r = rig();
    await r.ask('turn the volume', [{ kind: 'cancelled' }]);
    expect(r.asked[0]!.choices.map((c) => c.label)).toEqual([
      'Up',
      'Down',
      'Never mind',
      'Something else',
    ]);
    // and none of them asks for typing: an invented value would only be refused later
    expect(r.asked[0]!.choices.every((c) => !c.input)).toBe(true);
  });

  test('a typed answer that matches an option is accepted', async () => {
    const r = rig();
    await r.ask('turn the volume', [text('up')]);
    expect(r.calls[0]).toMatchObject({ id: 'system.volume', args: { direction: 'up' } });
  });

  test('a typed answer that matches nothing says what the choices are, and asks again', async () => {
    const r = rig();
    await r.ask('turn the volume', [text('sideways'), pick('up')]);
    expect(r.said.join(' ')).toMatch(/Pick one of: Up, Down/);
    expect(r.calls[0]).toMatchObject({ args: { direction: 'up' } });
  });

  test('the power options are the real ones, and a consequential choice still needs its confirmation', async () => {
    const r = rig();
    // the fixed set for this action, straight from its definition
    const power = r.engine.skills.get('system.power');
    expect(power?.params?.action?.enum).toEqual(['shutdown', 'restart', 'sign-out']);
    await r.run(
      {
        source: 'grammar',
        intent: 'test',
        confidence: 1,
        steps: [{ skill: 'system.power', args: {} }],
      },
      [pick('restart')],
    );
    expect(r.asked[0]!.choices.map((c) => c.label).slice(0, 3)).toEqual([
      'Shut down',
      'Restart',
      'Sign out',
    ]);
    // chosen by button, then still put to the person as the consequential action it is
    expect(r.confirms).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({ id: 'system.power', args: { action: 'restart' } });
  });

  test('the system tools are offered by their real names', async () => {
    const r = rig();
    await r.run(
      {
        source: 'grammar',
        intent: 'test',
        confidence: 1,
        steps: [{ skill: 'system.openTool', args: {} }],
      },
      [pick('task-manager')],
    );
    const labels = r.asked[0]!.choices.map((c) => c.label);
    expect(labels).toContain('Task Manager');
    expect(labels).toContain('Device Manager');
    expect(r.calls[0]).toMatchObject({ args: { tool: 'task-manager' } });
  });
});

describe('two details, asked one after the other', () => {
  test('rename a file: which file, then what to call it', async () => {
    const r = rig();
    await r.ask('rename a file', [text('D:\\Docs\\a.txt'), text('b.txt')]);
    expect(r.asked.map((q) => q.question)).toEqual([
      'Which file should I rename?',
      'What should it be called?',
    ]);
    expect(r.calls[0]).toMatchObject({
      id: 'files.rename',
      args: { path: 'D:\\Docs\\a.txt', newName: 'b.txt' },
    });
  });

  test('move a file: which file, then which folder', async () => {
    const r = rig();
    await r.ask('move a file', [text('D:\\Docs\\a.txt'), text('D:\\Archive')]);
    expect(r.calls[0]).toMatchObject({
      id: 'files.move',
      args: { path: 'D:\\Docs\\a.txt', destDir: 'D:\\Archive' },
    });
  });
});

describe('an answer that cannot be used is explained, then asked for again', () => {
  test('a timer length that is not a length of time', async () => {
    const r = rig();
    await r.ask('set a timer', [text('soon'), text('90 seconds')]);
    expect(r.said.join(' ')).toMatch(/length of time/);
    expect(r.calls[0]).toMatchObject({ id: 'time.timer', args: { seconds: 90 } });
  });

  test('a folder with no place is asked again with an example', async () => {
    const r = rig();
    await r.ask('create a folder', [text('Notes'), text('D:\\Dev\\Notes')]);
    expect(r.said.join(' ')).toMatch(/full path/);
    expect(r.calls[0]).toMatchObject({ args: { path: 'D:\\Dev\\Notes' } });
  });

  test('a file to delete that is not a full path is never guessed at', async () => {
    const r = rig();
    await r.ask('delete a file', [text('old.txt'), text('D:\\Docs\\old.txt')]);
    expect(r.said.join(' ')).toMatch(/full path/);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.args.path).toBe('D:\\Docs\\old.txt');
  });

  test('keeps asking a few times, then gives up rather than run on a guess', async () => {
    const r = rig();
    await r.ask('set a timer', [text('a'), text('b'), text('c'), text('d'), text('e')]);
    expect(r.calls).toEqual([]);
  });
});

describe('a consequential action is still confirmed after the question', () => {
  test('delete a file: asked which, then asked to confirm, then done', async () => {
    const r = rig();
    await r.ask('delete a file', [text('D:\\Docs\\old.txt')]);
    expect(r.confirms).toHaveLength(1);
    expect(r.calls).toHaveLength(1);
  });

  test('close a window: asked which, then asked to confirm', async () => {
    const r = rig();
    await r.ask('close a window', [text('Notepad')]);
    expect(r.confirms).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({ id: 'window.close', args: { name: 'Notepad' } });
  });
});

describe('requests that already say enough are left alone', () => {
  test.each([
    ['create a folder called Notes in D:\\Dev', 'files.createFolder'],
    ['remind me to call mom', 'todo.add'],
    ['search for rust tutorials', 'web.search'],
    ['open steam', 'app.open'],
    ['close the notepad window', 'window.close'],
    ['turn the volume up', 'system.volume'],
  ])('%s', async (say, id) => {
    const r = rig();
    await r.ask(say);
    expect(r.asked).toEqual([]);
    expect(r.calls.map((c) => c.id)).toContain(id);
  });
});

describe('polite and punctuated versions ask the same question', () => {
  test.each([
    'please create a folder',
    'can you create a folder?',
    'Could you make a folder for me',
    'create a folder please.',
  ])('%s', async (say) => {
    const r = rig();
    await r.ask(say, [{ kind: 'cancelled' }]);
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]!.question).toMatch(/Where should I create the folder/);
  });
});

// ---------------------------------------------------------------------------
// the small pieces
// ---------------------------------------------------------------------------

describe('durationSeconds', () => {
  test.each([
    ['10 minutes', '600'],
    ['10 min', '600'],
    ['90 seconds', '90'],
    ['1h 30m', '5400'],
    ['1 hour', '3600'],
    ['2 hours 15 minutes', '8100'],
    ['half an hour', '1800'],
    ['a quarter hour', '900'],
    ['an hour', '3600'],
    ['five minutes', '300'],
    ['for 20 minutes', '1200'],
    ['1:30', '90'],
    ['5', '300'], // a bare number is minutes
  ])('%s -> %s seconds', (input, want) => {
    expect(durationSeconds(input)).toBe(want);
  });

  test.each(['soon', 'a while', '', '0 minutes', '48 hours', 'banana minutes'])(
    '%s is not a usable length',
    (input) => {
      expect(durationSeconds(input)).toBeNull();
    },
  );
});

describe('paths and sites', () => {
  test('fullPath wants an absolute path', () => {
    expect(fullPath('D:\\Docs\\a.txt')).toBe('D:\\Docs\\a.txt');
    expect(fullPath('"D:\\Docs\\a.txt"')).toBe('D:\\Docs\\a.txt');
    expect(fullPath('/home/me/a.txt')).toBe('/home/me/a.txt');
    expect(fullPath('a.txt')).toBeNull();
    expect(fullPath('..\\a.txt')).toBeNull();
  });

  test('a name and a place, or a full path, both make a path', () => {
    expect(pathOrNameInPlace('Notes in D:\\Dev')).toBe('D:\\Dev\\Notes');
    expect(pathOrNameInPlace('D:\\Dev\\Notes')).toBe('D:\\Dev\\Notes');
    expect(pathOrNameInPlace('Notes')).toBeNull();
    expect(pathOrNameInPlace('a<b in D:\\Dev')).toBeNull();
  });

  test('websiteAddress understands names, domains and addresses', () => {
    expect(websiteAddress('youtube')).toMatch(/^https:\/\/(www\.)?youtube\.com/);
    expect(websiteAddress('example.com')).toBe('https://example.com');
    expect(websiteAddress('https://example.com/a')).toBe('https://example.com/a');
    expect(websiteAddress('not a site at all')).toBeNull();
  });
});

describe('isPlaceholder', () => {
  test.each([
    'a',
    'an',
    'the',
    'it',
    'that',
    'something',
    'a window',
    'the file',
    'some game',
    'Anything.',
  ])('%s stands in for a name', (v) => expect(isPlaceholder(v)).toBe(true));

  test.each(['Notepad', 'steam', 'D:\\Docs', 'my report', 'window 2', 'a game called Hades'])(
    '%s names something',
    (v) => expect(isPlaceholder(v)).toBe(false),
  );
});
