#!/usr/bin/env node
/**
 * One command from "the code is pushed" to "installed copies of Atlas can update".
 *
 *   pnpm release --note "What changed" [--note "..."] [--dry-run] [--skip-checks] [--mandatory]
 *
 * What it does, in order, and stops at the first thing that is wrong:
 *   1. Reads the version from `apps/desktop/src-tauri/tauri.conf.json` (the one place
 *      the version is set; Cargo.toml and package.json must agree with it).
 *   2. Refuses to publish from a dirty tree, from a branch other than main, with
 *      commits that are not pushed, or when `v<version>` already exists on GitHub.
 *   3. Runs typecheck, lint and tests (skip with --skip-checks).
 *   4. Builds the installer (`pnpm bundle`).
 *   5. Writes `latest.json` next to it in `.release/`, measured from the built file.
 *   6. Creates the GitHub release `v<version>` with the installer and `latest.json`
 *      attached, through the `gh` CLI you are already signed in to.
 *
 * `--dry-run` does 1-5 and prints what step 6 would do, so nothing is published.
 *
 * Atlas reads `releases/latest/download/latest.json`, so once step 6 finishes every
 * installed Atlas finds the update on its next check (20 seconds after launch, then
 * every 6 hours).
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const skipChecks = args.includes('--skip-checks');
const notes = args.flatMap((a, i) => (a === '--note' && args[i + 1] ? [args[i + 1]] : []));
const REPO = '17sh8dy/Atlas';

function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

function step(title) {
  console.log(`\n▶ ${title}`);
}

/** Runs a command, streaming its output. Returns nothing; exits the script on failure. */
function run(command, commandArgs, cwd = root) {
  const result = spawnSync(command, commandArgs, { cwd, stdio: 'inherit', shell: true });
  if (result.status !== 0) fail(`"${command} ${commandArgs.join(' ')}" failed.`);
}

/** Runs a command and returns its trimmed output, or null if it failed. */
function capture(command, commandArgs, cwd = root) {
  const result = spawnSync(command, commandArgs, { cwd, encoding: 'utf8', shell: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

// 1. The version, and that every file that carries it agrees.
step('Reading the version');
const conf = JSON.parse(
  readFileSync(join(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
);
const version = conf.version;
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) fail(`tauri.conf.json has no usable version ("${version}").`);
const pkg = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8')).version;
const cargo = /^version\s*=\s*"([^"]+)"/m.exec(
  readFileSync(join(root, 'apps/desktop/src-tauri/Cargo.toml'), 'utf8'),
)?.[1];
if (pkg !== version || cargo !== version) {
  fail(`Versions disagree: tauri.conf.json ${version}, package.json ${pkg}, Cargo.toml ${cargo}. Make them match.`);
}
const tag = `v${version}`;
console.log(`  Atlas ${version}  (tag ${tag})`);

// 2. Refuse to publish something that is not exactly what is on GitHub.
step('Checking the repository');
if (capture('gh', ['auth', 'status']) === null) fail('The GitHub CLI is not signed in. Run: gh auth login');
const dirty = capture('git', ['status', '--porcelain']);
if (dirty) fail(`There are uncommitted changes. Commit or stash them first:\n${dirty}`);
const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== 'main') fail(`You are on "${branch}". Releases are made from main.`);
run('git', ['fetch', 'origin', 'main', '--quiet']);
const unpushed = capture('git', ['rev-list', '--count', 'origin/main..HEAD']);
const behind = capture('git', ['rev-list', '--count', 'HEAD..origin/main']);
if (unpushed !== '0') fail(`${unpushed} commit(s) are not pushed yet. Run: git push`);
if (behind !== '0') fail(`main is ${behind} commit(s) behind GitHub. Run: git pull`);
if (capture('gh', ['release', 'view', tag, '--repo', REPO]) !== null) {
  fail(`Release ${tag} already exists. Bump the version in tauri.conf.json, package.json and Cargo.toml first.`);
}
console.log('  clean, on main, pushed, and the tag is free');

// 3. Checks.
if (skipChecks) {
  console.log('\n(skipping typecheck, lint and tests)');
} else {
  step('Typecheck');
  run('pnpm', ['typecheck']);
  step('Lint');
  run('pnpm', ['lint']);
  step('Tests');
  run('pnpm', ['test']);
}

// 4. Build.
step('Building the installer (a few minutes)');
run('pnpm', ['bundle'], join(root, 'apps/desktop'));
const built = join(
  root,
  `apps/desktop/src-tauri/target/release/bundle/nsis/Atlas_${version}_x64-setup.exe`,
);
if (!existsSync(built)) fail(`The build finished but ${built} is not there.`);

// 5. Manifest, measured from the built file.
step('Writing the update manifest');
const outDir = join(root, '.release');
mkdirSync(outDir, { recursive: true });
const installer = join(outDir, `Atlas_${version}_x64-setup.exe`);
copyFileSync(built, installer);
const manifest = join(outDir, 'latest.json');
run('node', [
  'scripts/make-update-manifest.mjs',
  `"${installer}"`,
  ...notes.flatMap((n) => ['--note', JSON.stringify(n)]),
  ...(args.includes('--mandatory') ? ['--mandatory'] : []),
  '--out',
  `"${manifest}"`,
]);

// 6. Publish.
const releaseNotes = notes.length ? notes.map((n) => `- ${n}`).join('\n') : `Atlas ${version}`;
if (dryRun) {
  console.log(`\n✔ Dry run finished. Nothing was published.`);
  console.log(`  Would create release ${tag} on ${REPO} with:`);
  console.log(`    ${installer}\n    ${manifest}`);
  process.exit(0);
}
step(`Publishing ${tag} to GitHub`);
run('gh', [
  'release',
  'create',
  tag,
  `"${installer}"`,
  `"${manifest}"`,
  '--repo',
  REPO,
  '--title',
  JSON.stringify(`Atlas ${version}`),
  '--notes',
  JSON.stringify(releaseNotes),
  '--latest',
]);
console.log(`\n✔ Published: https://github.com/${REPO}/releases/tag/${tag}`);
console.log('  Installed copies of Atlas will find it on their next update check.');
