/**
 * "create a folder called Atlas Test in D:\Dev\Atlas" — the name and the place
 * said separately, which is how people say it. Before this, only a single full
 * path ("create a folder called D:\Dev\Atlas\Atlas Test") was understood, so
 * the natural phrasing fell through to the chat model, which truthfully said
 * *it* could not touch the file system — true of the model, wrong about Atlas.
 *
 * Two layers: the phrasing rule on its own (including what it must refuse to
 * claim), and the whole path through the real Engine and the real
 * `files.createFolder` skill, so the permission and confirmation that skill
 * carries are the ones exercised.
 */
import { describe, expect, test } from 'vitest';
import type { Platform } from '@atlas/core';
import { Engine } from '../src/engine';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar, readFolderInPlace } from '../src/planner/core-grammar';
import { createCoreSkills } from '../src/skills/core-skills';
import { SkillRegistry } from '../src/skills/registry';
import { WorkingMemory } from '../src/working-memory';

const DEV = 'D:\\Dev\\Atlas';

describe('readFolderInPlace — what it understands', () => {
  test.each([
    ['create a folder called Atlas Test in D:\\Dev\\Atlas', `${DEV}\\Atlas Test`],
    ['Create a folder named Atlas Test in D:\\Dev\\Atlas', `${DEV}\\Atlas Test`],
    ['make a new folder called Projects inside D:\\Dev', 'D:\\Dev\\Projects'],
    ['create a folder called "Atlas Test" in D:\\Dev\\Atlas', `${DEV}\\Atlas Test`],
    ['create a folder called Atlas Test in "D:\\Dev\\Atlas"', `${DEV}\\Atlas Test`],
    ['create a folder called Atlas Test in D:\\Dev\\Atlas\\', `${DEV}\\Atlas Test`],
    ['create a new Atlas Test folder in D:\\Dev\\Atlas', `${DEV}\\Atlas Test`],
    ['please create a folder called Atlas Test in D:\\Dev\\Atlas', `${DEV}\\Atlas Test`],
    ['can you create a folder called Atlas Test in D:\\Dev\\Atlas?', `${DEV}\\Atlas Test`],
    ['create a folder called Atlas Test in D:\\Dev\\Atlas please', `${DEV}\\Atlas Test`],
    ['in D:\\Dev\\Atlas create a folder called Atlas Test', `${DEV}\\Atlas Test`],
    ['in D:\\Dev\\Atlas, make a folder named Atlas Test', `${DEV}\\Atlas Test`],
    ['create a folder called Backups in D:\\', 'D:\\Backups'],
    ['create a folder called notes in /home/me/docs', '/home/me/docs/notes'],
  ])('%s', (text, want) => {
    expect(readFolderInPlace(text)).toBe(want);
  });
});

describe('readFolderInPlace — what it must not claim', () => {
  test.each([
    // no explicit place: needs the known-folder lookup a skill does, not a guess
    'create a folder called Atlas Test',
    'create a folder called Atlas Test on my desktop',
    'create a folder called Atlas Test in Documents',
    'create a folder called Atlas Test in my downloads',
    // a relative place is a guess about where "here" is
    'create a folder called Atlas Test in ..\\elsewhere',
    // names that are not one valid folder name
    'create a folder called a<b in D:\\Dev',
    'create a folder called a|b in D:\\Dev',
    'create a folder called .. in D:\\Dev',
    'create a folder called D:\\other\\thing in D:\\Dev',
    // "new" is a modifier here, not a name — the older single-path rule owns these
    'make a new folder at D:\\Dev\\Projects',
    'create an empty folder in D:\\Dev',
    // not a folder request at all
    'what is a folder in D:\\Dev',
    'delete the folder called Atlas Test in D:\\Dev\\Atlas',
    'open the folder called Atlas Test in D:\\Dev\\Atlas',
    'create a file called notes.txt in D:\\Dev',
  ])('%s', (text) => {
    expect(readFolderInPlace(text)).toBeNull();
  });
});

describe('through the real Engine and the real skill', () => {
  function rig() {
    const created: string[] = [];
    const said: string[] = [];
    const confirms: string[] = [];
    const platform = {
      id: 'test',
      capabilities: async () => ['fs'],
      createFolder: async (path: string) => {
        created.push(path);
        return true;
      },
    } as unknown as Platform;

    const skills = new SkillRegistry({ capabilities: () => ['fs'] });
    skills.registerMany(createCoreSkills(platform, {} as never, skills));
    const working = new WorkingMemory();
    const grammar = new Grammar();
    grammar.addMany(createCoreGrammar(working));
    // No intelligence registry at all: this must work with no model connected.
    const engine = new Engine({ skills, grammar, working });
    return {
      created,
      said,
      confirms,
      ask: (text: string) =>
        engine.ask(text, {
          say: (t) => said.push(t),
          confirm: async (q) => {
            confirms.push(q);
            return true;
          },
        }),
    };
  }

  test('your sentence creates the folder, with no model involved', async () => {
    const r = rig();
    const out = (await r.ask('create a folder called Atlas Test in D:\\Dev\\Atlas')) as {
      ok: boolean;
      mode: string;
    };
    expect(r.created).toEqual([`${DEV}\\Atlas Test`]);
    expect(out).toMatchObject({ ok: true, mode: 'command' });
    expect(r.said.join(' ')).toMatch(/Created Atlas Test/);
  });

  test('the single-path phrasing that already worked still does', async () => {
    const r = rig();
    await r.ask('create a folder called D:\\Dev\\Atlas\\Other Thing');
    expect(r.created).toEqual([`${DEV}\\Other Thing`]);
  });

  test('a phrasing it will not claim creates nothing', async () => {
    const r = rig();
    await r.ask('create a folder called Atlas Test on my desktop');
    expect(r.created).toEqual([]);
  });

  test('an unsafe name is refused, not sanitised into something else', async () => {
    const r = rig();
    await r.ask('create a folder called a<b in D:\\Dev');
    expect(r.created).toEqual([]);
  });
});

describe('an instruction Atlas could not resolve, sent to the chat model', () => {
  function rigWithModel() {
    const prompts: string[] = [];
    const said: string[] = [];
    const provider = {
      id: 'm',
      label: 'm',
      isConfigured: () => true,
      isLocal: () => true,
      ask: (prompt: string, h: { onDone(t: string): void }) => {
        prompts.push(prompt);
        h.onDone('reply');
      },
    };
    const skills = new SkillRegistry({ capabilities: () => [] });
    const working = new WorkingMemory();
    const grammar = new Grammar();
    grammar.addMany(createCoreGrammar(working));
    const engine = new Engine({
      skills,
      grammar,
      working,
      intelligence: {
        register: () => {},
        get: () => provider,
        list: () => [provider],
        active: () => provider,
        setActive: () => {},
      },
    });
    return {
      prompts,
      said,
      ask: (t: string) => engine.ask(t, { say: (x) => said.push(x), confirm: async () => true }),
    };
  }

  test('the model is told what Atlas is, so it does not claim Atlas cannot control the PC', async () => {
    const r = rigWithModel();
    await r.ask('make me a folder for my taxes');
    const last = r.prompts.at(-1) ?? '';
    expect(last).toContain('You are Atlas');
    expect(last).toMatch(/Atlas itself carries out actions/);
    expect(last).toMatch(/do not say Atlas cannot control the computer/i);
    expect(last.endsWith('make me a folder for my taxes')).toBe(true);
  });

  test('the suggested phrasing is one Atlas really understands', () => {
    // the exact example given to the model in ACTION_CONTEXT
    expect(readFolderInPlace('create a folder called Notes in D:\\Dev')).toBe('D:\\Dev\\Notes');
  });

  test('ordinary questions and chat are sent exactly as written', async () => {
    const r = rigWithModel();
    await r.ask('what is the capital of Peru?');
    expect(r.prompts.at(-1)).toBe('what is the capital of Peru?');
    expect(r.prompts.join(' ')).not.toContain('You are Atlas');
  });
});
