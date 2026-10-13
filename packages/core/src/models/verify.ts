/**
 * Verification probes: reading the machine back to see whether an action did what it said.
 *
 * A skill reporting `ok` means *it believes it succeeded*. Whether a file now exists or a
 * program is running is a separate fact that can be read, and the two should not be confused
 * in what Atlas tells a person. A probe is that read-back as plain data: a small closed set
 * of questions about the machine ("is there a file here?", "is this program running?") that
 * the engine answers with the platform's own read-only calls.
 *
 * Probes are data on purpose. A skill never ships its own verification script; it names which
 * of these questions settles it, and one runner evaluates them all. That keeps verification
 * reusable, testable once, and incapable of doing anything but read.
 */

export type Probe =
  /** Something exists at this absolute path. */
  | { kind: 'path-exists'; path: string }
  /** Nothing exists at this absolute path. */
  | { kind: 'path-absent'; path: string }
  /** A folder exists at this path. */
  | { kind: 'path-is-folder'; path: string }
  /** A file (not a folder) exists at this path. */
  | { kind: 'path-is-file'; path: string }
  /** A program with this name (or image) is running. */
  | { kind: 'process-running'; name: string }
  /** No program with this name is running. */
  | { kind: 'process-stopped'; name: string }
  /** A window belonging to this program, or whose title contains this text, is open. */
  | { kind: 'window-open'; match: string };

export type ProbeKind = Probe['kind'];

/** A probe plus how a miss should be handled. */
export type ProbeSpec = Probe & {
  /**
   * Say so out loud when this probe reads the opposite of what the skill reported. Reserved
   * for facts that are immediate and unambiguous (a file that was just created is not there).
   * A program that is slow to appear is only recorded, not announced.
   */
  announce?: boolean;
};

/**
 * What one probe found.
 *  confirmed    — the machine reads as the skill said it would.
 *  contradicted — the machine reads the opposite.
 *  unknown      — it could not be read (no such platform call, access refused).
 */
export type ProbeState = 'confirmed' | 'contradicted' | 'unknown';

export interface ProbeResult {
  probe: ProbeSpec;
  state: ProbeState;
  /** What was actually observed, in a few words. Never "success". */
  evidence: string;
}

/**
 * The state of a step after its probes ran. `confirmed` only when every probe read as
 * expected; anything else is `unconfirmed` — which is not a failure, and is never reported
 * as one: the action may well have worked, Atlas simply has not seen it.
 */
export type Verification = 'confirmed' | 'unconfirmed';

export function summarizeProbes(
  results: readonly ProbeResult[],
): { verified: Verification; evidence: string } | null {
  if (!results.length) return null;
  const bad = results.filter((r) => r.state !== 'confirmed');
  if (!bad.length) return { verified: 'confirmed', evidence: results.map((r) => r.evidence).join('; ') };
  return { verified: 'unconfirmed', evidence: bad.map((r) => r.evidence).join('; ') };
}
