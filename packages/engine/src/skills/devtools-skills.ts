/**
 * Inspecting and driving a software project — the deterministic half of the
 * developer agent. Everything here is a narrow, single-purpose skill exactly
 * like the rest of the catalog; `devagent.run` (`../devagent/skill.ts`) is
 * what strings several of these together for one open-ended goal, using the
 * same executor and the same risk/confirm/guard machinery every other plan
 * goes through.
 *
 * ── Scaffolding a new project ────────────────────────────────────────────
 * `project.create`, `dependency.install` and `project.launch` complete the
 * "build me a thing" loop this file started with `project.detect` and
 * `build.run`/`test.run`. None of them are a new *kind* of capability:
 * `project.create` is `platform.createFolder` (the same call
 * `files.createFolder` in `core-skills.ts` makes) under a name and a domain
 * the developer-agent loop already allows; `dependency.install` is one more
 * closed dispatch shaped exactly like `build.run`/`test.run` — a fixed
 * package manager, one validated package-name slot, never a raw command line
 * (see `devtools.rs`'s `install_dependency` doc comment); `project.launch` is
 * `platform.openPath` — the same mechanism `files.open` already uses — given
 * a name that reads right at the end of a scaffold-build-test sequence.
 * Actually *writing* the generated code is not a new skill either: it is the
 * model's own text going into `files.create` (a new file) or `code.write` /
 * `code.edit` (an existing one) — both already in this catalog family, see
 * `core-skills.ts` for `files.create`/`files.delete`/`files.readText`.
 *
 * `project.create` and `project.launch` live in `project` and `dependency.
 * install` in `build` — not `apps` — specifically so the developer agent
 * (`../devagent/loop.ts`'s `DEV_AGENT_DOMAINS`) can reach them without
 * widening its domain allowlist to admit every `apps`-domain skill
 * (`app.open`, `app.list`) for the sake of one. `project.launch` is
 * mechanically identical to `app.open`'s "open the thing, don't ask" case —
 * see its own doc comment below for why it is `safe` on the same reasoning.
 *
 * ── Risk ──────────────────────────────────────────────────────────────────
 * Reads (`project.detect`, `project.tree`, `code.search`, `git.status`,
 * `git.diff`, `git.log`) are `safe`, matching every other read-only group in
 * this catalog (`net.rs`, the services list). `project.launch` is also
 * `safe` — see its own doc comment; opening what was just built is the same
 * non-question `app.open` already answered. Everything that changes the
 * repository, the disk, or runs a project's own build/test/install tooling —
 * `git.add`, `git.commit`, `build.configure`, `build.run`, `test.run`,
 * `code.write`, `code.edit`, `project.create`, `dependency.install` — is
 * `confirm`. A build, a test run or a dependency install is the closest thing
 * this catalog has ever executed to arbitrary developer-authored code (an npm
 * script, a CMake rule, a pytest conftest, an npm/pip/cargo post-install hook
 * can do anything), so it starts conservative rather than reasoning its way
 * to `safe` the way `app.open` eventually did — see the roadmap's own note
 * about auditing `confirm` skills by consequence rather than mechanism, which
 * this group is a candidate for revisiting once it has real use behind it.
 */

import type { DepManager, DevTool, Platform, Skill } from '@atlas/core';

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

/** Script names that mean "package this", most specific first. */
export const PACKAGE_SCRIPTS = [
  'package',
  'dist',
  'pack',
  'make',
  'tauri:build',
  'electron:build',
] as const;

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
    id: 'project.create',
    label: 'Start a new project',
    icon: '🆕',
    domain: 'project',
    description:
      'Create a new, empty project folder to build something in. Refuses if something is already there — this is for starting fresh, not reusing a folder.',
    needs: ['devtools'],
    risk: 'confirm',
    examples: ['start a new project at D:\\Dev\\ClickerGame'],
    params: {
      path: { type: 'string', required: true, description: 'full path for the new project folder' },
    },
    async run(args) {
      const path = String(args.path);
      try {
        const ok = await platform.createFolder!(path);
        return ok
          ? { ok: true, message: `Created a new project folder at ${path}.` }
          : { ok: false, error: `I couldn't create a project folder at ${path}.` };
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : `I couldn't create a project folder at ${path}.`,
        };
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

  /**
   * The system named, or — when the request didn't name one ("run the tests in
   * D:\Dev\App") — the first supported one `project.detect` finds there. A
   * project with both pnpm and npm markers prefers pnpm, which is what the
   * lockfile being there means.
   */
  async function detectSystem(
    path: string,
    supported: readonly string[],
    named: unknown,
  ): Promise<{ system: string } | { error: string }> {
    if (typeof named === 'string' && named) return { system: named };
    const info = await platform.detectProject?.(path).catch(() => null);
    const found = info?.systems ?? [];
    const preference = ['pnpm', 'npm', 'cargo', 'dotnet', 'cmake', 'make', 'pytest'];
    const system = preference.find((s) => supported.includes(s) && found.includes(s as never));
    return system
      ? { system }
      : {
          error: `I couldn’t find a project I know how to handle in ${path}${found.length ? ` (found ${found.join(', ')})` : ''}.`,
        };
  }

  /** The script "package it" means in this project, if it has one. */
  async function packageScript(
    path: string,
    system: string,
  ): Promise<{ script: string } | { error: string }> {
    if (system !== 'npm' && system !== 'pnpm') {
      return {
        error: `Packaging is something I can do for npm/pnpm projects with a "package" or "dist" script; this one builds with ${system}.`,
      };
    }
    const info = await platform.detectProject?.(path).catch(() => null);
    const scripts = info?.npmScripts ?? [];
    const script = PACKAGE_SCRIPTS.find((n) => scripts.includes(n));
    return script
      ? { script }
      : {
          error: `${path} has no packaging script I recognise${scripts.length ? ` (its scripts: ${scripts.slice(0, 8).join(', ')})` : ''}.`,
        };
  }
  const TEST_SYSTEMS = ['cmake', 'cargo', 'npm', 'pnpm', 'dotnet', 'pytest'] as const;
  const DEP_MANAGERS = ['npm', 'pnpm', 'cargo', 'pip'] as const;

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
        required: false,
        enum: BUILD_SYSTEMS,
        description: 'which build system to use; detected from the folder when left out',
      },
      target: {
        type: 'string',
        required: false,
        description: 'a build target or npm/pnpm script name',
      },
    },
    examples: ['build D:\\Dev\\MyApp', 'package the project in D:\\Dev\\MyApp'],
    async run(args) {
      const path = String(args.path);
      const detected = await detectSystem(path, BUILD_SYSTEMS, args.system);
      if ('error' in detected) return { ok: false, error: detected.error };
      const system = detected.system;
      let target = args.target !== undefined ? String(args.target) : undefined;
      // "package it": whichever packaging script this project actually has.
      if (target === 'package') {
        const script = await packageScript(path, system);
        if ('error' in script) return { ok: false, error: script.error };
        target = script.script;
      }

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
        required: false,
        enum: TEST_SYSTEMS,
        description: 'which test tool to use; detected from the folder when left out',
      },
      filter: { type: 'string', required: false, description: 'restrict to tests matching this' },
    },
    examples: ['run the tests in D:\\Dev\\MyApp'],
    async run(args) {
      const path = String(args.path);
      const detected = await detectSystem(path, TEST_SYSTEMS, args.system);
      if ('error' in detected) return { ok: false, error: detected.error };
      const system = detected.system;
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
    id: 'dependency.install',
    label: 'Install a dependency',
    icon: '📦',
    domain: 'build',
    description:
      'Add one dependency to a project using its own package manager. "manager" must be one already reported by project.detect (npm/pnpm/cargo) or "pip" for a Python project. "package" may include a version, e.g. "react@18". Never a raw command line — see devtools.rs\'s install_dependency.',
    needs: ['devtools'],
    risk: 'confirm',
    examples: ['add express to this project', 'install pytest as a dev dependency'],
    params: {
      path: { type: 'string', required: true, description: 'the project folder' },
      manager: {
        type: 'string',
        required: true,
        enum: DEP_MANAGERS,
        description: 'which package manager to use',
      },
      package: {
        type: 'string',
        required: true,
        description: 'the package name to install, optionally with a version',
      },
      dev: {
        type: 'boolean',
        required: false,
        description: 'install as a development-only dependency, where the manager supports it',
      },
    },
    async run(args) {
      const path = String(args.path);
      const manager = String(args.manager) as DepManager;
      const pkg = String(args.package);
      const dev = args.dev === true;

      try {
        const result = await platform.installDependency!(path, manager, pkg, dev);
        return toolResultToSkillResult(result, `Installed ${pkg} (${manager}).`);
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : `I couldn't install ${pkg}.`,
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

  skills.push({
    id: 'project.launch',
    label: 'Open the built project',
    icon: '🚀',
    domain: 'project',
    description:
      'Open a file, folder or program that was just built or generated — the last step of a scaffold-build-test sequence, so the person can see it running.',
    needs: ['devtools'],
    // Mirrors `app.open`: asking "are you sure you want to open the thing
    // you just asked me to build" is the same redundant question `app.open`'s
    // own doc comment already answers no to. It is `platform.openPath` under
    // the hood — the same call `files.open` (core-skills.ts) makes — kept as
    // its own skill so it reads right at the end of a devtools-domain plan
    // and stays inside the developer agent's domain allowlist. See this
    // file's own module doc for why it is `project`-domain rather than `apps`.
    risk: 'safe',
    examples: ['open the project I just built'],
    params: {
      path: { type: 'string', required: true, description: 'the file, folder or program to open' },
    },
    async run(args) {
      const path = String(args.path);
      const ok = await platform.openPath!(path);
      return ok
        ? { ok: true, message: `Opened ${basename(path)}.` }
        : { ok: false, error: `I couldn't open ${path}.` };
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
