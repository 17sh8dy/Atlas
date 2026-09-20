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
  return x.pre < y.pre ? -1 : 1;
}
