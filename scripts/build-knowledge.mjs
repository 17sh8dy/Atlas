#!/usr/bin/env node
/**
 * Builds and signs the Atlas/Nova knowledge pack (docs/PLAN-2.0.3.md §B1, §N).
 *
 *   node scripts/build-knowledge.mjs [--dev] [--publish]
 *
 * Reads knowledge/sources.json (an explicit allowlist, nothing is crawled), reads the approved
 * pages of the Nova-Knowledge repo and the listed docs of the public product repos, runs the
 * safety gates, chunks everything, and writes into knowledge/dist/:
 *
 *   knowledge-pack.json   the chunks
 *   knowledge-pack.sig    an Ed25519 signature over the pack file's own hash (key atlas-knowledge-1)
 *   report.md             what was packed, what was skipped, and what to review
 *
 * The gates FAIL the build (they are not warnings): a secret or personal path in any chunk; a page
 * with bad front matter; a source repo that is not a clean PUBLIC GitHub repo; a pack over the size
 * cap. Instruction-like text is reported for review but does not fail, because at runtime every
 * chunk is treated as data.
 *
 * The signing key is NEVER in this repo: set ATLAS_KNOWLEDGE_SIGNING_KEY to the private key file
 * (made by `node scripts/knowledge-signing.mjs keygen --out <path outside the repo>`). Without it
 * the build still runs but writes NO signature, so Atlas will refuse the pack.
 *
 *   --dev      include `review: draft` pages and allow dirty working trees. Dev packs are never signed
 *              and can never be published.
 *   --publish  attach the signed pack to the `knowledge` release of the Nova-Knowledge repo (needs `gh`).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LIMITS,
  SCHEMA,
  KEY_ID,
  chunkMarkdown,
  injectionFlags,
  parsePage,
  scanText,
  signPack,
  validatePage,
} from './knowledge-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dev = args.includes('--dev');
const publish = args.includes('--publish');

const failures = [];
const notes = [];
const fail = (msg) => failures.push(msg);

function git(dir, ...a) {
  return execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
}

/** A source repo must be a clean, public GitHub repo, or nothing from it is trusted. */
function checkRepo(dir, repo, label) {
  if (!existsSync(dir)) return fail(`${label}: ${dir} does not exist`);
  let remote = '';
  try {
    remote = git(dir, 'remote', 'get-url', 'origin');
  } catch {
    return fail(`${label}: no git remote`);
  }
  const m = /github\.com[:/]17sh8dy\/(.+)$/.exec(remote.replace(/\.git$/, ''));
  if (!m || `17sh8dy/${m[1]}` !== repo) return fail(`${label}: remote is ${remote}, expected github.com/${repo}`);
  try {
    const vis = JSON.parse(execFileSync('gh', ['repo', 'view', repo, '--json', 'visibility'], { encoding: 'utf8' })).visibility;
    if (vis !== 'PUBLIC') fail(`${label}: ${repo} is ${vis}, not PUBLIC`);
  } catch (e) {
    fail(`${label}: could not confirm ${repo} is public (${String(e.message).split('\n')[0]})`);
  }
  // Content is read from the committed HEAD (see `show`), so uncommitted edits can never leak into a
  // signed pack. A HEAD that is not on the remote yet would give readers links that do not resolve.
  if (!dev) {
    try {
      git(dir, 'merge-base', '--is-ancestor', 'HEAD', 'origin/main');
    } catch {
      notes.push(`${label}: HEAD is not on origin/main yet, so some source links will not resolve until it is pushed`);
    }
  }
}

/** The committed text of a file at HEAD (a dev build reads the working tree instead). */
function show(dir, rel) {
  if (dev) return readFileSync(join(dir, rel), 'utf8');
  return execFileSync('git', ['-C', dir, 'show', `HEAD:${rel}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function existsAtHead(dir, rel) {
  if (dev) return existsSync(join(dir, rel));
  try {
    git(dir, 'cat-file', '-e', `HEAD:${rel}`);
    return true;
  } catch {
    return false;
  }
}

function listAtHead(dir, rel) {
  if (dev) return existsSync(join(dir, rel)) ? readdirSync(join(dir, rel)) : [];
  try {
    return git(dir, 'ls-tree', '--name-only', 'HEAD', `${rel}/`)
      .split(/\r?\n/)
      .filter(Boolean)
      .map((f) => f.slice(rel.length + 1));
  } catch {
    return [];
  }
}

const cfg = JSON.parse(readFileSync(join(root, 'knowledge', 'sources.json'), 'utf8'));
const chunks = [];
const report = { packed: [], skipped: [], flagged: [] };

function addChunks({ idBase, product, title, body, origin, sourceUrl, sourcePath, updated, status, availableIn, review }) {
  for (const c of chunkMarkdown(body, title)) {
    const bad = scanText(c.text, { allowEmail: cfg.allowEmail ?? [] });
    if (bad.length) fail(`${sourcePath} (${c.headingPath.join(' > ')}): contains ${bad.join(', ')}`);
    if (/Brandon/.test(c.text)) report.flagged.push(`${sourcePath} (${c.headingPath.join(' > ')}): names a person (Brandon), review`);
    const flags = injectionFlags(c.text);
    if (flags.length) report.flagged.push(`${sourcePath} (${c.headingPath.join(' > ')}): instruction-like text`);
    chunks.push({
      id: `${idBase}#${c.n}`,
      product,
      title,
      headingPath: c.headingPath,
      text: c.text,
      sourceUrl: `${sourceUrl}`,
      sourcePath,
      updated,
      status,
      ...(availableIn ? { availableIn } : {}),
      origin,
      anchor: c.anchor,
      review,
    });
  }
}

// ---- the Nova-Knowledge pages ------------------------------------------------------------

{
  const k = cfg.knowledgeRepo;
  checkRepo(k.path, k.repo, 'Nova-Knowledge');
  const files = listAtHead(k.path, k.pages).filter((f) => f.endsWith('.md')).sort();
  if (files.length === 0) fail('Nova-Knowledge has no pages');
  const ids = new Set();
  for (const f of files) {
    const rel = `${k.pages}/${f}`;
    const parsed = parsePage(show(k.path, rel));
    if (parsed.error) {
      fail(`${rel}: ${parsed.error}`);
      continue;
    }
    const roadmapAllowed = Boolean(cfg.publicRoadmap && cfg.publicRoadmap === rel);
    const problems = validatePage(parsed.meta, parsed.body, { roadmapAllowed });
    if (problems.length) {
      fail(`${rel}: ${problems.join('; ')}`);
      continue;
    }
    if (ids.has(parsed.meta.id)) fail(`${rel}: duplicate id ${parsed.meta.id}`);
    ids.add(parsed.meta.id);
    if (parsed.meta.review !== 'approved' && !dev) {
      report.skipped.push(`${rel}: review is "${parsed.meta.review}", not packed`);
      continue;
    }
    addChunks({
      idBase: parsed.meta.id,
      product: parsed.meta.product,
      title: parsed.meta.title,
      body: parsed.body,
      origin: 'nova-knowledge',
      sourceUrl: `${k.publicBase}${rel}`,
      sourcePath: rel,
      updated: String(parsed.meta.updated),
      status: parsed.meta.status,
      availableIn: parsed.meta.availableIn,
      review: parsed.meta.review,
    });
    report.packed.push(`${rel} (${parsed.meta.review})`);
  }
}

// ---- product docs --------------------------------------------------------------------------

const lastDate = (dir, rel) => {
  try {
    return git(dir, 'log', '-1', '--format=%cs', '--', rel) || new Date().toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
};

for (const d of cfg.docs) {
  checkRepo(d.path, d.repo, d.product);
  for (const rel of d.files) {
    if (!existsAtHead(d.path, rel)) {
      fail(`${d.product}: ${rel} is listed but does not exist`);
      continue;
    }
    const text = show(d.path, rel);
    if (text.length > LIMITS.pageChars * 4) {
      fail(`${d.product}: ${rel} is very large (${text.length} characters)`);
      continue;
    }
    const title = (/^#\s+(.+)$/m.exec(text)?.[1] ?? rel).trim();
    addChunks({
      idBase: `${d.product}/${rel}`,
      product: d.product,
      title,
      body: text,
      origin: 'repo-docs',
      sourceUrl: `https://github.com/${d.repo}/blob/main/${rel}`,
      sourcePath: `${d.repo}:${rel}`,
      updated: lastDate(d.path, rel),
      status: 'Released',
      review: 'approved',
    });
    report.packed.push(`${d.repo}:${rel}`);
  }
}

// ---- the pack ----------------------------------------------------------------------------

const out = join(root, 'knowledge', 'dist');
mkdirSync(out, { recursive: true });
const builtAt = new Date().toISOString();
const seq = Math.floor(Date.now() / 1000);
const pack = { schema: SCHEMA, seq, builtAt, keyId: KEY_ID, dev, chunks };
const bytes = Buffer.from(JSON.stringify(pack), 'utf8');
if (bytes.length > LIMITS.packBytes) fail(`the pack is ${bytes.length} bytes, over the ${LIMITS.packBytes} cap`);

const lines = [
  '# Knowledge pack report',
  '',
  `Built ${builtAt}, seq ${seq}, ${chunks.length} chunks, ${bytes.length} bytes${dev ? ', DEV BUILD (never signed, never published)' : ''}.`,
  '',
  `## Packed (${report.packed.length})`,
  ...report.packed.map((x) => `- ${x}`),
  '',
  `## Skipped (${report.skipped.length})`,
  ...(report.skipped.length ? report.skipped.map((x) => `- ${x}`) : ['- none']),
  '',
  `## Instruction-like text to review (${report.flagged.length})`,
  'Not a failure: at runtime every chunk is data, never instructions. Look at these anyway.',
  ...(report.flagged.length ? report.flagged.map((x) => `- ${x}`) : ['- none']),
  '',
  `## Failures (${failures.length})`,
  ...(failures.length ? failures.map((x) => `- ${x}`) : ['- none']),
  '',
];
writeFileSync(join(out, 'report.md'), lines.join('\n'), 'utf8');

if (failures.length) {
  console.error(`\n✖ ${failures.length} problem(s), nothing signed:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
  console.error(`Details: ${relative(process.cwd(), join(out, 'report.md'))}`);
  process.exit(1);
}

writeFileSync(join(out, 'knowledge-pack.json'), bytes);
const keyFile = process.env.ATLAS_KNOWLEDGE_SIGNING_KEY;
if (dev) {
  console.log('Dev build: not signed.');
} else if (!keyFile || !existsSync(keyFile)) {
  notes.push('ATLAS_KNOWLEDGE_SIGNING_KEY is not set, so NO signature was written. Atlas will refuse this pack.');
} else {
  const sig = signPack(bytes, { seq, builtAt }, readFileSync(keyFile, 'utf8'));
  writeFileSync(join(out, 'knowledge-pack.sig'), JSON.stringify(sig, null, 2) + '\n', 'utf8');
  // The same signed pair is bundled into the installer as the offline pack.
  const bundle = join(root, 'apps', 'desktop', 'src-tauri', 'resources', 'knowledge');
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(bundle, 'knowledge-pack.json'), bytes);
  writeFileSync(join(bundle, 'knowledge-pack.sig'), JSON.stringify(sig, null, 2) + '\n', 'utf8');
  console.log(`Signed with ${KEY_ID}.`);
}
console.log(`✔ ${chunks.length} chunks, ${bytes.length} bytes → ${relative(process.cwd(), out)}`);
for (const n of notes) console.log(`! ${n}`);
if (report.skipped.length) console.log(`! ${report.skipped.length} page(s) skipped (not approved): see report.md`);
if (report.flagged.length) console.log(`! ${report.flagged.length} chunk(s) flagged for review: see report.md`);

if (publish) {
  if (dev || !existsSync(join(out, 'knowledge-pack.sig'))) {
    console.error('✖ --publish needs a signed, non-dev build.');
    process.exit(1);
  }
  const repo = cfg.knowledgeRepo.repo;
  const files = [join(out, 'knowledge-pack.json'), join(out, 'knowledge-pack.sig')];
  try {
    execFileSync('gh', ['release', 'view', 'knowledge', '--repo', repo], { stdio: 'ignore' });
  } catch {
    execFileSync('gh', ['release', 'create', 'knowledge', '--repo', repo, '--title', 'Knowledge pack', '--notes', 'Signed knowledge pack for Atlas. Rolling release: the assets are replaced when the pack is rebuilt.'], { stdio: 'inherit' });
  }
  execFileSync('gh', ['release', 'upload', 'knowledge', ...files, '--repo', repo, '--clobber'], { stdio: 'inherit' });
  console.log(`✔ published to github.com/${repo} (release "knowledge")`);
}
