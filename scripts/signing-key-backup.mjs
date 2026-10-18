#!/usr/bin/env node
/**
 * Encrypted backup of the update-signing private key.
 *
 *   node scripts/signing-key-backup.mjs backup  --key <private-key.pem> --out <backup-file>
 *   node scripts/signing-key-backup.mjs verify  --in <backup-file>
 *   node scripts/signing-key-backup.mjs restore --in <backup-file> --out <private-key.pem>
 *
 * Why this exists: the private key is the only thing that can sign Atlas updates. Lose it and
 * installed copies can never verify another update; leak it and anyone can publish one that they
 * will accept. So the backup is (a) encrypted with a passphrase only the owner knows, and (b) meant
 * to be copied somewhere that is not this computer (an external drive, a password manager's file
 * storage). It never goes in the repository, and `--out` is refused if it is inside it.
 *
 * Encryption: scrypt (N=2^17, r=8, p=1) derives a 256-bit key from the passphrase; the key pem is
 * sealed with AES-256-GCM, so a wrong passphrase or a damaged file is reported, never "decrypted"
 * to garbage. The file also records the PUBLIC half, so `verify` can prove the backup is the key
 * that is compiled into Atlas without writing the private key anywhere.
 *
 * The passphrase is read from the terminal with nothing echoed. `ATLAS_BACKUP_PASSPHRASE` exists
 * only so the round trip can be tested without a keyboard; do not use it for the real backup,
 * because an environment variable is easy to leave in a shell history.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicKeyHex } from './update-signing.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRYPT = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const MIN_PASSPHRASE = 12;

function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function insideRepo(path) {
  const rel = relative(root, resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Reads a line from the terminal without echoing it. */
function readHidden(prompt) {
  if (process.env.ATLAS_BACKUP_PASSPHRASE) return Promise.resolve(process.env.ATLAS_BACKUP_PASSPHRASE);
  if (!process.stdin.isTTY) fail('No terminal to type a passphrase into. Run this in your own terminal window.');
  return new Promise((resolveLine) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolveLine(value);
          return;
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

function seal(pem, passphrase) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, SCRYPT);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(pem, 'utf8'), cipher.final()]);
  return {
    format: 'atlas-signing-key-backup',
    version: 1,
    kdf: { name: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
    cipher: 'aes-256-gcm',
    publicKeyHex: publicKeyHex(pem),
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ct.toString('base64'),
  };
}

function open(blob, passphrase) {
  if (blob?.format !== 'atlas-signing-key-backup' || blob.version !== 1) fail('That file is not an Atlas signing-key backup.');
  const key = scryptSync(passphrase, Buffer.from(blob.salt, 'base64'), 32, {
    N: blob.kdf.N,
    r: blob.kdf.r,
    p: blob.kdf.p,
    maxmem: 256 * 1024 * 1024,
  });
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  try {
    const pem = Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]).toString('utf8');
    if (publicKeyHex(pem) !== blob.publicKeyHex) fail('The backup decrypted but its key does not match the public key it recorded.');
    return pem;
  } catch {
    fail('Wrong passphrase, or the backup file is damaged.');
  }
}

/** The public key compiled into this checkout of Atlas, or '' when none is provisioned. */
function compiledInKey() {
  const source = readFileSync(join(root, 'apps', 'desktop', 'src-tauri', 'src', 'update_signature.rs'), 'utf8');
  return /PUBLIC_KEY_HEX: &str = "([0-9a-f]*)"/.exec(source)?.[1] ?? '';
}

const [command, ...args] = process.argv.slice(2);

if (command === 'backup') {
  const keyFile = flag(args, 'key');
  const out = flag(args, 'out');
  if (!keyFile || !out) fail('Usage: backup --key <private-key.pem> --out <backup-file>');
  if (insideRepo(out)) fail('Refusing to write a key backup inside the Atlas repository.');
  if (existsSync(out)) fail(`${out} already exists. Choose a new file name; an old backup is not overwritten.`);
  const pem = readFileSync(keyFile, 'utf8');
  const first = await readHidden('Choose a passphrase (12+ characters; you must be able to recall it): ');
  if (first.length < MIN_PASSPHRASE) fail(`A passphrase needs at least ${MIN_PASSPHRASE} characters.`);
  const second = await readHidden('Type it again: ');
  if (first !== second) fail('The two passphrases do not match. Nothing was written.');
  const blob = seal(pem, first);
  // Prove the file just made can be opened before telling anyone it is safe.
  if (open(blob, first) !== pem) fail('Self-check failed. Nothing was written.');
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, `${JSON.stringify(blob, null, 2)}\n`, { flag: 'wx' });
  const compiled = compiledInKey();
  console.log(`\nBackup written to ${out}`);
  console.log(`  public key ${blob.publicKeyHex}`);
  console.log(compiled === blob.publicKeyHex ? '  matches the key compiled into Atlas ✔' : '  ⚠ does NOT match the key compiled into Atlas');
  console.log('\nNow copy that file somewhere that is not this computer, and keep the passphrase apart from it.');
} else if (command === 'verify' || command === 'restore') {
  const input = flag(args, 'in');
  if (!input) fail(`Usage: ${command} --in <backup-file>${command === 'restore' ? ' --out <private-key.pem>' : ''}`);
  const blob = JSON.parse(readFileSync(input, 'utf8'));
  const pem = open(blob, await readHidden('Passphrase: '));
  const compiled = compiledInKey();
  const matches = compiled === blob.publicKeyHex;
  if (command === 'verify') {
    console.log(`\n✔ Backup opens. Public key ${blob.publicKeyHex}`);
    console.log(matches ? '  matches the key compiled into Atlas ✔' : '  ⚠ does NOT match the key compiled into Atlas');
    process.exit(matches ? 0 : 1);
  }
  const out = flag(args, 'out');
  if (!out) fail('restore needs --out <private-key.pem>');
  if (insideRepo(out)) fail('Refusing to write a private key inside the Atlas repository.');
  if (existsSync(out)) fail(`${out} already exists; restoring will not overwrite it.`);
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, pem, { flag: 'wx', mode: 0o600 });
  console.log(`\n✔ Restored to ${out}`);
} else {
  fail('Usage: signing-key-backup.mjs backup|verify|restore (see the header of this file).');
}
