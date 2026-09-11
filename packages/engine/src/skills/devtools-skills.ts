/**
 * Inspecting and driving a software project — the deterministic half of the
 * developer agent. Everything here is a narrow, single-purpose skill exactly
 * like the rest of the catalog; `devagent.run` (`../devagent/skill.ts`) is
 * what strings several of these together for one open-ended goal, using the
 * same executor and the same risk/confirm/guard machinery every other plan
 * goes through.
 *
 * ── Risk ──────────────────────────────────────────────────────────────────
 * Reads (`project.detect`, `project.tree`, `code.search`, `git.status`,
 * `git.diff`, `git.log`) are `safe`, matching every other read-only group in
 * this catalog (`net.rs`, the services list). Everything that changes the
 * repository or runs a project's own build/test tooling — `git.add`,
 * `git.commit`, `build.configure`, `build.run`, `test.run`, `code.write`,
 * `code.edit` — is `confirm`. A build or test run is the closest thing this
 * catalog has ever executed to arbitrary developer-authored code (an npm
 * script, a CMake rule, a pytest conftest can do anything), so it starts
 * conservative rather than reasoning its way to `safe` the way `app.open`
 * eventually did — see the roadmap's own note about auditing `confirm` skills
 * by consequence rather than mechanism, which this group is a candidate for
 * revisiting once it has real use behind it.
 */

import type { DevTool, Platform, Skill } from '@atlas/core';

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** A short preview of tool output — the full text still rides in `data`. */
function previewOutput(text: string, lines = 40): string {
  const all = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const shown = all.slice(0, lines);
  const rest = all.length - shown.length;
  return shown.join('\n') + (rest > 0 ? `\n… ${rest} more line${rest === 1 ? '' : 's'}` : '');
}

export function createDevToolsSkills(platform: Platform): Skill[] {
  const skills: Skill[] = [];

  skills.push({
    id: 'project.detect',
    label: 'Inspect a project',
    icon: '🔍',
    domain: 'project',
    description:
      'Detect what kind of software project a folder is: build systems present, npm scripts, whether it is a git repo, whether CMake is already configured.',
    needs: ['devtools'],
    risk: 'safe',
    examples: ['inspect the project at D:\\Dev\\NovaEngine'],
    params: { path: { type: 'string', required: true, description: 'the project folder' } },
    async run(args) {
      const path = String(args.path);
      try {
        const info = await platform.detectProject!(path);
        if (!info.systems.length) {
          return {
            ok: true,
            message: `I couldn't recognise a build system at ${basename(path)} — no CMakeLists.txt, package.json, Cargo.toml, .sln or Makefile there.`,
            data: info,
          };
        }
        const bits = [`Systems: ${info.systems.join(', ')}.`];
        if (info.npmScripts.length) bits.push(`npm scripts: ${info.npmScripts.join(', ')}.`);
        if (info.systems.includes('cmake')) {
          bits.push(
            info.cmakeConfigured
              ? 'CMake is already configured.'
              : 'CMake needs configuring first.',
          );
        }
        bits.push(info.isGitRepo ? 'It is a git repository.' : 'Not a git repository.');
        return { ok: true, message: `🔍 ${basename(path)} — ${bits.join(' ')}`, data: info };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : `I couldn't inspect ${path}.` };
      }
    },
  });

  skills.push({
    id: 'project.tree',
    label: 'Directory tree',
    icon: '🌳',
    domain: 'project',
    description:
      'A bounded recursive listing of a project folder, skipping dependency and build-output folders (node_modules, .git, target, build, dist, …).',
    needs: ['devtools'],
    risk: 'safe',
    params: {
      path: { type: 'string', required: true, description: 'the folder to list' },
      maxDepth: { type: 'number', required: false, description: 'how many levels deep, default 3' },
      maxEntries: {
        type: 'number',
        required: false,
        description: 'a cap on total entries, default 400',
      },
    },
    async run(args) {
      const path = String(args.path);
      try {
        const entries = await platform.dirTree!(
          path,
          args.maxDepth !== undefined ? Number(args.maxDepth) : undefined,
          args.maxEntries !== undefined ? Number(args.maxEntries) : undefined,
        );
        const lines = entries
          .slice(0, 200)
          .map((e) => `${'  '.repeat(e.depth)}${e.isDirectory ? '📁' : '📄'} ${e.name}`);
        const rest = entries.length - Math.min(entries.length, 200);
        const body = lines.join('\n') + (rest > 0 ? `\n… ${rest} more` : '');
        return { ok: true, message: `🌳 ${basename(path)}:\n\n${body}`, data: entries };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : `I couldn't list ${path}.` };
      }
    },
  });

  skills.push({
    id: 'code.search',
    label: 'Search code',
    icon: '🔎',
    domain: 'code',
    description:
      'Search file CONTENTS under a project folder for a piece of text — not just names. Optional glob narrows which files are searched (e.g. "*.rs").',
    needs: ['devtools'],
    risk: 'safe',
    examples: ['search the project for "TODO"'],
    params: {
      path: { type: 'string', required: true, description: 'the project folder to search under' },
      query: { type: 'string', required: true, description: 'text to search for' },
      glob: {
        type: 'string',
        required: false,
        description: 'restrict to files matching this glob',
      },
      limit: { type: 'number', required: false, description: 'max matches, default 50' },
    },
    async run(args) {
      const path = String(args.path);
      try {
        const matches = await platform.codeSearch!(
          path,
          String(args.query),
          args.glob !== undefined ? String(args.glob) : undefined,
          args.limit !== undefined ? Number(args.limit) : undefined,
        );
        if (!matches.length)
          return { ok: true, message: `No matches for “${String(args.query)}”.`, data: matches };
        const lines = matches.map((m) => `${m.path}:${m.line}: ${m.text}`);
        return {
          ok: true,
          message: `🔎 ${matches.length} match${matches.length === 1 ? '' : 'es'}:\n\n${lines.join('\n')}`,
          data: matches,
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'That search failed.' };
      }
    },
  });

  skills.push({
    id: 'git.status',
    label: 'Git status',
    icon: '📋',
    domain: 'git',
    description: 'The current branch, and which files are staged, unstaged or untracked.',
    needs: ['devtools'],
    risk: 'safe',
    params: { path: { type: 'string', required: true, description: 'the repository folder' } },
    async run(args) {
      const path = String(args.path);
      try {
        const status = await platform.gitStatus!(path);
        if (status.clean)
          return {
            ok: true,
            message: `📋 ${status.branch} — clean, nothing to commit.`,
            data: status,
          };
        const parts = [];
        if (status.staged.length) parts.push(`${status.staged.length} staged`);
        if (status.unstaged.length) parts.push(`${status.unstaged.length} unstaged`);
        if (status.untracked.length) parts.push(`${status.untracked.length} untracked`);
        return { ok: true, message: `📋 ${status.branch} — ${parts.join(', ')}.`, data: status };
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : `I couldn't read git status for ${path}.`,
        };
      }
    },
  });

  skills.push({
    id: 'git.diff',
    label: 'Git diff',
    icon: '➕',
    domain: 'git',
    description: 'Unstaged changes as a unified diff — optionally for one file only.',
    needs: ['devtools'],
    risk: 'safe',
    params: {
      path: { type: 'string', required: true, description: 'the repository folder' },
      file: { type: 'string', required: false, description: 'restrict to this one file' },
    },
    async run(args) {
      const path = String(args.path);
      try {
        const diff = await platform.gitDiff!(
          path,
          args.file !== undefined ? String(args.file) : undefined,
        );
        if (!diff.trim()) return { ok: true, message: 'No unstaged changes.', data: diff };
        return { ok: true, message: `➕ Diff:\n\n${previewOutput(diff, 60)}`, data: diff };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'git diff failed.' };
      }
    },
  });

  skills.push({
    id: 'git.log',
    label: 'Git log',
    icon: '🕘',
    domain: 'git',
    description: 'Recent commits — hash, author, date, message.',
    needs: ['devtools'],
    risk: 'safe',
    params: {
      path: { type: 'string', required: true, description: 'the repository folder' },
      limit: { type: 'number', required: false, description: 'how many commits, default 20' },
    },
    async run(args) {
      const path = String(args.path);
      try {
        const log = await platform.gitLog!(
          path,
          args.limit !== undefined ? Number(args.limit) : undefined,
        );
        const lines = log.map((e) => `${e.hash} ${e.date} ${e.author} — ${e.message}`);
        return { ok: true, message: `🕘 ${lines.join('\n')}`, data: log };
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : `I couldn't read the git log for ${path}.`,
        };
      }
    },
  });

  skills.push({
    id: 'git.add',
    label: 'Git add',
    icon: '➕',
    domain: 'git',
    description: 'Stage a file for the next commit.',
    needs: ['devtools'],
    risk: 'confirm',
    params: {
      path: { type: 'string', required: true, description: 'the repository folder' },
      file: {
        type: 'string',
        required: true,
        description: 'the file to stage, relative to the repo',
      },
    },
    async run(args) {
      const path = String(args.path);
      const file = String(args.file);
      try {
        await platform.gitAdd!(path, file);
        return { ok: true, message: `Staged ${file}.` };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : `I couldn't stage ${file}.` };
      }
    },
  });

  skills.push({
    id: 'git.commit',
    label: 'Git commit',
    icon: '✅',
    domain: 'git',
    description: 'Commit whatever is currently staged.',
    needs: ['devtools'],
    risk: 'confirm',
    params: {
      path: { type: 'string', required: true, description: 'the repository folder' },
      message: { type: 'string', required: true, description: 'the commit message' },
    },
    async run(args) {
      const path = String(args.path);
      try {
        const hash = await platform.gitCommit!(path, String(args.message));
        return { ok: true, message: `Committed as ${hash}.` };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'git commit failed.' };
      }
    },
  });

  const BUILD_SYSTEMS = ['cmake', 'cargo', 'npm', 'pnpm', 'dotnet', 'make'] as const;
  const TEST_SYSTEMS = ['cmake', 'cargo', 'npm', 'pnpm', 'dotnet', 'pytest'] as const;

  skills.push({
    id: 'build.configure',
    label: 'Configure a CMake build',
    icon: '⚙️',
    domain: 'build',
    description:
      'Run "cmake -S . -B build" for a CMake project — needed once before build.run can target it.',
    needs: ['devtools'],
    risk: 'confirm',
    params: {
      path: { type: 'string', required: true, description: 'the project folder' },
      buildType: {
        type: 'string',
        required: false,
        enum: ['Debug', 'Release', 'RelWithDebInfo', 'MinSizeRel'],
        description: 'defaults to Debug',
      },
    },
    async run(args) {
      const path = String(args.path);
      try {
        const result = await platform.runDevTool!(
          path,
          'cmake-configure',
          args.buildType !== undefined ? String(args.buildType) : undefined,
        );
        return toolResultToSkillResult(result, 'Configured.');
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'Configuring failed.' };
      }
    },
  });

  skills.push({
    id: 'build.run',
    label: 'Build a project',
    icon: '🔨',
    domain: 'build',
    description:
      'Run the given project\'s own build tool. "system" must be one already reported by project.detect. "target" means a CMake target, a make target, or an npm/pnpm script name (defaults to "build"); ignored for cargo and dotnet.',
    needs: ['devtools'],
    risk: 'confirm',
    params: {
      path: { type: 'string', required: true, description: 'the project folder' },
      system: {
        type: 'string',
        required: true,
        enum: BUILD_SYSTEMS,
        description: 'which build system to use',
      },
      target: {
        type: 'string',
        required: false,
        description: 'a build target or npm/pnpm script name',
      },
    },
    async run(args) {
      const path = String(args.path);
      const system = String(args.system);
      const target = args.target !== undefined ? String(args.target) : undefined;

      const tool = buildTool(system, target);
      if (!tool) return { ok: false, error: `I don't know how to build with "${system}".` };

      try {
        const result = await platform.runDevTool!(path, tool.name, tool.arg);
        return toolResultToSkillResult(result, `Build finished (${system}).`);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'The build failed to start.' };
      }
    },
  });

  skills.push({
    id: 'test.run',
    label: 'Run tests',
    icon: '🧪',
    domain: 'test',
    description:
      'Run the given project\'s own test tool. "system" must be one already reported by project.detect (cmake uses ctest). "filter" narrows to matching tests, when the tool supports it.',
    needs: ['devtools'],
    risk: 'confirm',
    params: {
      path: { type: 'string', required: true, description: 'the project folder' },
      system: {
        type: 'string',
        required: true,
        enum: TEST_SYSTEMS,
        description: 'which test tool to use',
      },
      filter: { type: 'string', required: false, description: 'restrict to tests matching this' },
    },
    async run(args) {
      const path = String(args.path);
      const system = String(args.system);
      const filter = args.filter !== undefined ? String(args.filter) : undefined;

      const tool = testTool(system, filter);
      if (!tool) return { ok: false, error: `I don't know how to test with "${system}".` };

      try {
        const result = await platform.runDevTool!(path, tool.name, tool.arg);
        return toolResultToSkillResult(result, `Tests finished (${system}).`);
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : 'The test run failed to start.',
        };
      }
    },
  });

  skills.push({
    id: 'code.write',
    label: 'Overwrite a file',
    icon: '💾',
    domain: 'code',
    description:
      'Replace the entire contents of an existing file. Use code.edit instead when only part of a file needs to change.',
    needs: ['devtools'],
    risk: 'confirm',
    params: {
      path: { type: 'string', required: true, description: 'full path of the file' },
      content: { type: 'string', required: true, description: 'the new, complete file contents' },
    },
    async run(args) {
      const path = String(args.path);
      try {
        await platform.writeTextFile!(path, String(args.content));
        return { ok: true, message: `Wrote ${basename(path)}.` };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : `I couldn't write ${path}.` };
      }
    },
  });

  skills.push({
    id: 'code.edit',
    label: 'Edit a file',
    icon: '✏️',
    domain: 'code',
    description:
      "Replace one exact piece of text in a file with another. Refuses if the text isn't found, and refuses if it appears more than once unless replaceAll is set — give enough surrounding context to make it unique.",
    needs: ['devtools'],
    risk: 'confirm',
    params: {
      path: { type: 'string', required: true, description: 'full path of the file' },
      find: { type: 'string', required: true, description: 'the exact text to find' },
      replace: { type: 'string', required: true, description: 'what to replace it with' },
      replaceAll: {
        type: 'boolean',
        required: false,
        description: 'replace every occurrence, not just the unique one',
      },
    },
    async run(args) {
      const path = String(args.path);
      try {
        const message = await platform.patchTextFile!(
          path,
          String(args.find),
          String(args.replace),
          args.replaceAll === true,
        );
        return { ok: true, message: `${message} (${basename(path)})` };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : `I couldn't edit ${path}.` };
      }
    },
  });

  return skills;
}

function toolResultToSkillResult(
  result: {
    ok: boolean;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    truncated: boolean;
  },
  doneMessage: string,
) {
  const output = [result.stdout, result.stderr].filter((s) => s.trim()).join('\n');
  const body = output ? previewOutput(output) : '(no output)';
  if (result.ok) {
    return { ok: true, message: `${doneMessage}\n\n${body}`, data: result };
  }
  return {
    ok: false,
    error: `Exit code ${result.exitCode ?? 'unknown'}.\n\n${body}`,
  };
}

function buildTool(system: string, target?: string): { name: DevTool; arg?: string } | null {
  switch (system) {
    case 'cmake':
      return { name: 'cmake-build', arg: target };
    case 'cargo':
      return { name: 'cargo-build' };
    case 'npm':
      return { name: 'npm-run', arg: target ?? 'build' };
    case 'pnpm':
      return { name: 'pnpm-run', arg: target ?? 'build' };
    case 'dotnet':
      return { name: 'dotnet-build' };
    case 'make':
      return { name: 'make-build', arg: target };
    default:
      return null;
  }
}

function testTool(system: string, filter?: string): { name: DevTool; arg?: string } | null {
  switch (system) {
    case 'cmake':
      return { name: 'ctest', arg: filter };
    case 'cargo':
      return { name: 'cargo-test', arg: filter };
    case 'npm':
      return { name: 'npm-test' };
    case 'pnpm':
      return { name: 'pnpm-test' };
    case 'dotnet':
      return { name: 'dotnet-test' };
    case 'pytest':
      return { name: 'pytest', arg: filter };
    default:
      return null;
  }
}
