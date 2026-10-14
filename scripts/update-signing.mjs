#!/usr/bin/env node
/**
 * Signs the update manifest Atlas checks, and makes the key that does it.
 *
 *   node scripts/update-signing.mjs keygen --out <private-key.pem>
 *       Makes an Ed25519 key. The private half is written to --out (refused inside this
 *       repository, so it cannot be committed by accident) and the PUBLIC half is printed:
 *       paste it into `PUBLIC_KEY_HEX` in `apps/desktop/src-tauri/src/update_signature.rs`.
 *
 *   node scripts/update-signing.mjs sign <latest.json> --key <private-key.pem>
 *       Adds (or replaces) the manifest's `signature` in place.
 *
 *   node scripts/update-signing.mjs vector --out <file>
 *       Writes a manifest signed with a throwaway key, plus its public key, for the Rust test
 *       that proves this file and `update_signature.rs` build the same signed text.
 *
 * The text that is signed (`canonicalPayload`) must stay byte-for-byte what
 * `update_signature::canonical_payload` builds. The Rust test reads the vector this writes.
 *
 * Keep the private key off this machine's repo, backed up somewhere you control, and never in a
 * release. Lose it and installed copies can no longer verify new updates (they would have to be
 * reinstalled); leak it and anyone can publish an update that installed copies will accept.
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
} from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const KEY_ID = 'atlas-release-1';

/** Exactly `update_signature::canonical_payload`. */
export function canonicalPayload(m) {
  const notes = Array.isArray(m.releaseNotes) ? m.releaseNotes.filter((n) => typeof n === 'string') : [];
  return [
    'atlas-update-v1',
    `product=${String(m.product).trim().toLowerCase()}`,
    `version=${String(m.version).trim()}`,
    `url=${m.downloadUrl}`,
    `sha256=${String(m.sha256).toLowerCase()}`,
    `size=${Number.isInteger(m.sizeBytes) ? m.sizeBytes : 0}`,
    `mandatory=${m.mandatory === true}`,
    `min=${m.minimumVersion ?? ''}`,
    `published=${m.publishedAt ?? ''}`,
    `notes=${notes.join('\u001f')}`,
  ].join('\n');
}

export function signManifest(manifest, privateKeyPem) {
  const key = createPrivateKey(privateKeyPem);
  const body = { ...manifest };
  delete body.signature;
  const value = cryptoSign(null, Buffer.from(canonicalPayload(body), 'utf8'), key).toString('base64');
  return { ...body, signature: { algorithm: 'ed25519', keyId: KEY_ID, value } };
}

export function publicKeyHex(privateKeyPem) {
  const pub = createPublicKey(createPrivateKey(privateKeyPem));
  // The SPKI DER for Ed25519 ends with the 32 raw key bytes.
  return pub.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
}

function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = resolve(here, '..');

  if (cmd === 'keygen') {
    const out = flag(rest, 'out');
    if (!out) throw new Error('keygen needs --out <private-key.pem>');
    const target = resolve(out);
    const rel = relative(repo, target);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
      throw new Error(`Refusing to write the private key inside the repository (${target}).`);
    }
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, pem, { flag: 'wx', mode: 0o600 });
    console.log(`Private key written to ${target}`);
    console.log('Back it up somewhere safe. It is the only thing that can sign updates.');
    console.log(`\nPublic key (paste into PUBLIC_KEY_HEX in update_signature.rs):\n${publicKeyHex(pem)}`);
    return;
  }

  if (cmd === 'sign') {
    const file = rest.find((a) => !a.startsWith('--'));
    const keyFile = flag(rest, 'key') ?? process.env.ATLAS_UPDATE_SIGNING_KEY;
    if (!file || !keyFile) throw new Error('sign needs <latest.json> and --key <private-key.pem>');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    const signed = signManifest(manifest, readFileSync(keyFile, 'utf8'));
    writeFileSync(file, `${JSON.stringify(signed, null, 2)}\n`);
    console.log(`Signed ${file} (key ${KEY_ID}, public ${publicKeyHex(readFileSync(keyFile, 'utf8')).slice(0, 16)}…)`);
    return;
  }

  if (cmd === 'vector') {
    const out = flag(rest, 'out');
    if (!out) throw new Error('vector needs --out <file>');
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const manifest = signManifest(
      {
        product: 'atlas',
        version: '2.0.0',
        downloadUrl: 'https://github.com/17sh8dy/Atlas/releases/download/v2.0.0/Atlas_2.0.0_x64-setup.exe',
        sha256: 'a3f1c2d4e5b60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
        sizeBytes: 123456789,
        releaseNotes: ['Native confirmation for trust changes', 'Signed updates — with “quotes” and ünïcode'],
        mandatory: false,
        minimumVersion: '1.0.0',
        publishedAt: '2026-10-14T00:00:00.000Z',
      },
      pem,
    );
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(
      out,
      `${JSON.stringify(
        {
          note: 'A throwaway key. Proves update-signing.mjs and update_signature.rs sign the same text. Not a release key.',
          publicKeyHex: publicKeyHex(pem),
          manifest,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`Wrote ${out}`);
    return;
  }

  throw new Error('Usage: update-signing.mjs keygen|sign|vector (see the header of this file)');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`\n✖ ${e.message}`);
    process.exit(1);
  }
}
