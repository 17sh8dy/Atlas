#!/usr/bin/env node
/**
 * The knowledge pack's signing key (atlas-knowledge-1), kept SEPARATE from the installer-update key
 * so publishing a knowledge pack never touches the key that can install software.
 *
 *   node scripts/knowledge-signing.mjs keygen --out <private-key.pem>
 *       Makes an Ed25519 key. The private half is written to --out (refused inside this repository
 *       so it cannot be committed) and the PUBLIC half is printed: paste it into `PUBLIC_KEY_HEX`
 *       in apps/desktop/src-tauri/src/knowledge_signature.rs.
 *
 *   node scripts/knowledge-signing.mjs vector --out <file>
 *       Writes a pack signed with a throwaway key, plus its public key, for the Rust test that
 *       proves this and knowledge_signature.rs build the same signed text.
 *
 * Back the key up the same way as the update key (scripts/signing-key-backup.mjs): lose it and
 * installed copies can never verify a refreshed pack again; leak it and anyone can publish one.
 */

import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicKeyHex, sha256Hex, signPack, KEY_ID } from './knowledge-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const [cmd, ...rest] = process.argv.slice(2);
const flag = (n) => (rest.includes(`--${n}`) ? rest[rest.indexOf(`--${n}`) + 1] : undefined);

function outsideRepo(p) {
  const rel = relative(repo, resolve(p));
  return rel.startsWith('..') || isAbsolute(rel);
}

if (cmd === 'keygen') {
  const out = flag('out');
  if (!out) throw new Error('keygen needs --out <private-key.pem>');
  if (!outsideRepo(out)) throw new Error('refusing to write a private key inside the repository');
  if (existsSync(out)) throw new Error(`${out} already exists; refusing to overwrite a key`);
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, pem, { mode: 0o600 });
  console.log(`Wrote ${out}\nKey id: ${KEY_ID}\nPUBLIC_KEY_HEX = "${publicKeyHex(pem)}"`);
} else if (cmd === 'vector') {
  const out = flag('out');
  if (!out) throw new Error('vector needs --out <file>');
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pack = Buffer.from(JSON.stringify({ schema: 1, seq: 1000, builtAt: '2026-10-23T00:00:00.000Z', keyId: KEY_ID, dev: false, chunks: [] }), 'utf8');
  const sig = signPack(pack, { seq: 1000, builtAt: '2026-10-23T00:00:00.000Z' }, pem);
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, JSON.stringify({ publicKeyHex: publicKeyHex(pem), pack: pack.toString('utf8'), sha256: sha256Hex(pack), sig }, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${out}`);
} else {
  console.error('usage: knowledge-signing.mjs keygen --out <pem> | vector --out <file>');
  process.exit(2);
}
