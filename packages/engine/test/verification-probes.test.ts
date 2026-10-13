/**
 * Verification probes: read the machine back, report what was seen, never claim more.
 */
import { describe, expect, test } from 'vitest';
import type { PathInfo, Platform, Plan, ProbeSpec, ProcessEntry, Skill, SkillContext, WindowEntry } from '@atlas/core';
import { summarizeProbes } from '@atlas/core';
import { createProbeRunner } from '../src/verify/probes';
import { VERIFY_DECLARATIONS } from '../src/verify/declarations';
import { Executor } from '../src/planner/executor';
import { SkillRegistry } from '../src/skills/registry';

const info = (path: string, isDirectory: boolean): PathInfo => ({ path, name: path, ext: '', isDirectory, sizeBytes: 0 });

function fakePlatform(
  opts: { paths?: Record<string, boolean>; processes?: () => ProcessEntry[]; windows?: () => WindowEntry[]; refuse?: boolean } = {},
) {
  return {
    async probePath(path: string): Promise<PathInfo> {
      if (opts.refuse) throw new Error('That path is outside the folders Atlas can touch.');
      const isDir = opts.paths?.[path];
      if (isDir === undefined) throw new Error('No such path.');
      return info(path, isDir);
    },
    async runningProcesses() {
      return opts.processes?.() ?? [];
    },
    async listWindows() {
      return opts.windows?.() ?? [];
    },
  } as unknown as Pick<Platform, 'probePath' | 'runningProcesses' | 'listWindows'>;
}

const fast = { waitMs: 30, pollMs: 5 };

describe('reading the machine back', () => {
  test('a path that exists confirms, one that does not contradicts', async () => {
    const run = createProbeRunner(fakePlatform({ paths: { 'D:\\a\\new.txt': false } }), fast);
    const [yes, no] = await run([
      { kind: 'path-is-file', path: 'D:\\a\\new.txt' },
      { kind: 'path-exists', path: 'D:\\a\\missing.txt' },
    ]);
    expect(yes!.state).toBe('confirmed');
    expect(no!.state).toBe('contradicted');
    expect(no!.evidence).toBe('nothing is at missing.txt');
  });

  test('a file where a folder was expected is contradicted, not confirmed', async () => {
    const run = createProbeRunner(fakePlatform({ paths: { 'D:\\a\\thing': false } }), fast);
    const [r] = await run([{ kind: 'path-is-folder', path: 'D:\\a\\thing' }]);
    expect(r!.state).toBe('contradicted');
  });

  test('absence is confirmed only when nothing is there', async () => {
    const run = createProbeRunner(fakePlatform({ paths: { 'D:\\a\\still.txt': false } }), fast);
    const [gone, still] = await run([
      { kind: 'path-absent', path: 'D:\\a\\gone.txt' },
      { kind: 'path-absent', path: 'D:\\a\\still.txt' },
    ]);
    expect(gone!.state).toBe('confirmed');
    expect(still!.state).toBe('contradicted');
  });

  test('a refusal to look is "unknown", never "absent"', async () => {
    const run = createProbeRunner(fakePlatform({ refuse: true }), fast);
    const [r] = await run([{ kind: 'path-absent', path: 'C:\\Windows\\x' }]);
    expect(r!.state).toBe('unknown');
  });

  test('no platform call at all is "unknown"', async () => {
    const run = createProbeRunner({} as never, fast);
    const [r] = await run([{ kind: 'path-exists', path: 'D:\\x' }]);
    expect(r!.state).toBe('unknown');
  });

  test('a program that appears while polling is confirmed', async () => {
    let calls = 0;
    const run = createProbeRunner(
      fakePlatform({ processes: () => (++calls > 2 ? [{ pid: 1, name: 'obs64.exe' } as ProcessEntry] : []) }),
      { waitMs: 500, pollMs: 5 },
    );
    const [r] = await run([{ kind: 'process-running', name: 'obs64' }]);
    expect(r!.state).toBe('confirmed');
  });

  test('a program that never appears is contradicted after the deadline', async () => {
    const run = createProbeRunner(fakePlatform(), fast);
    const [r] = await run([{ kind: 'process-running', name: 'Nothing' }]);
    expect(r!.state).toBe('contradicted');
    expect(r!.evidence).toMatch(/haven’t seen/);
  });

  test('stopping is confirmed when the program is gone', async () => {
    const run = createProbeRunner(fakePlatform(), fast);
    const [r] = await run([{ kind: 'process-stopped', name: 'Chrome' }]);
    expect(r!.state).toBe('confirmed');
  });

  test('an abort leaves the rest unread rather than guessing', async () => {
    const run = createProbeRunner(fakePlatform({ paths: { 'D:\\a': true } }), fast);
    const rs = await run([{ kind: 'path-exists', path: 'D:\\a' }], { aborted: true });
    expect(rs[0]!.state).toBe('unknown');
  });
});

describe('summarizing', () => {
  test('confirmed only when every probe agreed', () => {
    const p: ProbeSpec = { kind: 'path-exists', path: 'x' };
    expect(summarizeProbes([])).toBeNull();
    expect(summarizeProbes([{ probe: p, state: 'confirmed', evidence: 'a' }])!.verified).toBe('confirmed');
    expect(
      summarizeProbes([
        { probe: p, state: 'confirmed', evidence: 'a' },
        { probe: p, state: 'unknown', evidence: 'b' },
      ])!.verified,
    ).toBe('unconfirmed');
  });
});

describe('the declarations', () => {
  const ok = { ok: true };

  test('creating, deleting, moving and renaming name the right paths', () => {
    expect(VERIFY_DECLARATIONS['files.create']!({ path: 'D:\\x\\n.txt' }, ok)).toEqual([
      { kind: 'path-is-file', path: 'D:\\x\\n.txt', announce: true },
    ]);
    expect(VERIFY_DECLARATIONS['files.delete']!({ path: 'D:\\x\\n.txt' }, ok)[0]).toMatchObject({ kind: 'path-absent' });
    expect(VERIFY_DECLARATIONS['files.move']!({ path: 'D:\\x\\n.txt', destDir: 'E:\\y' }, ok)).toEqual([
      { kind: 'path-exists', path: 'E:\\y\\n.txt' },
    ]);
    expect(VERIFY_DECLARATIONS['files.rename']!({ path: 'D:\\x\\n.txt', newName: 'm.txt' }, ok)).toEqual([
      { kind: 'path-exists', path: 'D:\\x\\m.txt' },
    ]);
  });

  test('a missing argument declares nothing rather than something wrong', () => {
    expect(VERIFY_DECLARATIONS['files.create']!({}, ok)).toEqual([]);
    expect(VERIFY_DECLARATIONS['files.move']!({ path: 'D:\\x' }, ok)).toEqual([]);
  });

  test('only immediate disk facts are ever announced', () => {
    const args = { path: 'D:\\a\\b', destDir: 'E:\\c', newName: 'd', name: 'App' };
    const announced = Object.entries(VERIFY_DECLARATIONS)
      .filter(([, d]) => d(args, ok).some((s) => s.announce))
      .map(([id]) => id)
      .sort();
    expect(announced).toEqual(['files.create', 'files.createFolder', 'files.delete']);
  });
});

describe('through the executor', () => {
  function rig(paths: Record<string, boolean>) {
    const registry = new SkillRegistry({ capabilities: () => [] });
    const create: Skill = {
      id: 'files.create',
      label: 'Create a file',
      domain: 'files',
      description: 'create',
      risk: 'safe',
      params: { path: { type: 'string', required: true, description: 'p' } },
      run: async () => ({ ok: true, message: 'Created.' }),
    };
    const plain: Skill = {
      id: 'x.plain',
      label: 'Plain',
      domain: 'x',
      description: 'd',
      risk: 'safe',
      params: {},
      run: async () => ({ ok: true, message: 'ok' }),
    };
    registry.registerMany([create, plain]);
    const said: string[] = [];
    const ctx = { say: (t: string) => said.push(t), confirm: async () => true } as unknown as SkillContext;
    const verify = createProbeRunner(fakePlatform({ paths }), fast);
    const run = (plan: Plan, withVerify = true) => new Executor(registry).run(plan, ctx, withVerify ? { verify } : {});
    return { run, said };
  }
  const plan = (id: string, args = {}): Plan => ({ source: 'grammar', intent: 't', confidence: 1, steps: [{ skill: id, args }] });

  test('a step whose effect is seen is marked confirmed, with what was seen', async () => {
    const r = rig({ 'D:\\a\\n.txt': false });
    const out = await r.run(plan('files.create', { path: 'D:\\a\\n.txt' }));
    expect(out.outcomes[0]).toMatchObject({ ok: true, verified: 'confirmed', evidence: 'n.txt is there' });
  });

  test('a success report the machine contradicts is flagged and said aloud, and stays ok', async () => {
    const r = rig({});
    const out = await r.run(plan('files.create', { path: 'D:\\a\\n.txt' }));
    expect(out.outcomes[0]).toMatchObject({ ok: true, verified: 'unconfirmed' });
    expect(r.said.join('\n')).toMatch(/reported success, but nothing is at n\.txt/);
  });

  test('without a runner nothing is read and nothing is called confirmed', async () => {
    const r = rig({ 'D:\\a\\n.txt': false });
    const out = await r.run(plan('files.create', { path: 'D:\\a\\n.txt' }), false);
    expect(out.outcomes[0]!.verified).toBeUndefined();
  });

  test('a skill that declares nothing is never marked confirmed', async () => {
    const r = rig({});
    const out = await r.run(plan('x.plain'));
    expect(out.outcomes[0]!.verified).toBeUndefined();
  });

  test('a failed step is not probed', async () => {
    const registry = new SkillRegistry({ capabilities: () => [] });
    registry.register({
      id: 'files.create',
      label: 'Create',
      domain: 'files',
      description: 'd',
      risk: 'safe',
      params: {},
      run: async () => ({ ok: false, error: 'No.' }),
    });
    let probed = false;
    const ctx = { say: () => {}, confirm: async () => true } as unknown as SkillContext;
    const out = await new Executor(registry).run(plan('files.create', { path: 'D:\\x' }), ctx, {
      verify: async (p) => {
        probed = true;
        return p.map((probe) => ({ probe, state: 'confirmed' as const, evidence: 'x' }));
      },
    });
    expect(probed).toBe(false);
    expect(out.outcomes[0]!.ok).toBe(false);
  });
});
