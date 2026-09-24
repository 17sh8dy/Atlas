/**
 * The tidy-up against a folder that actually exists.
 *
 * `organize.test.ts` runs the same flow over an in-memory disk, which proves the
 * logic but not the assumptions the logic makes about a real one: that a file
 * written a second ago really does look "still changing", that a rename across
 * folders really lands, that names differing only by case really do clash on
 * this filesystem. This test lays out a real Downloads-shaped folder under the
 * OS temp directory and drives the real Engine against a `Platform` whose
 * `listDir`/`movePathTo`/`createFolder` mirror `platform.rs` (same entry shape,
 * millisecond timestamps, 500-entry ceiling, no overwrite).
 *
 * Only the Platform is stand-in — it is the seam the Rust half implements, and
 * that half has its own real-disk test (`move_path_to_renames_across_folders…`).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileEntry, Platform } from '@atlas/core';
import { Engine } from '../src/engine';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { createCoreSkills } from '../src/skills/core-skills';
import { createOrganizeSkills, createMemoryJournal } from '../src/skills/organize-skills';
import { SkillRegistry } from '../src/skills/registry';
import { WorkingMemory } from '../src/working-memory';

let root: string;
let downloads: string;

/** Mirrors `list_dir`: one level, lowercase ext, ms timestamps, capped at 500. */
function listDir(path: string, limit = 100): FileEntry[] {
  const cap = Math.min(limit, 500);
  const out: FileEntry[] = [];
  for (const name of readdirSync(path)) {
    if (out.length >= cap) break;
    const full = join(path, name);
    const st = statSync(full);
    const dot = name.lastIndexOf('.');
    out.push({
      path: full,
      name,
      ext: st.isDirectory() || dot <= 0 ? '' : name.slice(dot + 1).toLowerCase(),
      isDirectory: st.isDirectory(),
      sizeBytes: st.isFile() ? st.size : undefined,
      modifiedAt: Math.floor(st.mtimeMs),
    });
  }
  return out;
}

function makePlatform(deleted: string[]): Platform {
  return {
    id: 'node-fs',
    capabilities: async () => ['fs'],
    knownFolder: async () => downloads,
    listDir: async (path: string, limit?: number) => listDir(path, limit),
    createFolder: async (path: string) => {
      if (existsSync(path)) throw new Error('Something is already there.');
      mkdirSync(path);
      return true;
    },
    movePathTo: async (from: string, to: string) => {
      if (existsSync(to)) throw new Error('Something is already there.');
      renameSync(from, to);
      return true;
    },
    pathInfo: async (path: string) => {
      const st = statSync(path);
      return { path, name: path, ext: '', isDirectory: st.isDirectory(), sizeBytes: st.size };
    },
    deletePath: async (path: string) => {
      deleted.push(path);
      return true;
    },
  } as unknown as Platform;
}

function put(rel: string, ageMs: number) {
  const full = join(downloads, rel);
  writeFileSync(full, 'x');
  const when = new Date(Date.now() - ageMs);
  utimesSync(full, when, when);
}

const HOUR = 60 * 60 * 1000;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'atlas-organize-'));
  downloads = join(root, 'Downloads');
  mkdirSync(downloads);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('a real folder, end to end', () => {
  test('tidies it, leaves what it should, undoes it, deletes nothing', async () => {
    put('setup.exe', 5 * HOUR);
    put('vlc.msi', 5 * HOUR);
    put('holiday.PNG', 3 * HOUR); // upper-case extension on disk
    put('report.pdf', 2 * HOUR);
    put('mystery.xyz', 2 * HOUR);
    put('movie.mp4.crdownload', 1 * HOUR); // unfinished
    put('arriving.exe', 5 * 1000); // written five seconds ago
    mkdirSync(join(downloads, 'my-project'));
    writeFileSync(join(downloads, 'my-project', 'index.js'), 'x');
    // A destination that already holds a clashing name.
    mkdirSync(join(downloads, 'Software'));
    writeFileSync(join(downloads, 'Software', 'setup.exe'), 'older one');

    const deleted: string[] = [];
    const platform = makePlatform(deleted);
    const skills = new SkillRegistry({ capabilities: () => ['fs'] });
    skills.registerMany(createCoreSkills(platform, {} as never, skills));
    skills.registerMany(createOrganizeSkills(platform, createMemoryJournal()));
    const working = new WorkingMemory();
    const grammar = new Grammar();
    grammar.addMany(createCoreGrammar(working));
    grammar.addMany(createExtraGrammar());
    const engine = new Engine({ skills, grammar, working });

    const said: string[] = [];
    const cards: Array<{ question: string; detail?: string }> = [];
    const io = {
      say: (t: string) => said.push(t),
      confirm: async (question: string, detail?: string) => {
        cards.push({ question, detail });
        return true;
      },
    };

    await engine.ask(
      'clean up my downloads folder, put installers in Software, images in Images, and ask me before deleting anything',
      io,
    );

    const names = (rel: string) => readdirSync(join(downloads, rel)).sort();
    expect(names('Software')).toEqual(['setup (2).exe', 'setup.exe', 'vlc.msi']);
    expect(names('Images')).toEqual(['holiday.PNG']);
    expect(names('Documents')).toEqual(['report.pdf']);
    // Still where they were: strangers, unfinished, a file still being written, folders.
    expect(names('.').sort()).toEqual(
      ['Documents', 'Images', 'Software', 'arriving.exe', 'movie.mp4.crdownload', 'my-project', 'mystery.xyz'].sort(),
    );
    expect(names('my-project')).toEqual(['index.js']);
    // The older setup.exe was not overwritten.
    expect(statSync(join(downloads, 'Software', 'setup.exe')).size).toBe('older one'.length);

    expect(cards).toHaveLength(1);
    expect(cards[0]!.detail).toMatch(/1 file still changing/);
    expect(deleted).toEqual([]);

    // And back. Every file returns to the name and place it came from — the
    // one that went in as `setup (2).exe` comes home as `setup.exe`.
    cards.length = 0;
    await engine.ask('undo that', io);
    expect(names('.').sort()).toEqual(
      ['Documents', 'Images', 'Software', 'arriving.exe', 'holiday.PNG', 'movie.mp4.crdownload', 'my-project', 'mystery.xyz', 'report.pdf', 'setup.exe', 'vlc.msi'].sort(),
    );
    // What was already in Software before any of this is untouched.
    expect(names('Software')).toEqual(['setup.exe']);
    expect(statSync(join(downloads, 'Software', 'setup.exe')).size).toBe('older one'.length);
    expect(deleted).toEqual([]);
  });
});
