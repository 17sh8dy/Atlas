/**
 * Zip, unzip, duplicates, what changed, attributes, copy a path — how they are
 * understood, how a spoken target becomes a path, and what each asks of the
 * machine.
 */

import { assert, test } from 'vitest';
import type { FileEntry, Platform } from '@atlas/core';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { WorkingMemory } from '../src/working-memory';
import { createFileToolsSkills } from '../src/skills/file-tools-skills';
import { resolveTarget } from '../src/skills/locate';

function grammar(): Grammar {
  const g = new Grammar();
  g.addMany(createCoreGrammar(new WorkingMemory()));
  g.addMany(createExtraGrammar());
  return g;
}
const plan = (text: string) =>
  grammar()
    .parse(text)
    ?.steps.map((s) => [s.skill, s.args]);

// ---- how it is understood ---------------------------------------------------------

test('zip and unzip', () => {
  assert.deepEqual(plan('zip my downloads folder'), [['files.zip', { target: 'downloads folder' }]]);
  assert.deepEqual(plan('zip report.docx in documents'), [['files.zip', { target: 'report.docx in documents' }]]);
  assert.deepEqual(plan('compress C:\\Users\\me\\Reports'), [['files.zip', { target: 'C:\\Users\\me\\Reports' }]]);
  assert.deepEqual(plan('unzip photos.zip in downloads'), [['files.unzip', { target: 'photos.zip in downloads' }]]);
  assert.deepEqual(plan('extract the archive in downloads'), [['files.unzip', { target: 'archive in downloads' }]]);
});

test('"zip code" and "extract the emails" are not file operations', () => {
  assert.notEqual(grammar().parse('zip code')?.steps[0]?.skill, 'files.zip');
  assert.equal(grammar().parse('extract the emails from "a@b.com and c@d.com"')?.steps[0]?.skill, 'text.extract');
});

test('duplicates, with a sensible default place', () => {
  assert.deepEqual(plan('find duplicate files in documents'), [['files.duplicates', { target: 'documents' }]]);
  assert.deepEqual(plan('find duplicate files'), [['files.duplicates', { target: 'downloads' }]]);
  assert.deepEqual(plan('are there any duplicate files in my pictures'), [['files.duplicates', { target: 'pictures' }]]);
});

test('what changed, with a time span', () => {
  assert.deepEqual(plan('what changed in downloads today'), [['files.recent', { target: 'downloads', hours: 24 }]]);
  assert.deepEqual(plan('what changed in documents this week'), [['files.recent', { target: 'documents', hours: 168 }]]);
  assert.deepEqual(plan('what changed in downloads in the last 3 hours'), [['files.recent', { target: 'downloads', hours: 3 }]]);
  assert.deepEqual(plan("what's new in my desktop yesterday"), [['files.recent', { target: 'desktop', hours: 48 }]]);
});

test('hide is only a file operation when a file is meant', () => {
  assert.deepEqual(plan('hide secret.txt'), [['files.attributes', { target: 'secret.txt', hidden: true }]]);
  assert.deepEqual(plan('unhide notes in documents'), [['files.attributes', { target: 'notes in documents', hidden: false }]]);
  assert.deepEqual(plan('make notes.txt read only'), [['files.attributes', { target: 'notes.txt', readOnly: true }]]);
  assert.deepEqual(plan('make notes.txt editable'), [['files.attributes', { target: 'notes.txt', readOnly: false }]]);
  assert.deepEqual(plan('is notes.txt hidden'), [['files.attributes', { target: 'notes.txt' }]]);
  // a bare "hide" is still Atlas dismissing itself
  assert.notEqual(grammar().parse('hide')?.steps[0]?.skill, 'files.attributes');
});

test('copy a path', () => {
  assert.deepEqual(plan('copy the path of notes.txt in documents'), [['files.copyPath', { target: 'notes.txt in documents' }]]);
  assert.deepEqual(plan("copy notes.txt's path"), [['files.copyPath', { target: 'notes.txt' }]]);
});

// ---- a spoken target becomes a path ----------------------------------------------------

const file = (path: string, isDirectory = false): FileEntry =>
  ({ path, name: path.split(/[\\/]/).pop()!, ext: '', isDirectory }) as FileEntry;

function machine(tree: Record<string, FileEntry[]>) {
  const calls: string[] = [];
  const known: Record<string, string> = {
    desktop: 'C:\\U\\Desktop',
    downloads: 'C:\\U\\Downloads',
    documents: 'C:\\U\\Documents',
    home: 'C:\\U',
    pictures: 'C:\\U\\Pictures',
    music: 'C:\\U\\Music',
    videos: 'C:\\U\\Videos',
  };
  const attrs = { readOnly: false, hidden: false, system: false };
  const platform = {
    knownFolder: async (id: string) => known[id]!,
    listDir: async (p: string) => tree[p] ?? [],
    searchFiles: async () => [] as FileEntry[],
    zipPath: async (p: string) => {
      calls.push(`zip ${p}`);
      return `${p}.zip`;
    },
    unzipPath: async (p: string) => {
      calls.push(`unzip ${p}`);
      return p.replace(/\.zip$/, '');
    },
    findDuplicates: async (p: string) => {
      calls.push(`dups ${p}`);
      return {
        groups: [{ sizeBytes: 2048, paths: [`${p}\\a.bin`, `${p}\\a (1).bin`] }],
        wastedBytes: 2048,
        truncated: false,
      };
    },
    recentChanges: async (p: string, hours: number) => {
      calls.push(`recent ${p} ${hours}`);
      return [{ path: `${p}\\x.txt`, name: 'x.txt', sizeBytes: 10, modifiedAt: Date.now() }];
    },
    fileAttributes: async () => ({ ...attrs }),
    setFileAttributes: async (p: string, ro: boolean | null, h: boolean | null) => {
      calls.push(`attrs ${p} ro=${ro} hidden=${h}`);
      if (ro !== null) attrs.readOnly = ro;
      if (h !== null) attrs.hidden = h;
      return { ...attrs };
    },
    writeClipboard: async (t: string) => {
      calls.push(`clip ${t}`);
      return true;
    },
  } as unknown as Platform;
  return { platform, calls };
}

test('places, a name in a place, and a full path', async () => {
  const { platform } = machine({
    'C:\\U\\Documents': [file('C:\\U\\Documents\\notes.txt'), file('C:\\U\\Documents\\notes backup.txt')],
    'C:\\U\\Downloads': [file('C:\\U\\Downloads\\photos.zip')],
  });
  assert.deepEqual(await resolveTarget(platform, undefined, 'downloads'), { ok: true, path: 'C:\\U\\Downloads', isDirectory: true });
  assert.deepEqual(await resolveTarget(platform, undefined, 'my downloads folder'), { ok: true, path: 'C:\\U\\Downloads', isDirectory: true });
  assert.deepEqual(await resolveTarget(platform, undefined, 'photos.zip in downloads'), { ok: true, path: 'C:\\U\\Downloads\\photos.zip', isDirectory: false });
  assert.deepEqual(await resolveTarget(platform, undefined, 'D:\\Anything\\x.txt'), { ok: true, path: 'D:\\Anything\\x.txt' });
  // the exact name wins over a longer one that merely contains it
  const exact = await resolveTarget(platform, undefined, 'notes.txt in documents');
  assert.equal(exact.ok && exact.path, 'C:\\U\\Documents\\notes.txt');
});

test('a bare name is found in the usual places; two candidates are reported, never guessed', async () => {
  const one = machine({ 'C:\\U\\Downloads': [file('C:\\U\\Downloads\\photos.zip')] });
  const r = await resolveTarget(one.platform, undefined, 'photos.zip');
  assert.equal(r.ok && r.path, 'C:\\U\\Downloads\\photos.zip');

  const two = machine({
    'C:\\U\\Downloads': [file('C:\\U\\Downloads\\report.pdf')],
    'C:\\U\\Desktop': [file('C:\\U\\Desktop\\report.pdf')],
  });
  const amb = await resolveTarget(two.platform, undefined, 'report.pdf');
  assert.equal(amb.ok, false);
  assert.match(!amb.ok ? amb.error : '', /more than one thing/);
});

test('a name that is nowhere is said plainly', async () => {
  const { platform } = machine({});
  const r = await resolveTarget(platform, undefined, 'ghost.txt');
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error : '', /couldn't find “ghost.txt”/);
});

test('a remembered name resolves', async () => {
  const { platform } = machine({});
  const memory = { fact: async (_k: string, s: string) => (s === 'work folder' ? { value: 'D:\\Dev' } : undefined) } as never;
  const r = await resolveTarget(platform, memory, 'my work folder');
  assert.equal(r.ok && r.path, 'D:\\Dev');
});

// ---- what each asks of the machine -----------------------------------------------------

function run(skillsOf: ReturnType<typeof createFileToolsSkills>, id: string, args: Record<string, unknown>) {
  const shown: unknown[] = [];
  const skill = skillsOf.find((s) => s.id === id)!;
  return skill
    .run(args, { showResults: (rows: unknown) => shown.push(rows) } as never)
    .then((r) => ({ r: r as { ok: boolean; message?: string; error?: string }, shown }));
}

test('zip and unzip resolve the words, and report what they made', async () => {
  const { platform, calls } = machine({ 'C:\\U\\Downloads': [file('C:\\U\\Downloads\\photos.zip')] });
  const skills = createFileToolsSkills(platform);
  const z = await run(skills, 'files.zip', { target: 'downloads' });
  assert.equal(z.r.ok, true);
  assert.deepEqual(calls, ['zip C:\\U\\Downloads']);
  assert.equal(z.shown.length, 1);
  const u = await run(skills, 'files.unzip', { target: 'photos.zip in downloads' });
  assert.match(String(u.r.message), /Unzipped photos.zip → photos/);
});

test('an unresolvable target asks the machine for nothing', async () => {
  const { platform, calls } = machine({});
  const skills = createFileToolsSkills(platform);
  const r = await run(skills, 'files.zip', { target: 'ghost.txt' });
  assert.equal(r.r.ok, false);
  assert.equal(calls.length, 0);
});

test('a machine refusal is passed on in its own words', async () => {
  const { platform } = machine({});
  (platform as unknown as { zipPath: () => Promise<string> }).zipPath = async () => {
    throw 'That is too big to zip from here (over 50,000 files or 4 GB).';
  };
  const r = await run(createFileToolsSkills(platform), 'files.zip', { target: 'D:\\Big' });
  assert.equal(r.r.ok, false);
  assert.match(String(r.r.error), /too big to zip/);
});

test('duplicates are reported, and nothing is deleted', async () => {
  const { platform, calls } = machine({});
  const { r, shown } = await run(createFileToolsSkills(platform), 'files.duplicates', { target: 'downloads' });
  assert.equal(r.ok, true);
  assert.match(String(r.message), /1 set of duplicates .* I haven't touched any of them/);
  assert.ok(calls.every((c) => c.startsWith('dups')), 'only a read');
  assert.equal(shown.length, 1);
});

test('what changed reads back the span in words', async () => {
  const { platform, calls } = machine({});
  const r = await run(createFileToolsSkills(platform), 'files.recent', { target: 'downloads', hours: 168 });
  assert.match(String(r.r.message), /last 7 days/);
  assert.deepEqual(calls, ['recent C:\\U\\Downloads 168']);
});

test('attributes: reading is free, changing asks', async () => {
  const { platform, calls } = machine({ 'C:\\U\\Desktop': [file('C:\\U\\Desktop\\secret.txt')] });
  const skills = createFileToolsSkills(platform);
  const skill = skills.find((s) => s.id === 'files.attributes')!;
  assert.equal(skill.riskFor?.({ target: 'secret.txt' }), 'safe');
  assert.equal(skill.riskFor?.({ target: 'secret.txt', hidden: true }), undefined);
  assert.equal(skill.risk, 'confirm');
  const read = await run(skills, 'files.attributes', { target: 'secret.txt' });
  assert.match(String(read.r.message), /visible, editable/);
  assert.equal(calls.length, 0);
  const hid = await run(skills, 'files.attributes', { target: 'secret.txt', hidden: true });
  assert.match(String(hid.r.message), /hidden, editable/);
  assert.deepEqual(calls, ['attrs C:\\U\\Desktop\\secret.txt ro=null hidden=true']);
});

test('copy a path puts exactly the resolved path on the clipboard', async () => {
  const { platform, calls } = machine({ 'C:\\U\\Documents': [file('C:\\U\\Documents\\notes.txt')] });
  const r = await run(createFileToolsSkills(platform), 'files.copyPath', { target: 'notes.txt in documents' });
  assert.equal(r.r.ok, true);
  assert.deepEqual(calls, ['clip C:\\U\\Documents\\notes.txt']);
});

test('zip and unzip create only; they are safe to do without asking', () => {
  const { platform } = machine({});
  const byId = Object.fromEntries(createFileToolsSkills(platform).map((s) => [s.id, s]));
  for (const id of ['files.zip', 'files.unzip', 'files.duplicates', 'files.recent', 'files.copyPath']) {
    assert.equal(byId[id]!.risk, 'safe', id);
  }
});

test('a folder inside a folder, said either way', async () => {
  const docs = 'C:\\U\\Documents';
  const proj = `${docs}\\proj`;
  const { platform } = machine({
    [docs]: [file(proj, true)],
    [proj]: [file(`${proj}\\a.txt`)],
  });
  const a = await resolveTarget(platform, undefined, 'documents/proj');
  assert.equal(a.ok && a.path, proj);
  const b = await resolveTarget(platform, undefined, 'a.txt in proj in documents');
  assert.equal(b.ok && b.path, `${proj}\\a.txt`);
  const c = await resolveTarget(platform, undefined, 'documents/proj/a.txt');
  assert.equal(c.ok && c.path, `${proj}\\a.txt`);
});
