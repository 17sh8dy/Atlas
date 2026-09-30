/**
 * Administrator rights and protected input targets — the vocabulary shared by
 * the native side (`elevation.rs`, `input_guard.rs`) and everything above it.
 *
 * Nothing here can run anything. These are the shapes of a *request*, of a
 * *refusal*, and of what Windows said about a target.
 */

/**
 * Everything that can be run with administrator rights. Closed on purpose: the
 * native side deserialises exactly these and nothing else, so a new kind of
 * elevated action is a change to this type and to `elevation.rs`, in review.
 */
export type ElevationOperation =
  | { kind: 'serviceStart'; name: string }
  | { kind: 'serviceStop'; name: string }
  | { kind: 'envSet'; name: string; value: string }
  | { kind: 'envDelete'; name: string };

/** What the native side issues once it has checked an operation. Nothing has run. */
export interface ElevationRequest {
  /** One-time, expiring, bound to exactly this operation. Never shown. */
  token: string;
  /** In words: "Stop the Windows service “Print Spooler”". */
  operation: string;
  /** The fixed Windows program, e.g. `sc.exe`. */
  program: string;
  programPath: string;
  /** The exact arguments that will run. Echoed back so what was shown is what runs. */
  commandLine: string;
  reason: string;
  ttlSecs: number;
  /** The start of the program's SHA-256, so the card can say which file. */
  programId: string;
}

export interface ElevationOutcome {
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * What the native side answers when an action needs administrator rights and
 * Atlas has none. A signal, not a failure: the response is to ask.
 */
export const NEEDS_ELEVATION = 'NEEDS_ELEVATION';

export function needsElevation(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err ?? '');
  return text.trim() === NEEDS_ELEVATION;
}

/** Why input to a target was refused. */
export type InputBlockCode = 'protected-desktop' | 'uac' | 'elevated' | 'unknown';

/**
 * Input was refused for this target — a Windows permission screen, something
 * running above Atlas, or something Atlas could not identify. Distinct from a
 * failure: nothing was attempted, and the reason is the point.
 */
export class InputBlockedError extends Error {
  constructor(
    readonly code: InputBlockCode,
    message: string,
  ) {
    super(message);
    this.name = 'InputBlockedError';
  }
}

/** `BLOCKED:<code>:<sentence>` from the native side → an `InputBlockedError`. */
export function parseInputBlock(err: unknown): InputBlockedError | null {
  const text = err instanceof Error ? err.message : String(err ?? '');
  const match = /^BLOCKED:([a-z-]+):([\s\S]*)$/.exec(text.trim());
  if (!match) return null;
  const code = match[1] as InputBlockCode;
  const known: InputBlockCode[] = ['protected-desktop', 'uac', 'elevated', 'unknown'];
  return new InputBlockedError(known.includes(code) ? code : 'unknown', match[2]!.trim());
}

/** Would input to this target be allowed? Answered without sending anything. */
export interface InputProbe {
  allowed: boolean;
  code?: InputBlockCode;
  message?: string;
  /** The program that owns the target, e.g. `notepad.exe`. */
  image?: string;
  title?: string;
}

/** Where a probe looks: a point, a window, or (neither) the foreground. */
export interface InputTarget {
  x?: number;
  y?: number;
  windowId?: string;
}
