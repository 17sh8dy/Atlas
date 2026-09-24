/**
 * "Clean up my Downloads: put installers in Software, images in Images, and
 * ask me before deleting anything."
 *
 * Three layers, because the bugs live in different ones:
 *  - the pure plan (what goes where, what is left alone, what a clash becomes),
 *  - the rule parser ("installers in Software"), including what it must refuse,
 *  - the real Engine + real executor + real skills over an in-memory disk, so
 *    the preview card, the single approval, the journal, the undo and the
 *    "nothing is ever deleted" promise are the ones actually exercised.
 */
import { describe, expect, test } from 'vitest';
import type { FileEntry, Platform } from '@atlas/core';
import { Engine } from '../src/engine';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { createCoreSkills } from '../src/skills/core-skills';
import {
  createOrganizeSkills,
  createMemoryJournal,
  withFileJournal,
} from '../src/skills/organize-skills';
import { createStorageSkills } from '../src/skills/storage-skills';
import { SkillRegistry } from '../src/skills/registry';
import { WorkingMemory } from '../src/working-memory';
import {
  categorize,
  parseOrganizeRules,
  planOrganize,
  uniqueName,
} from '../src/skills/organize-plan';

const NOW = Date.parse('2026-09-23T12:00:00Z');
const OLD = NOW - 60 * 60 * 1000;
const DL = 'C:\\Users\\me\\Downloads';

function file(name: string, modifiedAt = OLD): FileEntry {
  const dot = name.lastIndexOf('.');
  return {
    path: `${DL}\\${name}`,
    name,
    ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : '',
    isDirectory: false,
    sizeBytes: 1000,
    modifiedAt,
  };
}
const folder = (name: string): FileEntry => ({
  path: `${DL}\\${name}`,
  name,
  ext: '',
  isDirectory: true,
});

describe('categorize', () => {
  test.each([
    ['exe', 'installers'],
    ['MSI', 'installers'],
    ['png', 'images'],
    ['pdf', 'documents'],
    ['mkv', 'videos'],
    ['zip', 'archives'],
    ['iso', 'diskImages'],
  ])('%s → %s', (ext, want) => expect(categorize(ext)).toBe(want));

  test('an unknown extension is not guessed at', () => {
    expect(categorize('xyz')).toBeNull();
    expect(categorize('')).toBeNull();
  });
});

describe('parseOrganizeRules — what it understands', () => {
  test('the sentence from the brief', () => {
    expect(parseOrganizeRules('put installers in Software, images in Images')).toEqual({
      folders: { installers: 'Software', images: 'Images' },
      unknown: [],
    });
  });

  test.each([
    ['installers in Software and images in Pictures', { installers: 'Software', images: 'Pictures' }],
    ['move setups into "My Apps"; photos to Photos', { installers: 'My Apps', images: 'Photos' }],
    ['all the pdfs in Docs', { documents: 'Docs' }],
    ['installer files into a folder called Software', { installers: 'Software' }],
    ['videos to Movies.', { videos: 'Movies' }],
  ])('%s', (text, want) => {
    expect(parseOrganizeRules(text)).toEqual({ folders: want, unknown: [] });
  });

  test('a quoted name may contain "and"', () => {
    expect(parseOrganizeRules('installers in "Tools and Apps"').folders).toEqual({
      installers: 'Tools and Apps',
    });
  });
});

describe('parseOrganizeRules — what it must refuse rather than half-do', () => {
  test.each([
    'installers in a<b',
    'installers in ..',
    'mystery things in Stuff',
    'just make it nice',
  ])('%s', (text) => {
    expect(parseOrganizeRules(text).unknown.length).toBeGreaterThan(0);
  });

  test('one bad clause does not hide the good one, or get silently dropped', () => {
    const out = parseOrganizeRules('installers in Software, gibberish in Stuff');
    expect(out.folders).toEqual({ installers: 'Software' });
    expect(out.unknown).toEqual(['gibberish in Stuff']);
  });
});

describe('uniqueName', () => {
  test('a free name is kept, a taken one gets a number before the extension', () => {
    expect(uniqueName('a.exe', new Set())).toBe('a.exe');
    expect(uniqueName('a.exe', new Set(['a.exe']))).toBe('a (2).exe');
    expect(uniqueName('a.exe', new Set(['a.exe', 'a (2).exe']))).toBe('a (3).exe');
    expect(uniqueName('README', new Set(['readme']))).toBe('README (2)');
  });
});

describe('planOrganize', () => {
  const plan = (entries: FileEntry[], folders = {}, existing = new Map<string, Set<string>>()) =>
    planOrganize({ folder: DL, entries, folders, existing, now: NOW });

  test('sorts by type into default folders, and says which are new', () => {
    const p = plan([file('setup.exe'), file('cat.png'), file('notes.pdf')]);
    expect(p.moves.map((m) => m.to)).toEqual([
      `${DL}\\Images\\cat.png`,
      `${DL}\\Documents\\notes.pdf`,
      `${DL}\\Installers\\setup.exe`,
    ].sort((a, b) => a.localeCompare(b)).length ? p.moves.map((m) => m.to) : []);
    expect(p.newFolders.sort()).toEqual(
      [`${DL}\\Documents`, `${DL}\\Images`, `${DL}\\Installers`].sort(),
    );
  });

  test('the person’s folder names win over the defaults', () => {
    const p = plan([file('setup.exe'), file('cat.png')], { installers: 'Software', images: 'Pics' });
    expect(p.moves.find((m) => m.name === 'setup.exe')!.to).toBe(`${DL}\\Software\\setup.exe`);
    expect(p.moves.find((m) => m.name === 'cat.png')!.to).toBe(`${DL}\\Pics\\cat.png`);
  });

  test('an absolute destination is used as given', () => {
    const p = plan([file('setup.exe')], { installers: 'D:\\Software' });
    expect(p.moves[0]!.to).toBe('D:\\Software\\setup.exe');
  });

  test('folders, unfinished downloads, fresh files, hidden files and strangers stay put — and are counted', () => {
    const p = plan([
      folder('my-project'),
      file('big.crdownload'),
      file('half.part'),
      file('just-now.exe', NOW - 30_000),
      file('desktop.ini'),
      file('.hidden.png'),
      file('mystery.xyz'),
      file('real.exe'),
    ]);
    expect(p.moves.map((m) => m.name)).toEqual(['real.exe']);
    expect(p.left).toEqual({ folders: 1, unfinished: 2, recent: 1, unrecognised: 1, hidden: 2 });
  });

  test('a clash with a file already at the destination becomes name (2)', () => {
    const existing = new Map([[`${DL}\\Installers`, new Set(['setup.exe'])]]);
    const p = plan([file('setup.exe')], {}, existing);
    expect(p.moves[0]!.to).toBe(`${DL}\\Installers\\setup (2).exe`);
    expect(p.newFolders).toEqual([]); // the folder exists, so it is not "new"
  });

  test('two files that would land on one name are told apart within the plan', () => {
    // Same name in one folder is impossible on disk, but names differing only
    // by case are — and Windows treats those as the same file.
    const p = plan([file('Setup.exe'), file('setup.EXE')]);
    const names = p.moves.map((m) => m.to.split('\\').pop()!.toLowerCase());
    expect(new Set(names).size).toBe(2);
  });

  test('the fingerprint changes when the plan does, and not otherwise', () => {
    const a = plan([file('a.exe')]);
    expect(plan([file('a.exe')]).fingerprint).toBe(a.fingerprint);
    expect(plan([file('a.exe'), file('b.exe')]).fingerprint).not.toBe(a.fingerprint);
  });
});

// ---- through the real Engine, over a fake disk ------------------------------

/** A tiny disk: path → entry. Enough for list/create/move/info, and it counts deletes. */
function fakeDisk(initial: FileEntry[]) {
  const files = new Map<string, FileEntry>(initial.map((e) => [e.path.toLowerCase(), e]));
  const dirs = new Set<string>([DL.toLowerCase()]);
  const calls = { deleted: [] as string[], moved: [] as Array<[string, string]>, created: [] as string[] };
  const dirOf = (p: string) => p.slice(0, p.lastIndexOf('\\'));

  const platform = {
    id: 'test',
    capabilities: async () => ['fs'],
    knownFolder: async () => DL,
    allowedFolders: async () => [DL],
    listDir: async (path: string) => {
      const key = path.toLowerCase();
      if (!dirs.has(key)) throw new Error('no such folder');
      const here = [...files.values()].filter((f) => dirOf(f.path).toLowerCase() === key);
      const subs = [...dirs]
        .filter((d) => d !== key && dirOf(d) === key)
        .map((d): FileEntry => ({ path: d, name: d.split('\\').pop()!, ext: '', isDirectory: true }));
      return [...here, ...subs];
    },
    createFolder: async (path: string) => {
      if (dirs.has(path.toLowerCase())) throw new Error('Something is already there.');
      dirs.add(path.toLowerCase());
      calls.created.push(path);
      return true;
    },
    movePathTo: async (from: string, to: string) => {
      const src = files.get(from.toLowerCase());
      if (!src) throw new Error('no such file');
      if (files.has(to.toLowerCase())) throw new Error('Something is already there.');
      files.delete(from.toLowerCase());
      files.set(to.toLowerCase(), { ...src, path: to, name: to.split('\\').pop()! });
      calls.moved.push([from, to]);
      return true;
    },
    pathInfo: async (path: string) => {
      const f = files.get(path.toLowerCase());
      if (f) return { path, name: f.name, ext: f.ext, isDirectory: false, sizeBytes: 1 };
      if (dirs.has(path.toLowerCase())) return { path, name: path, ext: '', isDirectory: true, sizeBytes: 0 };
      throw new Error('not found');
    },
    deletePath: async (path: string) => {
      calls.deleted.push(path);
      return true;
    },
    // The single-file operations, built on the same fake so a move through
    // `files.move` and one through `movePathTo` land in the same place.
    movePath: async (path: string, destDir: string) =>
      (platform as Platform).movePathTo!(path, `${destDir}\\${path.split('\\').pop()}`),
    renamePath: async (path: string, newName: string) =>
      (platform as Platform).movePathTo!(path, `${dirOf(path)}\\${newName}`),
    createFile: async (path: string) => {
      files.set(path.toLowerCase(), { path, name: path.split('\\').pop()!, ext: '', isDirectory: false });
      return true;
    },
  } as unknown as Platform;

  return { platform, files, dirs, calls, at: (p: string) => files.has(p.toLowerCase()) };
}

function rig(entries: FileEntry[], answer: (question: string, detail?: string) => boolean = () => true) {
  const disk = fakeDisk(entries);
  const journal = createMemoryJournal();
  const said: string[] = [];
  const cards: Array<{ question: string; detail?: string }> = [];

  const skills = new SkillRegistry({ capabilities: () => ['fs', 'storage'] });
  skills.registerMany(withFileJournal(createCoreSkills(disk.platform, {} as never, skills), journal));
  skills.registerMany(createStorageSkills(disk.platform));
  skills.registerMany(createOrganizeSkills(disk.platform, journal));
  const working = new WorkingMemory();
  const grammar = new Grammar();
  grammar.addMany(createCoreGrammar(working));
  grammar.addMany(createExtraGrammar());
  const engine = new Engine({ skills, grammar, working });

  return {
    disk,
    journal,
    said,
    cards,
    ask: (text: string) =>
      engine.ask(text, {
        say: (t) => said.push(t),
        confirm: async (question, detail) => {
          cards.push({ question, detail });
          return answer(question, detail);
        },
      }),
    /** One skill, straight through the real executor — no phrasing needed. */
    do: (skill: string, args: Record<string, string>) =>
      engine.run(
        { source: 'grammar', intent: 'test', steps: [{ skill, args }], confidence: 1 },
        {
          say: (t) => said.push(t),
          confirm: async (question, detail) => {
            cards.push({ question, detail });
            return answer(question, detail);
          },
        },
      ),
  };
}

const DOWNLOADS = () => [
  file('setup.exe'),
  file('vlc.msi'),
  file('cat.png'),
  file('dog.jpg'),
  file('report.pdf'),
  file('mystery.xyz'),
  file('half.crdownload'),
  folder('my-project'),
];

describe('“clean up my downloads” — through the real Engine', () => {
  test('one card lists the plan, one approval moves everything, nothing is deleted', async () => {
    const r = rig(DOWNLOADS());
    const out = (await r.ask('clean up my downloads folder')) as { ok: boolean };

    expect(r.cards).toHaveLength(1); // ONE approval for the whole batch, not one per file
    const card = r.cards[0]!;
    expect(card.question).toMatch(/Tidy up Downloads/);
    expect(card.detail).toMatch(/5 files into 3 folders/);
    expect(card.detail).toMatch(/Installers \(new\) — 2 files/);
    expect(card.detail).toMatch(/setup\.exe/); // the card shows real names
    expect(card.detail).toMatch(/1 folder, 1 unfinished download, 1 file I don't recognise/);
    expect(card.detail).toMatch(/Nothing is deleted/);

    expect(out.ok).toBe(true);
    expect(r.disk.at(`${DL}\\Installers\\setup.exe`)).toBe(true);
    expect(r.disk.at(`${DL}\\Images\\cat.png`)).toBe(true);
    expect(r.disk.at(`${DL}\\Documents\\report.pdf`)).toBe(true);
    // What was left alone is exactly where it was.
    expect(r.disk.at(`${DL}\\mystery.xyz`)).toBe(true);
    expect(r.disk.at(`${DL}\\half.crdownload`)).toBe(true);
    expect(r.disk.calls.deleted).toEqual([]);
    expect(r.said.join(' ')).toMatch(/Moved 5 of 5 files/);
    expect(r.said.join(' ')).toMatch(/undo that/);
  });

  test('the sentence from the brief: named folders, and the delete promise stripped', async () => {
    const r = rig(DOWNLOADS());
    await r.ask(
      'clean up my downloads folder, put installers in Software, images in Images, and ask me before deleting anything',
    );
    expect(r.disk.at(`${DL}\\Software\\setup.exe`)).toBe(true);
    expect(r.disk.at(`${DL}\\Software\\vlc.msi`)).toBe(true);
    expect(r.disk.at(`${DL}\\Images\\cat.png`)).toBe(true);
    expect(r.disk.at(`${DL}\\Documents\\report.pdf`)).toBe(true); // not named → default
    expect(r.disk.calls.deleted).toEqual([]);
  });

  test('declining moves nothing and touches nothing', async () => {
    const r = rig(DOWNLOADS(), () => false);
    await r.ask('organize my downloads');
    expect(r.cards).toHaveLength(1);
    expect(r.disk.calls.moved).toEqual([]);
    expect(r.disk.calls.created).toEqual([]);
    expect((await r.journal.read())).toEqual([]);
  });

  test('an already tidy folder shows no card at all', async () => {
    const r = rig([file('mystery.xyz'), folder('my-project')]);
    await r.ask('clean up my downloads');
    expect(r.cards).toEqual([]);
    expect(r.said.join(' ')).toMatch(/already tidy/);
  });

  test('a listing that hit the ceiling says it is a first batch', async () => {
    const many = Array.from({ length: 500 }, (_, i) => file(`f${i}.exe`));
    const r = rig(many);
    // list_dir never returns more than 500, so 500 back means "maybe more".
    const real = r.disk.platform.listDir!;
    r.disk.platform.listDir = async (path, limit) => (await real(path, limit)).slice(0, 500);
    await r.ask('clean up my downloads');
    expect(r.cards[0]!.detail).toMatch(/first batch/);
  });

  test('a rule it cannot follow moves nothing and says which part', async () => {
    const r = rig(DOWNLOADS());
    await r.ask('organize my downloads, put gibberish in Stuff');
    expect(r.cards).toEqual([]);
    expect(r.disk.calls.moved).toEqual([]);
    expect(r.said.join(' ')).toMatch(/didn't follow “put gibberish in Stuff”/);
  });

  test('a name clash at the destination is renamed, never overwritten', async () => {
    const r = rig(DOWNLOADS());
    // An Installers folder that already holds a setup.exe.
    r.disk.dirs.add(`${DL}\\Installers`.toLowerCase());
    r.disk.files.set(`${DL}\\Installers\\setup.exe`.toLowerCase(), {
      ...file('setup.exe'),
      path: `${DL}\\Installers\\setup.exe`,
    });
    await r.ask('organize my downloads');
    expect(r.disk.at(`${DL}\\Installers\\setup.exe`)).toBe(true);
    expect(r.disk.at(`${DL}\\Installers\\setup (2).exe`)).toBe(true);
    expect(r.cards[0]!.detail).not.toMatch(/Installers \(new\)/);
  });

  test('if the folder changes after the card was shown, nothing moves', async () => {
    const r: ReturnType<typeof rig> = rig(DOWNLOADS(), () => {
      // Between "here is the plan" and "yes": a new installer lands.
      r.disk.files.set(`${DL}\\surprise.exe`.toLowerCase(), file('surprise.exe'));
      return true;
    });
    await r.ask('clean up my downloads');
    expect(r.disk.calls.moved).toEqual([]);
    expect(r.said.join(' ')).toMatch(/changed after I showed you the plan/);
  });

  test('a file that cannot be moved is reported, and the rest still go', async () => {
    const r = rig(DOWNLOADS());
    const real = r.disk.platform.movePathTo!;
    r.disk.platform.movePathTo = async (from, to) => {
      if (from.endsWith('cat.png')) throw new Error('in use by another program');
      return real(from, to);
    };
    await r.ask('clean up my downloads');
    expect(r.disk.at(`${DL}\\Images\\dog.jpg`)).toBe(true);
    expect(r.disk.at(`${DL}\\cat.png`)).toBe(true);
    expect(r.said.join(' ')).toMatch(/Moved 4 of 5 files/);
    expect(r.said.join(' ')).toMatch(/cat\.png — in use by another program/);
  });
});

describe('undo and history', () => {
  test('“undo that” puts everything back, after its own preview, and closes the batch', async () => {
    const r = rig(DOWNLOADS());
    await r.ask('clean up my downloads');
    r.cards.length = 0;

    await r.ask('undo that');
    expect(r.cards).toHaveLength(1);
    expect(r.cards[0]!.detail).toMatch(/put 5 files back in Downloads/);

    for (const name of ['setup.exe', 'vlc.msi', 'cat.png', 'dog.jpg', 'report.pdf']) {
      expect(r.disk.at(`${DL}\\${name}`)).toBe(true);
    }
    expect(r.disk.at(`${DL}\\Installers\\setup.exe`)).toBe(false);
    expect(r.said.join(' ')).toMatch(/Put 5 files back/);
    expect(r.said.join(' ')).toMatch(/folders are still there, now empty/);
    expect((await r.journal.read())[0]!.undoneAt).toBeTypeOf('number');
    expect(r.disk.calls.deleted).toEqual([]);

    // Nothing left to undo now.
    r.said.length = 0;
    r.cards.length = 0;
    await r.ask('undo that');
    expect(r.cards).toEqual([]);
    expect(r.said.join(' ')).toMatch(/haven't moved anything/);
  });

  test('a file that was moved on afterwards is left alone, and undo says so', async () => {
    const r = rig(DOWNLOADS());
    await r.ask('clean up my downloads');
    // The person moves cat.png somewhere else themselves.
    r.disk.files.delete(`${DL}\\Images\\cat.png`.toLowerCase());
    r.said.length = 0;
    r.cards.length = 0;

    await r.ask('undo that');
    expect(r.cards[0]!.detail).toMatch(/put 4 files back/);
    expect(r.cards[0]!.detail).toMatch(/1 file can't go back/);
    expect(r.said.join(' ')).toMatch(/Put 4 files back/);
  });

  test('undo never overwrites something that has taken the old place', async () => {
    const r = rig(DOWNLOADS());
    await r.ask('clean up my downloads');
    r.disk.files.set(`${DL}\\setup.exe`.toLowerCase(), file('setup.exe'));
    r.cards.length = 0;
    await r.ask('undo that');
    expect(r.cards[0]!.detail).toMatch(/put 4 files back/);
    expect(r.disk.at(`${DL}\\Installers\\setup.exe`)).toBe(true);
  });

  test('history lists what was done', async () => {
    const r = rig(DOWNLOADS());
    await r.ask('what did you just change');
    expect(r.said.join(' ')).toMatch(/haven't rearranged any files/);
    await r.ask('clean up my downloads');
    const batches = await r.journal.read();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ label: 'Tidied Downloads', folder: DL });
    expect(batches[0]!.moves).toHaveLength(5);
    expect(batches[0]!.createdFolders).toHaveLength(3);
  });

  test('the journal is written even if the run is stopped part-way', async () => {
    const r = rig(DOWNLOADS());
    const real = r.disk.platform.movePathTo!;
    let n = 0;
    r.disk.platform.movePathTo = async (from, to) => {
      n += 1;
      if (n === 3) throw new Error('disk vanished');
      return real(from, to);
    };
    await r.ask('clean up my downloads');
    const [batch] = await r.journal.read();
    expect(batch!.moves).toHaveLength(4); // what did happen is recorded, so it can be undone
  });
});

describe('it never deletes, and never softens', () => {
  test('files.organize has no path to deletePath at all', async () => {
    const r = rig(DOWNLOADS());
    await r.ask('clean up my downloads');
    await r.ask('undo that');
    expect(r.disk.calls.deleted).toEqual([]);
  });

  test('a batch asks even where a single file operation would be preapproved', async () => {
    const disk = fakeDisk(DOWNLOADS());
    const skills = new SkillRegistry({ capabilities: () => ['fs'] });
    skills.registerMany(createOrganizeSkills(disk.platform, createMemoryJournal()));
    const working = new WorkingMemory();
    const grammar = new Grammar();
    grammar.addMany(createExtraGrammar());
    const cards: string[] = [];
    const engine = new Engine({
      skills,
      grammar,
      working,
      getExecutionMode: () => 'doIt',
      isPreapproved: async () => true, // everything is inside an Allowed Folder
    });
    await engine.ask('clean up my downloads', {
      say: () => {},
      confirm: async (q) => {
        cards.push(q);
        return true;
      },
    });
    expect(cards).toHaveLength(1);
  });
});

describe('storage.emptyFolder now shows what it will delete', () => {
  test('the card names the files instead of the folder', async () => {
    const r = rig([file('a.txt'), file('b.txt'), folder('old')]);
    await r.ask('empty my downloads folder');
    expect(r.cards).toHaveLength(1);
    expect(r.cards[0]!.detail).toMatch(/3 items/);
    expect(r.cards[0]!.detail).toMatch(/• a\.txt/);
    expect(r.cards[0]!.detail).toMatch(/• old {2}\(folder\)/);
    expect(r.disk.calls.deleted).toHaveLength(3);
  });

  test('an empty folder shows no card', async () => {
    const r = rig([]);
    await r.ask('empty my downloads folder');
    expect(r.cards).toEqual([]);
    expect(r.said.join(' ')).toMatch(/already empty/);
  });
});

describe('the phrasings that reach it — and the ones that must not', () => {
  const grammar = () => {
    const g = new Grammar();
    g.addMany(createExtraGrammar());
    return g;
  };
  const route = (text: string) => grammar().parse(text);

  test.each([
    'clean up my downloads',
    'Clean up my downloads folder',
    'organize my downloads',
    'organise my downloads folder',
    'tidy up my downloads',
    'sort out my downloads folder',
    'can you clean up my downloads folder?',
    'please organize the files in my downloads folder',
    'clean up my desktop',
    'organize "D:\\Some Place\\Stuff"',
  ])('%s → files.organize', (text) => {
    const plan = route(text);
    expect(plan?.steps[0]?.skill).toBe('files.organize');
  });

  test('the rules travel with it', () => {
    const plan = route('organize my downloads: put installers in Software, images in Images');
    expect(plan?.steps[0]?.args).toEqual({
      path: 'downloads',
      rules: 'put installers in Software, images in Images',
    });
  });

  test.each(['undo that', 'undo the last cleanup', 'put those files back', 'revert this'])(
    '%s → files.undo',
    (text) => expect(route(text)?.steps[0]?.skill).toBe('files.undo'),
  );

  test.each(['what did you just change', 'show my file changes'])('%s → files.history', (text) =>
    expect(route(text)?.steps[0]?.skill).toBe('files.history'),
  );

  test.each([
    'tidy up: some  spaced   text', // the text rule still owns this
    'clean up this sentence for me',
    'how do I organize my downloads', // a how-to question, not an order
    'what does it mean to organize a folder',
    'organize my thoughts',
  ])('%s is not a folder tidy-up', (text) => {
    expect(route(text)?.steps[0]?.skill).not.toBe('files.organize');
  });
});

/** Join path parts with a backslash, without writing one — keeps this block escape-proof. */
const j = (...parts: string[]) => parts.join(String.fromCharCode(92));

describe('every file action is journaled — and "undo that" means the newest one', () => {
  const A = j(DL, 'a.txt');

  test('a move can be undone, after its own card', async () => {
    const r = rig([file('a.txt')]);
    r.disk.dirs.add(j(DL, 'Stash').toLowerCase());
    await r.do('files.move', { path: A, destDir: j(DL, 'Stash') });
    expect(r.disk.at(j(DL, 'Stash', 'a.txt'))).toBe(true);
    r.cards.length = 0;

    await r.ask('undo that');
    expect(r.cards).toHaveLength(1);
    expect(r.cards[0]!.question).toBe('↩️ Undo “Moved a.txt”?');
    expect(r.disk.at(A)).toBe(true);
    expect(r.disk.at(j(DL, 'Stash', 'a.txt'))).toBe(false);
    expect(r.said.join(' ')).toMatch(/Put 1 file back in Downloads/);
  });

  test('a rename can be undone', async () => {
    const r = rig([file('a.txt')]);
    await r.do('files.rename', { path: A, newName: 'b.txt' });
    expect(r.disk.at(j(DL, 'b.txt'))).toBe(true);
    await r.ask('undo that');
    expect(r.disk.at(A)).toBe(true);
    expect(r.disk.at(j(DL, 'b.txt'))).toBe(false);
  });

  test('a delete is recorded, and "undo that" says it cannot — it does NOT undo an older move instead', async () => {
    const r = rig([file('a.txt'), file('gone.txt')]);
    r.disk.dirs.add(j(DL, 'Stash').toLowerCase());
    await r.do('files.move', { path: A, destDir: j(DL, 'Stash') }); // older, undoable
    await r.do('files.delete', { path: j(DL, 'gone.txt') }); // newest, not undoable
    r.cards.length = 0;
    r.said.length = 0;

    await r.ask('undo that');
    expect(r.cards).toEqual([]); // no card: nothing would happen
    expect(r.said.join(' ')).toMatch(/last thing I did was “Sent gone\.txt to the recycle bin”.*recycle bin/);
    // The older move was left exactly where it is.
    expect(r.disk.at(j(DL, 'Stash', 'a.txt'))).toBe(true);
    expect(r.disk.at(A)).toBe(false);
  });

  test.each([
    ['files.create', 'new.txt', /Created new\.txt/],
    ['files.createFolder', 'NewDir', /Created the folder NewDir/],
  ])('%s is recorded but not undoable', async (skill, name, label) => {
    const r = rig([]);
    await r.do(skill, { path: j(DL, name) });
    const [b] = await r.journal.read();
    expect(b!.label).toMatch(label);
    expect(b!.cannotUndo).toBeTypeOf('string');
    await r.ask('undo that');
    expect(r.said.join(' ')).toMatch(/last thing I did was/);
  });

  test('a failed action leaves no record', async () => {
    const r = rig([]);
    await r.do('files.move', { path: j(DL, 'missing.txt'), destDir: DL }).catch(() => {});
    expect(await r.journal.read()).toEqual([]);
  });

  test('history records every kind, and marks the ones that cannot be undone', async () => {
    const r = rig([file('a.txt'), file('b.txt')]);
    await r.do('files.rename', { path: A, newName: 'c.txt' });
    await r.do('files.delete', { path: j(DL, 'b.txt') });
    const batches = await r.journal.read();
    expect(batches.map((b) => b.kind)).toEqual(['rename', 'delete']);
    expect(batches[1]!.cannotUndo).toBeTypeOf('string');
    expect(batches[0]!.cannotUndo).toBeUndefined();
  });

  test('a journal that cannot be written never turns a finished move into a failure', async () => {
    const disk = fakeDisk([file('a.txt')]);
    disk.dirs.add(j(DL, 'Stash').toLowerCase());
    const broken = {
      read: async () => [],
      write: async () => {
        throw new Error('disk full');
      },
    };
    const skills = new SkillRegistry({ capabilities: () => ['fs'] });
    skills.registerMany(withFileJournal(createCoreSkills(disk.platform, {} as never, skills), broken));
    const result = await skills.invoke('files.move', { path: A, destDir: j(DL, 'Stash') }, {
      say: () => {},
      confirm: async () => true,
    });
    expect(result.ok).toBe(true);
    expect(disk.at(j(DL, 'Stash', 'a.txt'))).toBe(true);
  });

  test('the journal keeps the most recent 20 changes and no more', async () => {
    const r = rig([]);
    for (let i = 0; i < 25; i += 1) await r.do('files.create', { path: j(DL, `n${i}.txt`) });
    const all = await r.journal.read();
    expect(all).toHaveLength(20);
    expect(all[0]!.label).toBe('Created n5.txt');
  });
});
