/** Tool-catalog pass, batch 1: system tools, restart an app, lint/typecheck/format, search a site, skill search. */

import { assert, test } from 'vitest';
import type { Platform } from '@atlas/core';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { WorkingMemory } from '../src/working-memory';
import { createCatalogSkills } from '../src/skills/catalog-skills';
import { SkillRegistry } from '../src/skills/registry';

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

test('more system tools open by name', () => {
  assert.deepEqual(plan('open event viewer'), [['system.openTool', { tool: 'event-viewer' }]]);
  assert.deepEqual(plan('open disk management'), [['system.openTool', { tool: 'disk-management' }]]);
  assert.deepEqual(plan('show me the resource monitor'), [['system.openTool', { tool: 'resource-monitor' }]]);
  assert.deepEqual(plan('open the registry editor'), [['system.openTool', { tool: 'registry-editor' }]]);
  assert.deepEqual(plan('open services'), [['system.openTool', { tool: 'services' }]]);
  // a service by name is still a service
  assert.equal(grammar().parse('restart the print spooler service')?.steps[0]?.skill, 'service.restart');
});

test('restart an app ends it, then opens it again — and never means the PC', () => {
  assert.deepEqual(plan('restart discord'), [['app.restart', { name: 'discord' }]]);
  assert.equal(plan('restart my computer')?.[0]?.[0], 'system.power');
  assert.equal(plan('restart explorer')?.[0]?.[0], 'system.restartExplorer');
  assert.equal(plan('restart')?.[0]?.[0], 'system.power');
});

test('lint, typecheck and format are the project’s own scripts', () => {
  assert.deepEqual(plan('run the linter'), [['build.run', { target: 'lint' }]]);
  assert.deepEqual(plan('run typecheck in D:\\Dev\\Atlas'), [['build.run', { path: 'D:\\Dev\\Atlas', target: 'typecheck' }]]);
  assert.deepEqual(plan('run the formatter'), [['build.run', { target: 'format' }]]);
  // tests keep their own skill
  assert.equal(plan('run the tests')?.[0]?.[0], 'test.run');
});

test('searching a particular site', () => {
  assert.deepEqual(plan('search github for tauri'), [['web.searchSite', { site: 'github', query: 'tauri' }]]);
  assert.deepEqual(plan('search reddit for best mechanical keyboard'), [['web.searchSite', { site: 'reddit', query: 'best mechanical keyboard' }]]);
  assert.deepEqual(plan('find rust async on stackoverflow'), [['web.searchSite', { site: 'stackoverflow', query: 'rust async' }]]);
  assert.deepEqual(plan('search example.com for pricing'), [['web.searchSite', { site: 'example.com', query: 'pricing' }]]);
  // the sites that already had a skill keep it
  assert.equal(plan('search youtube for lofi')?.[0]?.[0], 'web.searchYoutube');
});

function searchSite(site: string, query: string) {
  const opened: string[] = [];
  const platform = { openUrl: async (u: string) => (opened.push(u), true) } as unknown as Platform;
  const skill = createCatalogSkills(platform).find((s) => s.id === 'web.searchSite')!;
  return skill.run({ site, query }, {} as never).then((r) => ({ r: r as { ok: boolean; message?: string; error?: string }, opened }));
}

test('it opens the site’s own search, or a web search limited to the domain', async () => {
  const gh = await searchSite('github', 'tauri v2');
  assert.equal(gh.opened[0], 'https://github.com/search?q=tauri%20v2');
  const other = await searchSite('Example.com', 'pricing');
  assert.match(other.opened[0]!, /google\.com\/search\?q=site%3Aexample\.com%20pricing/);
  const bad = await searchSite('my cousin', 'x');
  assert.equal(bad.r.ok, false);
  assert.equal(bad.opened.length, 0);
});

test('"do you have a skill for…" searches Atlas’s own skills', async () => {
  assert.deepEqual(plan('can you do anything with zip files'), [['engine.searchSkills', { query: 'zip files' }]]);
  const registry = new SkillRegistry();
  registry.register({ id: 'files.zip', label: 'Zip files', description: 'Compress files into a zip.', domain: 'files', risk: 'safe', examples: ['zip my folder'], run: () => ({ ok: true }) } as never);
  registry.register({ id: 'x.other', label: 'Other', description: 'unrelated', domain: 'x', risk: 'safe', run: () => ({ ok: true }) } as never);
  const shown: unknown[][] = [];
  const skill = createCatalogSkills({} as Platform, registry).find((s) => s.id === 'engine.searchSkills')!;
  await skill.run({ query: 'zip' }, { showResults: (rows: unknown[]) => shown.push(rows) } as never);
  assert.equal(shown[0]!.length, 1);
});

test('file questions: hash, zip contents, find by type/size/age, empty, compare folders', () => {
  assert.deepEqual(plan('sha256 of setup.exe in downloads'), [['files.hash', { target: 'setup.exe in downloads' }]]);
  assert.deepEqual(plan('what is in photos.zip in downloads'), [['files.listArchive', { target: 'photos.zip in downloads' }]]);
  assert.deepEqual(plan('find all pdfs in downloads'), [['files.search', { where: 'downloads', ext: 'pdf' }]]);
  assert.deepEqual(plan('find mp4 files bigger than 500 mb in videos'), [['files.search', { where: 'videos', minBytes: 500 * 1024 ** 2, ext: 'mp4' }]]);
  assert.deepEqual(plan('find files older than 90 days in documents'), [['files.search', { where: 'documents', olderDays: 90 }]]);
  assert.deepEqual(plan('find empty folders in documents'), [['files.findEmpty', { kind: 'folders', where: 'documents' }]]);
  assert.deepEqual(plan('compare folders D:\\Dev\\A and D:\\Dev\\B'), [['files.compareFolders', { a: 'D:\\Dev\\A', b: 'D:\\Dev\\B' }]]);
  // an ordinary find is still files.find
  assert.equal(plan('find notes in documents')?.[0]?.[0], 'files.find');
});

test('git extras', () => {
  assert.deepEqual(plan('merge branch dev'), [['git.merge', { branch: 'dev' }]]);
  assert.deepEqual(plan('git merge feature/x'), [['git.merge', { branch: 'feature/x' }]]);
  assert.deepEqual(plan('tag this commit v1.0.6'), [['git.tag', { name: 'v1.0.6' }]]);
  assert.deepEqual(plan('list git tags'), [['git.tags', {}]]);
  assert.deepEqual(plan('unstage src/main.rs'), [['git.unstage', { file: 'src/main.rs' }]]);
  assert.deepEqual(plan('discard my changes to src/main.rs'), [['git.discardChanges', { file: 'src/main.rs' }]]);
  assert.deepEqual(plan('git init'), [['git.init', {}]]);
  // not a branch merge
  assert.notEqual(plan('merge these pdfs')?.[0]?.[0], 'git.merge');
});

test('network and system reads', () => {
  assert.deepEqual(plan('dns lookup github.com'), [['net.dnsLookup', { host: 'github.com' }]]);
  assert.deepEqual(plan('what is the ip of github.com'), [['net.dnsLookup', { host: 'github.com' }]]);
  assert.deepEqual(plan('trace route to github.com'), [['net.traceroute', { host: 'github.com' }]]);
  assert.deepEqual(plan('what is my bios version'), [['system.firmware', {}]]);
  assert.deepEqual(plan('what is my computer name'), [['system.firmware', {}]]);
  assert.deepEqual(plan('is the firewall on'), [['security.status', {}]]);
  assert.deepEqual(plan('where is discord running from'), [['system.processInfo', { name: 'discord' }]]);
  // "my ip" is still the adapter question
  assert.equal(plan("what's my ip")?.[0]?.[0], 'net.ip');
});

test('the new git skills fall back to the current project like the old ones', async () => {
  const { PROJECT_PATH_SKILLS: PROJECT_SKILLS } = await import('../src/skills/project-context');
  for (const id of ['git.merge', 'git.tag', 'git.tags', 'git.unstage', 'git.discardChanges', 'git.init']) {
    assert.ok(PROJECT_SKILLS.has(id), id);
  }
});


test('media: info, trim, frame, picture edits', () => {
  assert.deepEqual(plan('how long is clip.mp4 in videos'), [['media.info', { target: 'clip.mp4 in videos' }]]);
  assert.deepEqual(plan('what resolution is photo.png in pictures'), [['media.info', { target: 'photo.png in pictures' }]]);
  assert.deepEqual(plan('trim clip.mp4 in videos from 10 to 1:30'), [['media.trim', { target: 'clip.mp4 in videos', start: 10, end: 90 }]]);
  assert.deepEqual(plan('grab a frame from clip.mp4 in videos at 12'), [['media.frame', { target: 'clip.mp4 in videos', at: 12 }]]);
  assert.deepEqual(plan('rotate photo.png in pictures 90 degrees'), [['media.edit', { target: 'photo.png in pictures', op: 'rotate', amount: 90 }]]);
  assert.deepEqual(plan('rotate photo.png in pictures 90 degrees left'), [['media.edit', { target: 'photo.png in pictures', op: 'rotate', amount: 270 }]]);
  assert.deepEqual(plan('flip photo.png in pictures horizontally'), [['media.edit', { target: 'photo.png in pictures', op: 'flip', amount: 0 }]]);
  assert.deepEqual(plan('crop photo.png in pictures to a square'), [['media.edit', { target: 'photo.png in pictures', op: 'square' }]]);
  assert.deepEqual(plan('make a thumbnail of photo.png in pictures'), [['media.edit', { target: 'photo.png in pictures', op: 'thumbnail' }]]);
});


test('duplicate, shortcut and cleanup phrasings', () => {
  assert.deepEqual(plan('duplicate the folder D:\\Dev\\Notes'), [['files.duplicate', { target: 'D:\\Dev\\Notes' }]]);
  assert.deepEqual(plan('make a copy of report.docx in documents'), [['files.duplicate', { target: 'report.docx in documents' }]]);
  assert.deepEqual(plan('make a shortcut to D:\\Dev\\Atlas on my desktop'), [['files.createShortcut', { target: 'D:\\Dev\\Atlas', where: 'desktop' }]]);
  assert.deepEqual(plan('create a shortcut to https://github.com'), [['files.createShortcut', { target: 'https://github.com' }]]);
  assert.deepEqual(plan('clean my temp files'), [['cleanup.clean', { kind: 'temp' }]]);
  assert.deepEqual(plan('clean up old installers'), [['cleanup.clean', { kind: 'installers' }]]);
  assert.deepEqual(plan('delete my crash dumps'), [['cleanup.clean', { kind: 'crashdumps' }]]);
  assert.deepEqual(plan('what can i clean up'), [['cleanup.review', {}]]);
  assert.deepEqual(plan('review my temp files'), [['cleanup.review', { kind: 'temp' }]]);
});


test('self-test phrasing', () => {
  assert.deepEqual(plan('run a self test'), [['engine.selfTest', {}]]);
  assert.deepEqual(plan('is atlas working properly'), [['engine.selfTest', {}]]);
});


test('clipboard history phrasing', () => {
  assert.deepEqual(plan('show my clipboard history'), [['clipboard.history', {}]]);
  assert.deepEqual(plan('what did i copy earlier'), [['clipboard.history', {}]]);
  assert.deepEqual(plan('copy clipboard item 2 again'), [['clipboard.restore', { n: 2 }]]);
  assert.deepEqual(plan('clear my clipboard history'), [['clipboard.clearHistory', {}]]);
});


test('find a file by name keeps the name and drops the place', () => {
  assert.deepEqual(plan('find notes.txt in documents'), [['files.find', { query: 'notes.txt' }]]);
  assert.deepEqual(plan('find my resume.docx in downloads'), [['files.find', { query: 'resume.docx' }]]);
  assert.deepEqual(plan('find report.pdf'), [['files.find', { query: 'report.pdf' }]]);
  assert.deepEqual(plan('find tax pdf'), [['files.find', { query: 'tax', kind: 'document' }]]);
  assert.notEqual((plan('find notes in documents')?.[0]?.[1] as { query?: string })?.query, 'in');
});
