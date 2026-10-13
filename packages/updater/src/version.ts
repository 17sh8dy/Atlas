/** Versions as `major.minor.patch`, optionally with a `-prerelease`. Nothing else is a version. */
const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,32}))?$/;

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  pre: string | null;
}

export function parseVersion(raw: string): ParsedVersion | null {
  const m = VERSION.exec(String(raw ?? '').trim());
  if (!m) return null;
  return { major: +m[1]!, minor: +m[2]!, patch: +m[3]!, pre: m[4] ?? null };
}

/**
 * -1, 0 or 1. A prerelease sorts *below* its release (`1.0.0-beta < 1.0.0`),
 * so nobody is offered a beta as an upgrade from the version it precedes.
 * Returns null when either side is not a version — never a guess.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return comparePrerelease(x.pre, y.pre);
}

/**
 * SemVer's rule for the part after the hyphen: dot-separated identifiers,
 * numeric ones compared as numbers (so `rc.10` is after `rc.9`, not before it),
 * a numeric one sorting below a text one, and the longer list winning a tie.
 */
function comparePrerelease(a: string, b: string): -1 | 0 | 1 {
  const left = a.split('.');
  const right = b.split('.');
  const n = Math.max(left.length, right.length);
  for (let i = 0; i < n; i++) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    if (ln && rn) {
      const d = Number(l) - Number(r);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (ln !== rn) {
      return ln ? -1 : 1;
    } else if (l !== r) {
      return l < r ? -1 : 1;
    }
  }
  return 0;
}
