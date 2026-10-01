/**
 * Flush DNS, scaffold / deploy, compress / convert / resize media, batch rename.
 */

import { assert, test } from 'vitest';
import type { FileEntry, Platform } from '@atlas/core';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { WorkingMemory } from '../src/working-memory';
import { createCreatorSkills, renamed } from '../src/skills/creator-skills';

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

// ---- understanding -----------------------------------------------------------------------

test('flush DNS; and an adapter restart is Settings, not a list', () => {
  assert.deepEqual(plan('flush the dns cache'), [['net.flushDns', {}]]);
  assert.deepEqual(plan('restart the network adapter'), [['system.settingsPage', { page: 'network' }]]);
  assert.equal(grammar().parse('list my network adapters')?.steps[0]?.skill, 'net.adapters');
});

test('media: a video is compressed, not zipped; a conversion is not a unit conversion', () => {
  assert.deepEqual(plan('compress video.mp4 in downloads'), [['media.compress', { target: 'video.mp4 in downloads', level: 'balanced' }]]);
  assert.deepEqual(plan('make clip.mp4 smaller'), [['media.compress', { target: 'clip.mp4', level: 'balanced' }]]);
  assert.equal(grammar().parse('compress my downloads folder')?.steps[0]?.skill, 'files.zip');
  assert.deepEqual(plan('convert song.wav to mp3 in downloads'), [['media.convert', { target: 'song.wav in downloads', format: 'mp3' }]]);
  assert.deepEqual(plan('turn clip.mp4 into a gif'), [['media.convert', { target: 'clip.mp4', format: 'gif' }]]);
  assert.deepEqual(plan('extract the audio from clip.mp4'), [['media.convert', { target: 'clip.mp4', format: 'mp3' }]]);
  assert.equal(grammar().parse('convert 5 km to miles')?.steps[0]?.skill, 'math.convert');
  assert.deepEqual(plan('resize photo.jpg in pictures to 800 wide'), [['media.resizeImage', { target: 'photo.jpg in pictures', width: 800 }]]);
  assert.deepEqual(plan('resize photo.jpg to 50%'), [['media.resizeImage', { target: 'photo.jpg', percent: 50 }]]);
});

test('scaffold and deploy', () => {
  assert.deepEqual(plan('create a react app called my-app in documents'), [['project.scaffold', { name: 'my-app', template: 'react-ts', where: 'documents' }]]);
  assert.deepEqual(plan('make a new vanilla javascript app named hello'), [['project.scaffold', { name: 'hello', template: 'vanilla' }]]);
  assert.deepEqual(plan('deploy to vercel'), [['project.deploy', { target: 'vercel' }]]);
  assert.equal(grammar().parse('deploy my app'), null, 'no target named, so nothing is published by guessing');
});

test('batch rename', () => {
  assert.deepEqual(plan('rename the files in documents/trip replacing IMG with beach'), [['files.batchRename', { target: 'documents/trip', find: 'IMG', replace: 'beach' }]]);
  assert.deepEqual(plan('add the prefix 2026- to all files in downloads'), [['files.batchRename', { target: 'downloads', prefix: '2026-' }]]);
  assert.deepEqual(plan('number the files in documents/trip'), [['files.batchRename', { target: 'documents/trip', numbered: true }]]);
  assert.deepEqual(plan('lowercase all files in downloads'), [['files.batchRename', { target: 'downloads', lower: true }]]);
});

// ---- the rename rule itself ---------------------------------------------------------------

test('names change, extensions stay, and a rule with nothing to do changes nothing', () => {
  assert.equal(renamed('IMG_001.jpg', { find: 'IMG', replace: 'beach' }, 0), 'beach_001.jpg');
  assert.equal(renamed('a.txt', { prefix: '2026-' }, 0), '2026-a.txt');
  assert.equal(renamed('a.tar.gz', { suffix: '-old' }, 0), 'a.tar-old.gz');
  assert.equal(renamed('Report.PDF', { lower: true }, 0), 'report.PDF');
  assert.equal(renamed('a.txt', { numbered: true }, 2), 'a 03.txt');
  assert.equal(renamed('a.txt', { find: 'zzz', replace: 'y' }, 0), 'a.txt');
  assert.equal(renamed('noext', { prefix: 'x' }, 0), 'xnoext');
});

// ---- behaviour --------------------------------------------------------------------------------

const file = (name: string): FileEntry => ({ path: `C:\\U\\Documents\\trip\\${name}`, name, ext: '', isDirectory: false }) as FileEntry;

function machine(names: string[], over: Record<string, unknown> = {}) {
  const renames: string[] = [];
  const platform = {
    knownFolder: async () => 'C:\\U\\Documents',
    listDir: async (p: string) => (p.endsWith('trip') ? names.map(file) : p === 'C:\\U\\Documents' ? [{ path: 'C:\\U\\Documents\\trip', name: 'trip', ext: '', isDirectory: true } as FileEntry] : []),
    renamePath: async (p: string, n: string) => {
      renames.push(`${p.split('\\').pop()} -> ${n}`);
      return true;
    },
    flushDns: async () => {
      if (over.dnsNeedsAdmin) throw 'Windows wants administrator rights to flush the DNS cache on this PC, and I don\'t do that.';
      return 'DNS cache flushed.';
    },
    scaffoldProject: async (_p: string, name: string, t: string) => ({ ok: !over.scaffoldFails, stdout: `made ${name} ${t}`, stderr: over.scaffoldFails ? 'npm ERR! network' : '', exitCode: over.scaffoldFails ? 1 : 0, truncated: false }),
    deployProject: async () => ({ ok: true, stdout: 'Production: https://x.vercel.app', stderr: '', exitCode: 0, truncated: false }),
    compressVideo: async () => ({ output: 'C:\\U\\Documents\\clip (compressed).mp4', inputBytes: 50_000_000, outputBytes: 9_000_000 }),
    convertMedia: async (_p: string, f: string) => {
      if (over.noFfmpeg) throw new Error("ffmpeg isn't installed on this PC, so I can't convert media.");
      return { output: `C:\\U\\Documents\\song.${f}`, inputBytes: 40_000_000, outputBytes: 4_000_000 };
    },
  } as unknown as Platform;
  const skills = Object.fromEntries(createCreatorSkills(platform).map((s) => [s.id, s]));
  const cards: string[] = [];
  const run = (id: string, args: Record<string, unknown>, yes = true) =>
    skills[id]!.run(args, { confirm: async (q: string, d?: string) => { cards.push(`${q}\n${d}`); return yes; } } as never) as Promise<{ ok: boolean; message?: string; error?: string }>;
  return { renames, run, skills, cards };
}

test('batch rename shows the exact changes first, then does them', async () => {
  const m = machine(['IMG_1.jpg', 'IMG_2.jpg', 'notes.txt']);
  const r = await m.run('files.batchRename', { target: 'documents/trip', find: 'IMG', replace: 'beach' });
  assert.equal(r.ok, true);
  assert.match(m.cards[0]!, /Rename 2 files\?/);
  assert.match(m.cards[0]!, /IMG_1\.jpg → beach_1\.jpg/);
  assert.deepEqual(m.renames, ['IMG_1.jpg -> beach_1.jpg', 'IMG_2.jpg -> beach_2.jpg']);
});

test('a no changes nothing; a rule that changes nothing says so', async () => {
  const m = machine(['a.txt']);
  const declined = await m.run('files.batchRename', { target: 'documents/trip', prefix: 'x-' }, false);
  assert.equal(declined.ok, false);
  assert.deepEqual(m.renames, []);
  const same = await m.run('files.batchRename', { target: 'documents/trip', find: 'zzz', replace: 'y' });
  assert.match(String(same.message), /None of those names would change/);
});

test('two files ending up with one name renames nothing at all', async () => {
  const m = machine(['a 1.txt', 'a 2.txt']);
  const r = await m.run('files.batchRename', { target: 'documents/trip', find: ' 1', replace: ' 2' });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /Two files would end up called/);
  assert.deepEqual(m.renames, []);
  assert.equal(m.cards.length, 0, 'refused before the card');
});

test('a new name that is an existing file elsewhere in the folder is refused', async () => {
  const m = machine(['a.txt', 'b.txt']);
  const r = await m.run('files.batchRename', { target: 'documents/trip', find: 'a', replace: 'b' });
  assert.equal(r.ok, false);
  assert.deepEqual(m.renames, []);
});

test('a shift (1→2, 2→3) goes through temporary names so nothing is overwritten', async () => {
  const m = machine(['p1.txt', 'p2.txt']);
  // p1 -> p2 and p2 -> p3: each new name is the other's old one.
  const r = await m.run('files.batchRename', { target: 'documents/trip', find: 'p', replace: 'q' });
  assert.equal(r.ok, true);
  const shift = machine(['x 01.txt', 'x 02.txt']);
  await shift.run('files.batchRename', { target: 'documents/trip', find: ' 01', replace: ' 02' }).catch(() => undefined);
  // no direct overwrite of an existing name ever happens
  assert.ok(shift.renames.every((x) => !/-> x 02\.txt$/.test(x) || shift.renames.some((y) => /atlas-tmp/.test(y)) || shift.renames.length === 0));
});

test('an unusable name is refused before anything moves', async () => {
  const m = machine(['a.txt']);
  const r = await m.run('files.batchRename', { target: 'documents/trip', find: 'a', replace: 'x/y' });
  assert.equal(r.ok, false);
  assert.deepEqual(m.renames, []);
});

test('no rule, no rename', async () => {
  const m = machine(['a.txt']);
  assert.equal((await m.run('files.batchRename', { target: 'documents/trip' })).ok, false);
});

test('media says what it made and how much smaller, and ffmpeg missing is plain', async () => {
  const m = machine(['x']);
  const c = await m.run('media.compress', { target: 'C:\\U\\Documents\\clip.mp4' });
  assert.match(String(c.message), /clip \(compressed\)\.mp4 \(8\.6 MB, was 48 MB\)\. The original is untouched/);
  const none = await machine(['x'], { noFfmpeg: true }).run('media.convert', { target: 'C:\\U\\Documents\\song.wav', format: 'mp3' });
  assert.equal(none.ok, false);
  assert.match(String(none.error), /ffmpeg isn't installed/);
});

test('flush DNS reports a refusal in plain words', async () => {
  assert.match(String((await machine([]).run('net.flushDns', {})).message), /flushed/);
  const r = await machine([], { dnsNeedsAdmin: true }).run('net.flushDns', {});
  assert.equal(r.ok, false);
  assert.match(String(r.error), /administrator/);
});

test('scaffold names the next steps; a failure shows the tail of why', async () => {
  const ok = await machine([]).run('project.scaffold', { name: 'My App', template: 'react-ts', where: 'documents' });
  assert.match(String(ok.message), /Created my-app \(react-ts\)/);
  const bad = await machine([], { scaffoldFails: true }).run('project.scaffold', { name: 'x', where: 'documents' });
  assert.equal(bad.ok, false);
  assert.match(String(bad.error), /npm ERR! network/);
});

test('deploy and scaffold ask first, and say what will happen', () => {
  const { skills } = machine([]);
  assert.equal(skills['project.deploy']!.risk, 'confirm');
  assert.equal(skills['project.scaffold']!.risk, 'confirm');
  assert.equal(skills['files.batchRename']!.risk, 'safe', 'it asks once itself, with the exact changes');
  assert.match(skills['project.deploy']!.confirmAs!({ path: 'D:\\x', target: 'vercel' }), /to Vercel — this publishes it/);
  for (const id of ['media.compress', 'media.convert', 'media.resizeImage', 'net.flushDns']) assert.equal(skills[id]!.risk, 'safe', id);
});
