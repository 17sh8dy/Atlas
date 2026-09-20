#!/usr/bin/env node
/**
 * Writes `latest.json` — the update manifest Atlas checks — for a built installer.
 *
 *   node scripts/make-update-manifest.mjs <installer.exe> [--note "Faster replies"]...
 *        [--repo 17sh8dy/Atlas] [--mandatory] [--min-version 0.80.0] [--out latest.json]
 *
 * The version comes from the installer's file name (`Atlas_0.86.0_x64-setup.exe`),
 * and the checksum and size are measured from the file itself, so the manifest
 * cannot disagree with what it describes.
 *
 * Publishing a release is then: create a GitHub release tagged `v<version>`,
 * attach the installer AND this `latest.json`. Atlas reads
 * `releases/latest/download/latest.json`, so nothing else has to change.
 */

import { createHash } from 'node:crypto';
import { createReadStream, statSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && a.toLowerCase().endsWith('.exe'));
if (!file) {
  console.error(
    'Usage: make-update-manifest.mjs <installer.exe> [--note "..."] [--repo owner/name]',
  );
  process.exit(1);
}

function flag(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const notes = args.flatMap((a, i) => (a === '--note' && args[i + 1] ? [args[i + 1]] : []));

const name = basename(file);
const version = /_(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)_/.exec(name)?.[1];
if (!version) {
  console.error(`Could not read a version from "${name}". Expected Atlas_<version>_x64-setup.exe.`);
  process.exit(1);
}

const repo = flag('repo') ?? '17sh8dy/Atlas';
const path = resolve(file);
const sha256 = await new Promise((done, fail) => {
  const hash = createHash('sha256');
  createReadStream(path)
    .on('data', (c) => hash.update(c))
    .on('end', () => done(hash.digest('hex')))
    .on('error', fail);
});

const manifest = {
  product: 'atlas',
  version,
  downloadUrl: `https://github.com/${repo}/releases/download/v${version}/${name}`,
  sha256,
  sizeBytes: statSync(path).size,
  releaseNotes: notes,
  mandatory: args.includes('--mandatory'),
  ...(flag('min-version') ? { minimumVersion: flag('min-version') } : {}),
  publishedAt: new Date().toISOString(),
};

const out = resolve(flag('out') ?? 'latest.json');
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `Wrote ${out}\n  version ${version}\n  sha256  ${sha256}\n  size    ${manifest.sizeBytes}`,
);
