/**
 * `createDevToolsSkills` against a scripted `Platform` — no real process ever
 * spawns here; the Rust side has its own tests (`devtools.rs`) for the parts
 * that only make sense as unit tests over real subprocess output (git
 * porcelain, ripgrep lines, project detection on a real temp folder). This
 * file is about the TS skill layer: message shaping, risk tiers, and the
 * (system, target) → DevTool mapping `build.run`/`test.run` do before ever
 * reaching the platform.
 */

import { test, assert } from 'vitest';
import type { DevTool, Platform } from '@atlas/core';
import { createDevToolsSkills } from '../src/skills/devtools-skills';

function stubPlatform(overrides: Partial<Platform> = {}): Platform {
  return {
    id: 'test',
    capabilities: async () => ['devtools'],
    ...overrides,
  };
}

function ctx() {
  const said: string[] = [];
  return { say: (t: string) => said.push(t), confirm: async () => true, said };
}

function skillsFrom(platform: Platform) {
  const skills = createDevToolsSkills(platform);
  return (id: string) => {
    const s = skills.find((sk) => sk.id === id);
    if (!s) throw new Error(`no such skill: ${id}`);
    return s;
  };
}

test('project.detect reports every system it finds', async () => {
  const find = skillsFrom(
    stubPlatform({
      detectProject: async () => ({
        root: 'C:\\proj',
        systems: ['cargo', 'npm'],
        npmScripts: ['build', 'test'],
        isGitRepo: true,
        cmakeConfigured: false,
      }),
    }),
  );

  const result = await find('project.detect').run({ path: 'C:\\proj' }, ctx());

  assert.isTrue(result.ok);
  assert.match(result.message!, /cargo, npm/);
  assert.match(result.message!, /build, test/);
  assert.match(result.message!, /git repository/);
});

test('project.detect says plainly when nothing was recognised', async () => {
  const find = skillsFrom(
    stubPlatform({
      detectProject: async () => ({
        root: 'C:\\empty',
        systems: [],
        npmScripts: [],
        isGitRepo: false,
        cmakeConfigured: false,
      }),
    }),
  );

  const result = await find('project.detect').run({ path: 'C:\\empty' }, ctx());

  assert.isTrue(result.ok);
  assert.match(result.message!, /couldn't recognise/i);
});

test('code.search reports no matches honestly rather than an empty list', async () => {
  const find = skillsFrom(stubPlatform({ codeSearch: async () => [] }));
  const result = await find('code.search').run({ path: 'C:\\proj', query: 'nope' }, ctx());
  assert.isTrue(result.ok);
  assert.match(result.message!, /no matches/i);
});

test('code.search lists matches as file:line: text', async () => {
  const find = skillsFrom(
    stubPlatform({
      codeSearch: async () => [{ path: 'src/a.ts', line: 12, text: 'const x = 1' }],
    }),
  );
  const result = await find('code.search').run({ path: 'C:\\proj', query: 'x' }, ctx());
  assert.match(result.message!, /src\/a\.ts:12: const x = 1/);
});

test('git.status distinguishes clean from dirty', async () => {
  const clean = skillsFrom(
    stubPlatform({
      gitStatus: async () => ({
        branch: 'main',
        staged: [],
        unstaged: [],
        untracked: [],
        clean: true,
      }),
    }),
  );
  const cleanResult = await clean('git.status').run({ path: 'C:\\proj' }, ctx());
  assert.match(cleanResult.message!, /clean/);

  const dirty = skillsFrom(
    stubPlatform({
      gitStatus: async () => ({
        branch: 'main',
        staged: ['a.ts'],
        unstaged: [],
        untracked: ['b.ts'],
        clean: false,
      }),
    }),
  );
  const dirtyResult = await dirty('git.status').run({ path: 'C:\\proj' }, ctx());
  assert.match(dirtyResult.message!, /1 staged/);
  assert.match(dirtyResult.message!, /1 untracked/);
});

test('git.commit surfaces the failure message when git rejects the commit', async () => {
  const find = skillsFrom(
    stubPlatform({
      gitCommit: async () => {
        throw new Error('nothing to commit');
      },
    }),
  );
  const result = await find('git.commit').run({ path: 'C:\\proj', message: 'x' }, ctx());
  assert.isFalse(result.ok);
  assert.equal(result.error, 'nothing to commit');
});

test('build.run maps a cmake target through to runDevTool unchanged', async () => {
  let captured: [string, DevTool, string | undefined] | null = null;
  const find = skillsFrom(
    stubPlatform({
      runDevTool: async (cwd, tool, arg) => {
        captured = [cwd, tool, arg];
        return { ok: true, stdout: 'Build finished', stderr: '', exitCode: 0, truncated: false };
      },
    }),
  );

  const result = await find('build.run').run(
    { path: 'C:\\proj', system: 'cmake', target: 'engine' },
    ctx(),
  );

  assert.isTrue(result.ok);
  assert.deepEqual(captured, ['C:\\proj', 'cmake-build', 'engine']);
});

test('build.run defaults an npm target to "build"', async () => {
  let captured: [string, DevTool, string | undefined] | null = null;
  const find = skillsFrom(
    stubPlatform({
      runDevTool: async (cwd, tool, arg) => {
        captured = [cwd, tool, arg];
        return { ok: true, stdout: '', stderr: '', exitCode: 0, truncated: false };
      },
    }),
  );

  await find('build.run').run({ path: 'C:\\proj', system: 'npm' }, ctx());

  assert.deepEqual(captured, ['C:\\proj', 'npm-run', 'build']);
});

test('build.run refuses a system it does not recognise, without calling the platform', async () => {
  let called = false;
  const find = skillsFrom(
    stubPlatform({
      runDevTool: async () => {
        called = true;
        return { ok: true, stdout: '', stderr: '', exitCode: 0, truncated: false };
      },
    }),
  );

  const result = await find('build.run').run({ path: 'C:\\proj', system: 'bazel' }, ctx());

  assert.isFalse(result.ok);
  assert.isFalse(called);
});

test('test.run maps cmake to ctest, not cmake-build', async () => {
  let captured: DevTool | null = null;
  const find = skillsFrom(
    stubPlatform({
      runDevTool: async (_cwd, tool) => {
        captured = tool;
        return { ok: true, stdout: '', stderr: '', exitCode: 0, truncated: false };
      },
    }),
  );

  await find('test.run').run({ path: 'C:\\proj', system: 'cmake' }, ctx());

  assert.equal(captured, 'ctest');
});

test('a failed tool run reports the exit code and the output together', async () => {
  const find = skillsFrom(
    stubPlatform({
      runDevTool: async () => ({
        ok: false,
        stdout: '',
        stderr: 'error C2065: undeclared identifier',
        exitCode: 1,
        truncated: false,
      }),
    }),
  );

  const result = await find('test.run').run({ path: 'C:\\proj', system: 'cargo' }, ctx());

  assert.isFalse(result.ok);
  assert.match(result.error!, /Exit code 1/);
  assert.match(result.error!, /undeclared identifier/);
});

test('code.edit surfaces an ambiguous-match refusal verbatim', async () => {
  const find = skillsFrom(
    stubPlatform({
      patchTextFile: async () => {
        throw new Error(
          'That text appears 3 times — pass more context to make it unique, or replaceAll.',
        );
      },
    }),
  );

  const result = await find('code.edit').run(
    { path: 'C:\\proj\\a.ts', find: 'x', replace: 'y' },
    ctx(),
  );

  assert.isFalse(result.ok);
  assert.match(result.error!, /appears 3 times/);
});

test('reads are safe and writes/executions are confirm', () => {
  const skills = createDevToolsSkills(stubPlatform());
  const riskOf = (id: string) => skills.find((s) => s.id === id)!.risk;

  for (const id of [
    'project.detect',
    'project.tree',
    'code.search',
    'git.status',
    'git.diff',
    'git.log',
  ]) {
    assert.equal(riskOf(id), 'safe', id);
  }
  for (const id of [
    'git.add',
    'git.commit',
    'build.configure',
    'build.run',
    'test.run',
    'code.write',
    'code.edit',
  ]) {
    assert.equal(riskOf(id), 'confirm', id);
  }
});

test('every devtools skill declares the devtools capability', () => {
  const skills = createDevToolsSkills(stubPlatform());
  for (const skill of skills) {
    assert.include(skill.needs ?? [], 'devtools', skill.id);
  }
});
