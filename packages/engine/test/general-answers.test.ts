/**
 * General answers with no language model (docs/PLAN-2.0.5.md, "General Atlas").
 *
 * Two kinds of question that used to end in "I couldn't reach your language model" although no model was needed:
 *   - about this PC ("how many folders are there in: D:\Dev?")  → answered from the file system
 *   - about the world ("what is a Reel from Instagram?")        → looked up, read, and answered from the sources
 * Run through the real Engine, real grammar and real skills; only the platform (disk, network) is a fake.
 */
import { describe, expect, it } from 'vitest';
import type { FileEntry, Platform, WebPage, WebSearchResult } from '@atlas/core';
import { Engine, type EngineIO } from '../src/engine';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { WorkingMemory } from '../src/working-memory';
import { SkillRegistry } from '../src/skills/registry';
import { createCoreSkills } from '../src/skills/core-skills';
import { createFileFactSkills } from '../src/skills/file-facts-skills';
import { createWebSearchSkills } from '../src/skills/web-search-skills';
import { createPhrasing } from '../src/phrasing';
import { parseFileQuestion } from '../src/general/file-facts';
import { readQuestion } from '../src/general/shape';
import { composeAnswer, sentencesOf } from '../src/general/compose';
import { buildPacket } from '../src/web/evidence';

// ---- the parsers -------------------------------------------------------------------------------------

describe('reading a question about files', () => {
  const cases: Array<[string, unknown]> = [
    ['How many folders are there in: D:\\Dev?', { op: 'count', path: 'D:\\Dev', thing: 'folders' }],
    [
      'how many files are in my downloads folder',
      { op: 'count', path: 'downloads', thing: 'files' },
    ],
    ['how many items are in D:\\', { op: 'count', path: 'D:\\', thing: 'items' }],
    ['how many folders on D:', { op: 'count', path: 'D:\\', thing: 'folders' }],
    [
      'what is the newest file in D:\\Dev',
      { op: 'extreme', path: 'D:\\Dev', which: 'newest', thing: 'files' },
    ],
    ['does D:\\Dev\\Atlas exist', { op: 'exists', path: 'D:\\Dev\\Atlas' }],
    ['is there a folder called Atlas in D:\\Dev', { op: 'exists', path: 'D:\\Dev', name: 'Atlas' }],
    ['when was D:\\Dev\\Atlas last modified', { op: 'modified', path: 'D:\\Dev\\Atlas' }],
    ['what folders are in D:\\Dev', { op: 'list', path: 'D:\\Dev', thing: 'folders' }],
    ['what drives do I have', { op: 'drives' }],
  ];
  for (const [text, want] of cases) {
    it(text, () => expect(parseFileQuestion(text)).toMatchObject(want as object));
  }

  it('counts by kind of file', () => {
    expect(parseFileQuestion('how many mp4 files are in D:\\Videos')).toMatchObject({
      op: 'count',
      thing: 'ext',
      exts: ['mp4'],
    });
    expect(parseFileQuestion('how many photos are in my pictures folder')).toMatchObject({
      op: 'count',
      thing: 'ext',
      label: 'photos',
    });
  });

  it('never reads an instruction, or a place-less question, as a question', () => {
    for (const t of [
      'delete the folders in D:\\Dev',
      'move the files in D:\\Dev',
      'open D:\\Dev',
      'how many folders are there',
      'what is a folder',
      'how are you',
    ]) {
      expect(parseFileQuestion(t), t).toBeNull();
    }
  });
});

describe('reading a general question', () => {
  it('puts the context first: a Reel from Instagram → "Instagram Reel"', () => {
    const s = readQuestion('What is a "Reel" from Instagram?')!;
    expect(s.kind).toBe('definition');
    expect(s.queries[0]).toBe('Instagram Reel');
    expect(s.subject).toBe('Reel');
  });
  it('turns a measurement into a noun', () => {
    expect(readQuestion('how tall is Mount Everest')!.queries[0]).toBe('Mount Everest height');
  });
  it('keeps a whole question when it has a verb in it', () => {
    expect(readQuestion('why is the sky blue')!.queries[0]).toBe('why is the sky blue');
    expect(readQuestion('how does a refrigerator work')!.queries[0]).toBe(
      'how does a refrigerator work',
    );
  });
  it('handles "tell me about"', () => {
    expect(readQuestion('tell me about the Roman Empire')!.queries[0]).toMatch(/Roman Empire/);
  });
  it('declines what is about this person, this machine, or a request', () => {
    for (const t of [
      'what is my IP address',
      'how much RAM do I have',
      'can you open spotify',
      'what is in D:\\Dev',
      'hi',
    ]) {
      expect(readQuestion(t), t).toBeNull();
    }
  });
});

// ---- choosing the sentences --------------------------------------------------------------------------

const result = (
  title: string,
  url: string,
  snippet: string,
  provider = 'duckduckgo',
): WebSearchResult => ({ title, url, snippet, provider });

function packetFor(question: string, pages: Array<{ r: WebSearchResult; text?: string }>) {
  return buildPacket({
    question,
    query: question,
    category: null,
    provider: 'duckduckgo',
    providerLabel: 'DuckDuckGo',
    inputs: pages.map(({ r, text }) => ({ result: r, pageText: text })),
    now: new Date('2026-10-25T12:00:00Z'),
  });
}

describe('composing an answer from sources', () => {
  const reelQuestion = 'What is a "Reel" from Instagram?';
  const shape = readQuestion(reelQuestion)!;

  it('picks the defining sentence and cites it', () => {
    const packet = packetFor(reelQuestion, [
      {
        r: result(
          'Instagram Reels - Wikipedia',
          'https://en.wikipedia.org/wiki/Instagram',
          'Instagram',
          'wikipedia',
        ),
        text: 'Instagram is a photo and video sharing social networking service. Reels is a feature of Instagram that lets people record and share short videos of up to 90 seconds. Reels can be set to music. The company was founded in 2010.',
      },
      {
        r: result(
          'What are Reels? | Help Center',
          'https://help.instagram.com/270447560766967',
          'Reels are short, entertaining videos you can make and share on Instagram.',
        ),
      },
      {
        r: result(
          "Top 10 Reel tricks you won't believe",
          'https://spam.example.com/tricks',
          'Click here to subscribe to our newsletter!',
        ),
      },
    ]);
    const answer = composeAnswer(packet, shape)!;
    expect(answer).not.toBeNull();
    expect(answer.text).toMatch(/short.{0,20}videos/i);
    expect(answer.text).not.toMatch(/subscribe/i);
    expect(answer.confidence).not.toBe('low');
  });

  it('says nothing rather than quote something beside the point', () => {
    const packet = packetFor(reelQuestion, [
      {
        r: result(
          'Fishing reels',
          'https://shop.example.com/fishing',
          'Spinning reels are used for freshwater fishing and come in many sizes.',
        ),
      },
    ]);
    expect(composeAnswer(packet, shape)).toBeNull();
  });

  it('answers "who is the president of France" with the person, not the office', () => {
    const q = 'who is the president of France';
    const packet = packetFor(q, [
      {
        r: result(
          'President of France - Wikipedia',
          'https://en.wikipedia.org/wiki/President_of_France',
          'x',
          'wikipedia',
        ),
        text: 'The president of France is the head of state of France and the commander-in-chief of the French Armed Forces. The officeholder is also honorary proto-canon of the Archbasilica of Saint John Lateran in Rome.',
      },
      {
        r: result(
          'Emmanuel Macron | Britannica',
          'https://www.britannica.com/biography/Emmanuel-Macron',
          'x',
        ),
        text: 'Emmanuel Macron (born December 21, 1977, Amiens, France) is a French banker and politician who was elected president of France in 2017. Macron was the first person in the history of the Fifth Republic to win the presidency without a party.',
      },
    ]);
    expect(readQuestion(q)!.personRole).toBe(true);
    expect(composeAnswer(packet, readQuestion(q)!)!.text).toMatch(/^Emmanuel Macron/);
  });

  it('splits sentences without breaking on abbreviations', () => {
    const s = sentencesOf(
      'The U.S. has fifty states, e.g. Utah and Texas. Utah is in the west of the country.',
    );
    expect(s).toHaveLength(2);
  });
});

// ---- through the real engine -------------------------------------------------------------------------

function rig(opts: {
  files?: FileEntry[];
  search?: WebSearchResult[];
  pages?: Record<string, string>;
  provider?: 'offline' | 'none';
  searchDown?: boolean;
}) {
  const queries: string[] = [];
  const platform = {
    listDir: async (path: string) => {
      if (/^E:/i.test(path)) throw new Error('That path is outside the folders Atlas can touch.');
      return opts.files ?? [];
    },
    folderSize: async () => ({
      path: 'D:\\Dev',
      totalBytes: 10,
      fileCount: 40,
      folderCount: 12,
      truncated: false,
    }),
    knownFolder: async (k: string) => `C:\\Users\\Test\\${k}`,
    searchWebWith: async (_id: string, q: string) => {
      queries.push(q);
      if (opts.searchDown) throw new Error('offline: no connection');
      return opts.search ?? [];
    },
    fetchPage: async (url: string): Promise<WebPage> => ({
      title: url,
      url,
      text: opts.pages?.[url] ?? '',
    }),
  } as unknown as Platform;
  const memory = {
    fact: async () => undefined,
    facts: async () => [],
    remember: async () => {},
    record: async () => {},
    episodes: async () => [],
    forget: async () => {},
  } as never;
  const skills = new SkillRegistry({
    capabilities: () =>
      [
        'apps',
        'fs',
        'files',
        'storage',
        'network',
        'system',
        'os',
        'notifications',
        'clipboard',
        'processes',
        'window-control',
      ] as never,
  });
  skills.registerMany(createCoreSkills(platform, memory, skills, createPhrasing()) as never);
  skills.registerMany(createFileFactSkills(platform));
  skills.registerMany(createWebSearchSkills(platform));
  const grammar = new Grammar();
  grammar.addMany(createCoreGrammar(new WorkingMemory()));
  grammar.addMany(createExtraGrammar());
  const provider =
    opts.provider === 'offline'
      ? {
          active: () => ({
            id: 'ollama',
            label: 'Ollama',
            isConfigured: () => true,
            isLocal: () => true,
            ask: (_p: string, h: { onError(r: string): void }) => h.onError('offline'),
          }),
        }
      : undefined;
  const engine = new Engine({ skills, grammar, intelligence: provider as never });
  const said: string[] = [];
  const io: EngineIO = {
    say: (t) => void said.push(t),
    confirm: async () => true,
    showResults: (_r, meta) => void said.push(`[list] ${meta?.title ?? ''}`),
  };
  return { engine, io, said, queries };
}

const dir = (name: string): FileEntry =>
  ({ path: `D:\\Dev\\${name}`, name, ext: '', isDirectory: true }) as FileEntry;
const file = (name: string, modifiedAt: number, sizeBytes = 100): FileEntry =>
  ({
    path: `D:\\Dev\\${name}`,
    name,
    ext: name.split('.').pop() ?? '',
    isDirectory: false,
    modifiedAt,
    sizeBytes,
  }) as FileEntry;

describe('about this PC, with no model', () => {
  const files = [
    dir('Atlas'),
    dir('NovaCut'),
    dir('ReplayGG'),
    file('notes.txt', 3000, 50),
    file('todo.md', 5000, 900),
  ];

  it('counts folders — the question that used to be refused', async () => {
    const r = rig({ files, provider: 'offline' });
    await r.engine.ask('How many folders are there in: D:\\Dev?', r.io);
    const said = r.said.join('\n');
    expect(said).toMatch(/3 folders directly inside D:\\Dev/);
    // The answer is the direct count; walking a big tree for a total is done only when asked for.
    expect(said).not.toMatch(/in total/);
    expect(said).not.toMatch(/language model/i);
  });

  it('adds the total only when asked for everything underneath', async () => {
    const r = rig({ files });
    await r.engine.ask('how many folders are in D:\\Dev including subfolders', r.io);
    expect(r.said.join('\n')).toMatch(/3 folders directly inside D:\\Dev.*12 folders in total/s);
    expect(parseFileQuestion('how many files are in D:\\Dev in total')).toMatchObject({
      op: 'count',
      deep: true,
    });
    expect(parseFileQuestion('how many files are in D:\\Dev')).not.toHaveProperty('deep');
  });

  it('works the same with nothing connected', async () => {
    const r = rig({ files });
    await r.engine.ask('how many files are in D:\\Dev', r.io);
    expect(r.said.join('\n')).toMatch(/2 files directly inside D:\\Dev/);
  });

  it('names the newest and the oldest file', async () => {
    const r = rig({ files });
    await r.engine.ask("what's the newest file in D:\\Dev", r.io);
    expect(r.said.join('\n')).toMatch(/newest file in D:\\Dev is “todo\.md”/);
    const r2 = rig({ files });
    await r2.engine.ask('what is the oldest file in D:\\Dev', r2.io);
    expect(r2.said.join('\n')).toMatch(/oldest file in D:\\Dev is “notes\.txt”/);
  });

  it('leaves "largest" to the storage skills, which scan properly', () => {
    expect(parseFileQuestion("what's the biggest file in my documents folder")).toBeNull();
    expect(parseFileQuestion('what are the largest files in D:\\Dev')).toBeNull();
  });

  it('checks that something exists', async () => {
    const r = rig({ files });
    await r.engine.ask('is there a folder called Atlas in D:\\Dev', r.io);
    expect(r.said.join('\n')).toMatch(/Yes — “Atlas” is a folder/);
    const r2 = rig({ files });
    await r2.engine.ask('is there a folder called Nope in D:\\Dev', r2.io);
    expect(r2.said.join('\n')).toMatch(/nothing called “Nope”/);
  });

  it('counts only the kind of file asked about, and says it only looked at that folder', async () => {
    const r = rig({ files: [file('a.mp4', 1), file('b.mp4', 2), file('c.txt', 3), dir('x')] });
    await r.engine.ask('how many mp4 files are in D:\\Dev', r.io);
    expect(r.said.join('\n')).toMatch(/are 2 \.mp4 files directly inside D:\\Dev/);
  });

  it('a place Atlas may not look at is reported, not guessed', async () => {
    const r = rig({ files });
    await r.engine.ask('how many folders are in E:\\Secret', r.io);
    expect(r.said.join('\n')).toMatch(/outside the folders Atlas can touch/);
  });
});

describe('about the world, with no model', () => {
  const REEL = [
    result(
      'Instagram Reels - Wikipedia',
      'https://en.wikipedia.org/wiki/Instagram',
      'Instagram',
      'wikipedia',
    ),
    result(
      'What are Reels? | Instagram Help Center',
      'https://help.instagram.com/270447560766967',
      'Reels are short, entertaining videos you can make and share on Instagram.',
    ),
  ];
  const PAGES = {
    'https://en.wikipedia.org/wiki/Instagram':
      'Instagram is a photo and video sharing social networking service. Reels is a feature of Instagram that lets people record and share short videos of up to 90 seconds. Reels can be set to music.',
  };

  it('answers "what is a Reel from Instagram" with nothing connected', async () => {
    const r = rig({ search: REEL, pages: PAGES });
    await r.engine.ask('What is a "Reel" from Instagram?', r.io);
    const said = r.said.join('\n');
    expect(said).toMatch(/short.{0,20}videos/i);
    expect(said).toMatch(/Source: .*instagram/i);
    expect(said).not.toMatch(/language model/i);
    expect(r.queries[0]).toBe('Instagram Reel');
  });

  it('answers it the same when the model is configured but cannot be reached', async () => {
    const r = rig({ search: REEL, pages: PAGES, provider: 'offline' });
    await r.engine.ask('What is a Reel from Instagram?', r.io);
    const said = r.said.join('\n');
    expect(said).toMatch(/short.{0,20}videos/i);
    expect(said).not.toMatch(/couldn't reach your language model/i);
  });

  it('says what it did when the search found nothing relevant', async () => {
    const r = rig({
      search: [
        result(
          'Fishing reels',
          'https://shop.example.com/f',
          'Spinning reels are used for freshwater fishing.',
        ),
      ],
    });
    await r.engine.ask('what is a flibbertigibbet from Zorblax', r.io);
    const said = r.said.join('\n');
    expect(said).toMatch(/I searched/);
    expect(said).not.toMatch(/language model/i);
  });

  it('still apologises honestly when the web cannot be reached either', async () => {
    const r = rig({ searchDown: true, provider: 'offline' });
    await r.engine.ask('what is a black hole', r.io);
    expect(r.said.join('\n')).toMatch(/couldn't reach your language model/);
  });

  it('does not search for what the calculator can do', async () => {
    const r = rig({});
    await r.engine.ask('what is the square root of 144', r.io);
    expect(r.queries).toHaveLength(0);
    expect(r.said.join('\n')).toMatch(/12/);
  });
});
