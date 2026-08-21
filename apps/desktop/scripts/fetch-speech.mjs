/**
 * Fetch the speech engines and their models — the voice Atlas speaks with, and
 * the ears it listens through.
 *
 * These are ~250 MB of compiled binaries and neural weights. They are not in
 * git — a repository is for source, and a blob that size makes every clone pay
 * for it forever. This script is the reproducible alternative: it puts the
 * exact same bytes in the exact same place on any machine.
 *
 *   pnpm --filter @atlas/desktop speech
 *
 * ── Speaking ────────────────────────────────────────────────────────────────
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
 * ── Listening ───────────────────────────────────────────────────────────────
 *
 * whisper.cpp (ggml-org/whisper.cpp, MIT). Same standard as the voice: the
 * transcription happens here, on this CPU, and nothing spoken to Atlas leaves
 * the machine. Pinned to a build tag rather than "latest" so two clones a
 * month apart get the same binary.
 *
 *   The plain x64 build, not the cuBLAS ones (670 MB, and this is an AMD
 *   machine) and not the BLAS build — base.en on CPU is already comfortably
 *   faster than real time, and OpenBLAS would add 13 MB to buy speed that
 *   nothing here is waiting on.
 *
 * ggml-base.en.bin (~148 MB, MIT). English-only, and the deliberate choice
 * over tiny.en: tiny mishears names and technical words often enough that you
 * stop trusting it, and an assistant you have to repeat yourself to is worse
 * than a text box. The installer grows by ~150 MB for it. That was the call.
 *
 * ── Rules ───────────────────────────────────────────────────────────────────
 *
 * Sizes are asserted, not trusted. A truncated download of a neural model
 * fails at inference time with something unhelpful; failing here, loudly,
 * costs a re-run instead of an afternoon.
 *
 * Archives are pruned to the files actually used. The whisper release ships
 * thirty-odd binaries — servers, test harnesses, an SDL2 build, a llama
 * runtime — and shipping them would put executables in the installer that
 * Atlas never calls and cannot account for.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat, readdir, rename, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const vendorRoot = join(here, '..', 'src-tauri', 'vendor');
const piperDir = join(vendorRoot, 'piper');
const whisperDir = join(vendorRoot, 'whisper');

const DOWNLOADS = [
  {
    dir: piperDir,
    name: 'piper_windows_amd64.zip',
    url: 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip',
    bytes: 22_477_236,
    unzip: { marker: join(piperDir, 'piper', 'piper.exe') },
  },
  {
    dir: piperDir,
    name: 'en_GB-vctk-medium.onnx',
    url: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/vctk/medium/en_GB-vctk-medium.onnx',
    bytes: 76_952_753,
  },
  {
    dir: piperDir,
    name: 'en_GB-vctk-medium.onnx.json',
    url: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/vctk/medium/en_GB-vctk-medium.onnx.json',
    bytes: 6_637,
  },
  {
    dir: whisperDir,
    name: 'whisper-bin-x64.zip',
    url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b4938/whisper-bin-x64.zip',
    bytes: 8_361_840,
    // Unpacks to Release/, which is then flattened down to the seven files
    // Atlas actually runs. See KEEP below.
    unzip: { marker: join(whisperDir, 'whisper-cli.exe'), flattenFrom: 'Release' },
  },
  {
    dir: whisperDir,
    name: 'ggml-base.en.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
    bytes: 147_964_211,
  },
];

/**
 * What survives the prune.
 *
 * `whisper-cli.exe` is the only thing invoked; the rest are the libraries it
 * loads. The `ggml-cpu-*` set is not redundant — whisper.cpp picks one at
 * runtime by probing CPU features, so dropping the ones this machine does not
 * use would produce a build that only runs on this machine.
 */
const KEEP = (name) =>
  name === 'whisper-cli.exe' ||
  name === 'whisper.dll' ||
  name === 'ggml.dll' ||
  name === 'ggml-base.dll' ||
  name.startsWith('ggml-cpu-');

async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return -1;
  }
}

async function download(item) {
  const target = join(item.dir, item.name);

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

async function unpack(item, archive) {
  if ((await sizeOf(item.unzip.marker)) >= 0) return;

  process.stdout.write('  … unpacking');
  // Expand-Archive rather than a zip dependency: this script exists to avoid
  // weight, and Windows already ships the unpacker.
  await run('powershell', [
    '-NoProfile',
    '-Command',
    `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${item.dir}' -Force`,
  ]);

  if (item.unzip.flattenFrom) {
    const nested = join(item.dir, item.unzip.flattenFrom);
    for (const name of await readdir(nested)) {
      if (KEEP(name)) await copyFile(join(nested, name), join(item.dir, name));
    }
    await rm(nested, { recursive: true, force: true });
  }

  console.log(' done');
}

async function main() {
  console.log('Fetching the speech engines and their models…');
  await mkdir(piperDir, { recursive: true });
  await mkdir(whisperDir, { recursive: true });

  for (const item of DOWNLOADS) {
    const path = await download(item);
    if (item.unzip) await unpack(item, path);
  }

  // The archives change layout between releases far more often than they
  // change contents, so the shape is checked rather than assumed.
  const speaking = await readdir(join(piperDir, 'piper'));
  if (!speaking.includes('piper.exe')) {
    throw new Error('piper.exe is missing after unpacking — the archive layout changed.');
  }
  const listening = await readdir(whisperDir);
  for (const required of ['whisper-cli.exe', 'whisper.dll', 'ggml.dll']) {
    if (!listening.includes(required)) {
      throw new Error(`${required} is missing after unpacking — the archive layout changed.`);
    }
  }

  console.log(`\nReady:\n  speaking  ${piperDir}\n  listening ${whisperDir}`);
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exitCode = 1;
});
