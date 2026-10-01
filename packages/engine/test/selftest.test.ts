import { assert, test } from 'vitest';
import type { Platform } from '@atlas/core';
import { SkillRegistry } from '../src/skills/registry';
import { createSelfTestSkills } from '../src/skills/selftest-skills';

function run(platform: Partial<Platform>, route: (t: string) => string | null, extra = [] as never[]) {
  const registry = new SkillRegistry();
  registry.register({ id: 'a.one', label: 'One', description: 'd', domain: 'x', risk: 'safe', examples: ['do one'], run: () => ({ ok: true }) } as never);
  registry.register({ id: 'a.two', label: 'Two', description: 'd', domain: 'x', risk: 'safe', examples: ['do two'], run: () => ({ ok: true }) } as never);
  const skill = createSelfTestSkills({ skills: registry, platform: platform as Platform, route, extraChecks: () => extra })[0]!;
  const shown: Array<Array<{ title: string }>> = [];
  return skill.run({}, { showResults: (rows: Array<{ title: string }>) => shown.push(rows) } as never).then((r) => ({ r: r as { ok: boolean; message?: string }, rows: shown[0] ?? [] }));
}

const healthy: Partial<Platform> = {
  systemInfo: async () => ({ memoryTotalBytes: 8, cpuPercent: 1, memoryUsedBytes: 1, disks: [], uptimeSeconds: 1 }) as never,
  runningProcesses: async () => [{ pid: 1, name: 'x.exe' }],
  listApps: async () => [{ id: 'a', name: 'A', target: 'a' }],
  allowedFolders: async () => ['/home/me'],
  toolVersions: async () => ({ git: 'git version 2', ffmpeg: 'ffmpeg version 7 x' }),
};

test('a healthy install passes every check', async () => {
  const { r, rows } = await run(healthy, (t) => (t === 'do one' ? 'a.one' : 'a.two'));
  assert.equal(r.ok, true);
  assert.match(String(r.message), /checks passed/);
  assert.ok(rows.every((x) => x.title.endsWith('PASS')), JSON.stringify(rows));
});

test('a phrasing that reaches the wrong skill is noted, not a failure', async () => {
  const { r, rows } = await run(healthy, () => 'a.one');
  assert.equal(r.ok, true);
  assert.ok(rows.some((x) => x.title.includes('Phrasings') && x.title.endsWith('WARN')));
});

test('no allowed folders is a real failure', async () => {
  const { r } = await run({ ...healthy, allowedFolders: async () => [] }, (t) => (t === 'do one' ? 'a.one' : 'a.two'));
  assert.equal(r.ok, false);
  assert.match(String(r.message), /Allowed folders/);
});

test('a check that throws is a failure, not a crash', async () => {
  const { r } = await run({ ...healthy, listApps: async () => { throw new Error('boom'); } }, (t) => (t === 'do one' ? 'a.one' : 'a.two'));
  assert.equal(r.ok, false);
});

test('missing git or ffmpeg is a note that names what is missing', async () => {
  const { rows } = await run({ ...healthy, toolVersions: async () => ({ git: 'git version 2', ffmpeg: null }) }, (t) => (t === 'do one' ? 'a.one' : 'a.two'));
  assert.ok(rows.some((x) => x.title.includes('Git and ffmpeg') && x.title.endsWith('WARN')));
});
