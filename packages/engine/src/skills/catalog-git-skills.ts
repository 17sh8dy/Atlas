/**
 * The rest of everyday git (tool-catalog pass): merge a branch, tag, list tags,
 * take a file out of the next commit, throw a file's changes away, start a repository.
 *
 * Same shape as the git skills beside them in devtools-skills.ts — one closed
 * native operation each (`git_more`), the repository folder filled in from the
 * current project when the sentence names none. Never a general `git <anything>`.
 */

import type { Platform, Skill } from '@atlas/core';
import { buildReleaseNotes, formatReleaseNotes, parseCommitLines } from './release-notes';

const fail = (e: unknown, fallback: string) => ({
  ok: false as const,
  error: e instanceof Error ? e.message : typeof e === 'string' ? e : fallback,
});

const PATH = { type: 'string', required: true, description: 'the repository folder' } as const;

export function createCatalogGitSkills(platform: Platform): Skill[] {
  const skills: Skill[] = [];
  const more = (path: unknown, action: string, arg?: string) => platform.gitMore!(String(path), action, arg);

  skills.push({
    id: 'git.merge',
    label: 'Git merge',
    icon: '🔀',
    domain: 'git',
    description: 'Merge another branch into the one you are on. If it would conflict, it stops and puts everything back as it was.',
    needs: ['devtools'],
    risk: 'confirm',
    confirmAs: (a) => `merge branch ${String(a.branch)} into the current branch`,
    examples: ['merge branch dev'],
    params: { path: PATH, branch: { type: 'string', required: true, description: 'the branch to bring in' } },
    async run(args) {
      const branch = String(args.branch);
      try {
        const out = await more(args.path, 'merge', branch);
        return { ok: true, message: `🔀 Merged ${branch}.${out ? `\n${out}` : ''}`, data: out };
      } catch (e) {
        return fail(e, `I couldn't merge ${branch}.`);
      }
    },
  });

  skills.push({
    id: 'git.tag',
    label: 'Git tag',
    icon: '🏷️',
    domain: 'git',
    description: 'Tag the current commit, for example a release number. Local only; nothing is pushed.',
    needs: ['devtools'],
    risk: 'confirm',
    confirmAs: (a) => `tag the current commit ${String(a.name)}`,
    examples: ['tag this commit v1.0.6'],
    params: { path: PATH, name: { type: 'string', required: true, description: 'the tag, like v1.0.6' } },
    async run(args) {
      try {
        const out = await more(args.path, 'tag', String(args.name));
        return { ok: true, message: `🏷️ ${out}` };
      } catch (e) {
        return fail(e, `I couldn't tag that.`);
      }
    },
  });

  skills.push({
    id: 'git.tags',
    label: 'Git tags',
    icon: '🏷️',
    domain: 'git',
    description: 'List the tags in a repository, newest first.',
    needs: ['devtools'],
    risk: 'safe',
    examples: ['list git tags'],
    params: { path: PATH },
    async run(args) {
      try {
        const out = await more(args.path, 'tags');
        const tags = out.split(/\r?\n/).filter(Boolean);
        return { ok: true, message: tags.length ? `🏷️ ${tags.slice(0, 15).join(', ')}${tags.length > 15 ? ` …and ${tags.length - 15} more` : ''}` : '🏷️ No tags yet.', data: tags };
      } catch (e) {
        return fail(e, "I couldn't list the tags.");
      }
    },
  });

  skills.push({
    id: 'git.unstage',
    label: 'Git unstage',
    icon: '➖',
    domain: 'git',
    description: 'Take a file out of the next commit. The file itself is not changed.',
    needs: ['devtools'],
    risk: 'safe',
    examples: ['unstage src/main.rs'],
    params: { path: PATH, file: { type: 'string', required: true, description: 'the file, relative to the repo (or . for everything)' } },
    async run(args) {
      const file = String(args.file);
      try {
        await more(args.path, 'unstage', file);
        return { ok: true, message: `➖ ${file === '.' ? 'Everything is' : `${file} is`} out of the next commit.` };
      } catch (e) {
        return fail(e, `I couldn't unstage ${file}.`);
      }
    },
  });

  skills.push({
    id: 'git.discardChanges',
    label: 'Throw away a file’s changes',
    icon: '🗑️',
    domain: 'git',
    description: 'Put one file back to how it was at the last commit. The changes are gone for good — there is no undo for this.',
    needs: ['devtools'],
    risk: 'confirm',
    confirmAs: (a) => `throw away your uncommitted changes to ${String(a.file)} (this cannot be undone)`,
    examples: ['discard my changes to src/main.rs'],
    params: { path: PATH, file: { type: 'string', required: true, description: 'the one file, relative to the repo' } },
    async run(args) {
      const file = String(args.file);
      try {
        await more(args.path, 'discard', file);
        return { ok: true, message: `🗑️ ${file} is back to how it was at the last commit.` };
      } catch (e) {
        return fail(e, `I couldn't reset ${file}.`);
      }
    },
  });

  skills.push({
    id: 'git.init',
    label: 'Start a git repository',
    icon: '🌱',
    domain: 'git',
    description: 'Make a folder into a git repository. Refuses if it already is one.',
    needs: ['devtools'],
    risk: 'confirm',
    confirmAs: () => 'start a git repository here',
    examples: ['git init'],
    params: { path: PATH },
    async run(args) {
      try {
        const out = await more(args.path, 'init');
        return { ok: true, message: `🌱 ${out || 'Started a repository.'}` };
      } catch (e) {
        return fail(e, "I couldn't start a repository there.");
      }
    },
  });

  skills.push({
    id: 'git.releaseNotes',
    label: 'Release notes from git',
    icon: '📰',
    domain: 'git',
    description:
      'Write release notes from the commits since the last tag (or since a tag or branch you name), grouped into Added, Fixed, Improved, Changed and so on. It only reads the history; it changes nothing and writes no file.',
    needs: ['devtools'],
    risk: 'safe',
    examples: ['write release notes', 'release notes since v1.0.7', 'what changed since the last tag'],
    params: {
      path: PATH,
      since: { type: 'string', required: false, description: 'a tag or branch to start from; the latest tag when left out' },
      version: { type: 'string', required: false, description: 'a version number for the heading, like 1.0.8' },
    },
    async run(args) {
      try {
        let since = typeof args.since === 'string' ? args.since.trim() : '';
        let note = '';
        if (!since) {
          since = (await more(args.path, 'lasttag')).trim();
          if (!since) note = 'There are no tags in this repository yet, so these are the most recent commits.';
        }
        const raw = await more(args.path, 'rangelog', since || undefined);
        const commits = parseCommitLines(raw);
        if (!commits.length) return { ok: true, message: since ? `📰 No new commits since ${since}.` : '📰 This repository has no commits yet.', data: { commits: [] } };
        const notes = buildReleaseNotes(commits, { since: since || undefined, version: typeof args.version === 'string' && args.version.trim() ? args.version.trim() : undefined });
        return { ok: true, message: `📰 ${formatReleaseNotes(notes)}${note ? `\n\n${note}` : ''}`, aloud: false, data: { notes, commits } };
      } catch (e) {
        return fail(e, "I couldn't read the git history.");
      }
    },
  });

  return skills;
}
