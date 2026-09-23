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
import type { DepManager, DevTool, Platform } from '@atlas/core';
import { createDevToolsSkills } from '../src/skills/devtools-skills';
import { SkillRegistry } from '../src/skills/registry';

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
    'project.launch',
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
    'project.create',
    'dependency.install',
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

// ---- project.create ---------------------------------------------------------

test('project.create reports the new folder by its full path', async () => {
  let captured: string | null = null;
  const find = skillsFrom(
    stubPlatform({
      createFolder: async (path) => {
        captured = path;
        return true;
      },
    }),
  );

  const result = await find('project.create').run({ path: 'D:\\Dev\\Clicker' }, ctx());

  assert.isTrue(result.ok);
  assert.equal(captured, 'D:\\Dev\\Clicker');
  assert.match(result.message!, /D:\\Dev\\Clicker/);
});

test('project.create surfaces the platform\'s own refusal, e.g. outside the allowed folders', async () => {
  const find = skillsFrom(
    stubPlatform({
      createFolder: async () => {
        throw new Error('That path is outside the folders Atlas can touch.');
      },
    }),
  );

  const result = await find('project.create').run({ path: 'Z:\\elsewhere\\Clicker' }, ctx());

  assert.isFalse(result.ok);
  assert.equal(result.error, 'That path is outside the folders Atlas can touch.');
});

test('project.create reports a plain failure when the platform returns false rather than throwing', async () => {
  const find = skillsFrom(stubPlatform({ createFolder: async () => false }));
  const result = await find('project.create').run({ path: 'D:\\Dev\\Clicker' }, ctx());
  assert.isFalse(result.ok);
  assert.match(result.error!, /couldn't create/i);
});

// ---- dependency.install -------------------------------------------------------

test('dependency.install passes manager, package and dev straight through to the platform', async () => {
  let captured: [string, DepManager, string, boolean | undefined] | null = null;
  const find = skillsFrom(
    stubPlatform({
      installDependency: async (cwd, manager, pkg, dev) => {
        captured = [cwd, manager, pkg, dev];
        return { ok: true, stdout: 'added 1 package', stderr: '', exitCode: 0, truncated: false };
      },
    }),
  );

  const result = await find('dependency.install').run(
    { path: 'C:\\proj', manager: 'npm', package: 'express', dev: true },
    ctx(),
  );

  assert.isTrue(result.ok);
  assert.deepEqual(captured, ['C:\\proj', 'npm', 'express', true]);
});

test('dependency.install defaults "dev" to false when the caller leaves it out', async () => {
  let capturedDev: boolean | undefined = 'unset' as unknown as boolean;
  const find = skillsFrom(
    stubPlatform({
      installDependency: async (_cwd, _manager, _pkg, dev) => {
        capturedDev = dev;
        return { ok: true, stdout: '', stderr: '', exitCode: 0, truncated: false };
      },
    }),
  );

  await find('dependency.install').run({ path: 'C:\\proj', manager: 'cargo', package: 'serde' }, ctx());

  assert.equal(capturedDev, false);
});

test('dependency.install surfaces a failed install with its exit code and output, like build.run', async () => {
  const find = skillsFrom(
    stubPlatform({
      installDependency: async () => ({
        ok: false,
        stdout: '',
        stderr: 'npm ERR! 404 Not Found - GET https://registry.npmjs.org/not-a-real-package',
        exitCode: 1,
        truncated: false,
      }),
    }),
  );

  const result = await find('dependency.install').run(
    { path: 'C:\\proj', manager: 'npm', package: 'not-a-real-package' },
    ctx(),
  );

  assert.isFalse(result.ok);
  assert.match(result.error!, /Exit code 1/);
  assert.match(result.error!, /404 Not Found/);
});

test('dependency.install declares a closed set of managers — "yarn" is not one of them', () => {
  // The registry (registry.test.ts covers this mechanism generally) refuses
  // any value outside a declared `enum` before a skill's `run` is ever
  // reached — this pins the declaration itself: the one place that closed
  // set is written down.
  const skills = createDevToolsSkills(stubPlatform());
  const skill = skills.find((s) => s.id === 'dependency.install')!;
  assert.deepEqual(skill.params!.manager!.enum, ['npm', 'pnpm', 'cargo', 'pip']);
});

test('dependency.install: the registry itself refuses "yarn" before the platform is ever called', async () => {
  let called = false;
  const registry = new SkillRegistry({ capabilities: () => ['devtools'] });
  registry.registerMany(
    createDevToolsSkills(
      stubPlatform({
        installDependency: async () => {
          called = true;
          return { ok: true, stdout: '', stderr: '', exitCode: 0, truncated: false };
        },
      }),
    ),
  );

  const result = await registry.invoke(
    'dependency.install',
    { path: 'C:\\proj', manager: 'yarn', package: 'left-pad' },
    ctx(),
  );

  assert.isFalse(result.ok);
  assert.isFalse(called, 'an unvalidated manager must never reach the platform');
});

// ---- project.launch ---------------------------------------------------------

test('project.launch opens the given path and names it in the message', async () => {
  let captured: string | null = null;
  const find = skillsFrom(
    stubPlatform({
      openPath: async (path) => {
        captured = path;
        return true;
      },
    }),
  );

  const result = await find('project.launch').run({ path: 'D:\\Dev\\Clicker\\index.html' }, ctx());

  assert.isTrue(result.ok);
  assert.equal(captured, 'D:\\Dev\\Clicker\\index.html');
  assert.match(result.message!, /index\.html/);
});

test('project.launch reports failure plainly when the platform could not open the path', async () => {
  const find = skillsFrom(stubPlatform({ openPath: async () => false }));
  const result = await find('project.launch').run({ path: 'D:\\Dev\\Clicker\\index.html' }, ctx());
  assert.isFalse(result.ok);
  assert.match(result.error!, /couldn't open/i);
});
