/**
 * The update manifest: one small JSON document that says what the newest
 * version of a product is and where to get it.
 *
 * ```json
 * {
 *   "product": "atlas",
 *   "version": "0.86.0",
 *   "downloadUrl": "https://github.com/…/Atlas_0.86.0_x64-setup.exe",
 *   "sha256": "<64 hex characters>",
 *   "sizeBytes": 373795559,
 *   "releaseNotes": ["Faster replies", "Fixed …"],
 *   "mandatory": false,
 *   "minimumVersion": "0.80.0",
 *   "publishedAt": "2026-09-20T00:00:00Z",
 *   "signature": { "algorithm": "ed25519", "keyId": "nova-2026", "value": "<base64>" }
 * }
 * ```
 *
 * The manifest comes off the network, so nothing in it is trusted until it has
 * been through `parseManifest`. That function accepts only what it fully
 * understands and says *why* when it refuses — a manifest that is almost right
 * must not be installed.
 *
 * `signature` is parsed and carried but not yet checked: see `verify.ts`. It is
 * in the format now so a signed manifest and an unsigned one are the same
 * shape and signing can be switched on without a format change.
 */

import { parseVersion } from './version';

export interface UpdateSignature {
  algorithm: 'ed25519';
  keyId: string;
  /** Base64. */
  value: string;
}

export interface UpdateManifest {
  product: string;
  version: string;
  downloadUrl: string;
  /** Lowercase hex SHA-256 of the file at `downloadUrl`. Required: no hash, no install. */
  sha256: string;
  sizeBytes: number | null;
  /** Short lines, most important first. */
  releaseNotes: string[];
  /** A mandatory update cannot be dismissed with "Later". */
  mandatory: boolean;
  /** Versions older than this cannot update in place and must reinstall. */
  minimumVersion: string | null;
  publishedAt: string | null;
  signature: UpdateSignature | null;
}

export type ManifestResult = { ok: true; manifest: UpdateManifest } | { ok: false; reason: string };

const HEX64 = /^[0-9a-f]{64}$/;
const MAX_NOTES = 12;
const MAX_NOTE_LENGTH = 200;

export function parseManifest(input: unknown, expectedProduct?: string): ManifestResult {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      return { ok: false, reason: 'The update information was not valid JSON.' };
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'The update information was not an object.' };
  }
  const o = raw as Record<string, unknown>;

  const product = typeof o.product === 'string' ? o.product.trim().toLowerCase() : '';
  if (!product) return { ok: false, reason: 'The update information does not name a product.' };
  if (expectedProduct && product !== expectedProduct.toLowerCase()) {
    return { ok: false, reason: `This update is for “${product}”, not “${expectedProduct}”.` };
  }

  const version = typeof o.version === 'string' ? o.version.trim() : '';
  if (!parseVersion(version)) {
    return { ok: false, reason: `“${String(o.version)}” is not a version number.` };
  }

  const downloadUrl = typeof o.downloadUrl === 'string' ? o.downloadUrl.trim() : '';
  if (!/^https:\/\/[^\s/?#]+(?:[/?#]\S*)?$/i.test(downloadUrl)) {
    return { ok: false, reason: 'The download address must be a secure (https) link.' };
  }

  const sha256 = typeof o.sha256 === 'string' ? o.sha256.trim().toLowerCase() : '';
  if (!HEX64.test(sha256)) {
    return {
      ok: false,
      reason: 'The update has no valid SHA-256 checksum, so it cannot be verified.',
    };
  }

  let sizeBytes: number | null = null;
  if (o.sizeBytes !== undefined && o.sizeBytes !== null) {
    if (typeof o.sizeBytes !== 'number' || !Number.isInteger(o.sizeBytes) || o.sizeBytes <= 0) {
      return { ok: false, reason: 'The update size is not a positive whole number.' };
    }
    sizeBytes = o.sizeBytes;
  }

  const notes = Array.isArray(o.releaseNotes) ? o.releaseNotes : [];
  const releaseNotes = notes
    .filter((n): n is string => typeof n === 'string')
    .map((n) => n.trim().slice(0, MAX_NOTE_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_NOTES);

  let minimumVersion: string | null = null;
  if (typeof o.minimumVersion === 'string' && o.minimumVersion.trim()) {
    if (!parseVersion(o.minimumVersion)) {
      return { ok: false, reason: 'The minimum version is not a version number.' };
    }
    minimumVersion = o.minimumVersion.trim();
  }

  let signature: UpdateSignature | null = null;
  const sig = o.signature as Record<string, unknown> | null | undefined;
  if (sig && typeof sig === 'object') {
    if (
      sig.algorithm !== 'ed25519' ||
      typeof sig.keyId !== 'string' ||
      typeof sig.value !== 'string'
    ) {
      return {
        ok: false,
        reason: 'The update signature is in a format Atlas does not understand.',
      };
    }
    signature = { algorithm: 'ed25519', keyId: sig.keyId, value: sig.value };
  }

  return {
    ok: true,
    manifest: {
      product,
      version,
      downloadUrl,
      sha256,
      sizeBytes,
      releaseNotes,
      mandatory: o.mandatory === true,
      minimumVersion,
      publishedAt: typeof o.publishedAt === 'string' ? o.publishedAt : null,
      signature,
    },
  };
}
