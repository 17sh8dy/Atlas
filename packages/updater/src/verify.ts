/**
 * Deciding whether a downloaded package may be installed.
 *
 * The backend measures; this judges. Keeping the decision here, in pure code,
 * means the rule is one readable function that every Nova app shares and a test
 * can pin — not something re-derived inside each platform's file handling.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * Every check must pass. There is no "mostly":
 *   1. SHA-256 equals the manifest's. This is what makes an HTTPS download
 *      that was swapped, truncated or corrupted refuse to install.
 *   2. Size equals the manifest's, when it names one.
 *   3. The installer's own product name is the expected product and its
 *      version is the version the manifest announced — so a valid installer for
 *      the wrong app, or an old one served under a new name, is refused.
 *   4. A present-but-broken Authenticode signature is always refused. An absent
 *      one is refused only when `requireSignature` is on (it is off until
 *      Atlas builds are code-signed — see the roadmap).
 *   5. If the manifest is signed *and* a `ManifestSignatureVerifier` is
 *      configured, that signature must check out. This is the seam for
 *      cryptographic manifest signing; with no verifier the field is ignored
 *      rather than trusted.
 */

import type { VerifyReport } from './backend';
import type { UpdateManifest } from './manifest';

export interface VerifyPolicy {
  /** Refuse an installer with no code signature at all. */
  requireSignature: boolean;
  /** The product name to expect in the installer, e.g. "Atlas". Compared without case. */
  expectedProduct: string;
}

export interface ManifestSignatureVerifier {
  verify(manifest: UpdateManifest): Promise<boolean> | boolean;
}

export type Verdict = { ok: true } | { ok: false; reason: string };

export async function judgeVerification(
  report: VerifyReport,
  manifest: UpdateManifest,
  policy: VerifyPolicy,
  signatureVerifier?: ManifestSignatureVerifier,
): Promise<Verdict> {
  if (report.sha256.toLowerCase() !== manifest.sha256) {
    return {
      ok: false,
      reason: 'The download does not match its checksum, so it was not installed.',
    };
  }
  if (manifest.sizeBytes !== null && report.sizeBytes !== manifest.sizeBytes) {
    return { ok: false, reason: 'The download is not the size it should be.' };
  }
  if ((report.product ?? '').toLowerCase() !== policy.expectedProduct.toLowerCase()) {
    return { ok: false, reason: `The download is not an ${policy.expectedProduct} installer.` };
  }
  if (report.version !== manifest.version) {
    return {
      ok: false,
      reason: `The download is version ${report.version ?? 'unknown'}, not ${manifest.version}.`,
    };
  }
  if (report.signature === 'invalid') {
    return { ok: false, reason: 'The download’s code signature is invalid.' };
  }
  if (report.signature !== 'valid' && policy.requireSignature) {
    return { ok: false, reason: 'The download is not code-signed.' };
  }
  if (manifest.signature && signatureVerifier) {
    let good = false;
    try {
      good = await signatureVerifier.verify(manifest);
    } catch {
      good = false;
    }
    if (!good) return { ok: false, reason: 'The update’s signature could not be verified.' };
  }
  return { ok: true };
}
