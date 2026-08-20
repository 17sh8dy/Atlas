/**
 * Fetch the speech engine and voice model.
 *
 * These are ~114 MB of compiled binaries and neural weights. They are not in
 * git — a repository is for source, and a 114 MB blob makes every clone pay
 * for it forever. This script is the reproducible alternative: it puts the
 * exact same bytes in the exact same place on any machine.
 *
 *   pnpm --filter @atlas/desktop voices
 *
 * ── What is being downloaded, and why each one ──────────────────────────────
 *
 * Piper (rhasspy/piper, MIT). A local neural TTS engine — no account, no key,
 * no network at speech time, which is the only kind of voice that belongs in
 * an assistant whose whole thesis is working with nothing connected.
 *
 *   ⚠️ Pinned to the ARCHIVED 2023.11.14-2 release on purpose. Development
 *   moved to OHF-Voice/piper1-gpl, which is GPL — linking that into Atlas
 *   would dictate Atlas's own licensing. The archived release is MIT. Do not
 *   "update" this to the newer repo without deciding that question first.
 *
 * VCTK (en_GB-vctk-medium, CC BY 4.0). One model file carrying 109 speakers,
 * which is why three voices cost one download rather than three.
 *
 *   ⚠️ The obvious choice was en_GB-alan-medium — the classic British male.
 *   It was rejected: its training data traces to MycroftAI/mimic3-voices,
 *   whose LICENSE reads "Copyright 2022 Mycroft AI All Rights Reserved" with
 *   no grant to redistribute. VCTK is CC BY 4.0, which permits commercial use
 *   with attribution, and the attribution lives in Settings → About.
 *
 * Sizes are asserted, not trusted. A truncated download of a neural model
 * fails at synthesis time with something unhelpful; failing here, loudly,
 * costs a re-run instead of an afternoon.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat, readdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const vendor = join(here, '..', 'src-tauri', 'vendor', 'piper');

const DOWNLOADS = [
  {
    name: 'piper_windows_amd64.zip',
    url: 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip',
    bytes: 22_477_236,
    unzip: true,
  },
  {
    name: 'en_GB-vctk-medium.onnx',
    url: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/vctk/medium/en_GB-vctk-medium.onnx',
    bytes: 76_952_753,
  },
  {
    name: 'en_GB-vctk-medium.onnx.json',
    url: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/vctk/medium/en_GB-vctk-medium.onnx.json',
    bytes: 6_637,
  },
];

async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return -1;
  }
}

async function download(item) {
  const target = join(vendor, item.name);

  if ((await sizeOf(target)) === item.bytes) {
    console.log(`  ✓ ${item.name} — already present`);
    return target;
  }

  process.stdout.write(`  … ${item.name} (${(item.bytes / 1e6).toFixed(1)} MB)`);
  const response = await fetch(item.url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`\n${item.name}: HTTP ${response.status} from ${item.url}`);
  }

  // Written to a partial name and renamed only on success, so an interrupted
  // run can never leave a half-file that looks finished to the next one.
  const partial = `${target}.partial`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));

  const got = await sizeOf(partial);
  if (got !== item.bytes) {
    await rm(partial, { force: true });
    throw new Error(`\n${item.name}: expected ${item.bytes} bytes, got ${got}`);
  }
  await rename(partial, target);
  console.log(' done');
  return target;
}

async function main() {
  console.log('Fetching the speech engine and voice model…');
  await mkdir(vendor, { recursive: true });

  for (const item of DOWNLOADS) {
    const path = await download(item);

    if (item.unzip) {
      const marker = join(vendor, 'piper', 'piper.exe');
      if ((await sizeOf(marker)) < 0) {
        process.stdout.write('  … unpacking');
        // Expand-Archive rather than a zip dependency: this script exists to
        // avoid weight, and Windows already ships the unpacker.
        await run('powershell', [
          '-NoProfile',
          '-Command',
          `Expand-Archive -LiteralPath '${path}' -DestinationPath '${vendor}' -Force`,
        ]);
        console.log(' done');
      }
    }
  }

  const files = await readdir(join(vendor, 'piper'));
  if (!files.includes('piper.exe')) {
    throw new Error('piper.exe is missing after unpacking — the archive layout changed.');
  }
  console.log(`\nReady: ${vendor}`);
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exitCode = 1;
});
