/**
 * An approval is for one exact operation: this skill, with these arguments, aimed at these targets.
 *
 * The executor takes a seal of a step before anything is asked or previewed, and checks it again immediately
 * before the step runs. Between those two moments sit the confirmation card, a preview, an assessment and,
 * in the agent loops, a model's reply being parsed: all of them places where something could, by mistake or by
 * design, change the step that was shown. If the seal no longer matches, the step is NOT run and the person is
 * told to ask again. A "yes" cannot be carried over to different details.
 *
 * Canonical on purpose: key order and number formatting do not matter, nested values do, and two different
 * argument sets can never share a seal by accident of how they were written down.
 */

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`;
}

/** Two independent 32-bit FNV-1a passes over the canonical text, plus its length. Not a secret; a tripwire. */
export function operationSeal(skillId: string, args: unknown): string {
  const text = `${skillId}\u0000${canonical(args ?? {})}`;
  let a = 2166136261;
  let b = 5381;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619) >>> 0;
    b = (Math.imul(b, 33) ^ c) >>> 0;
  }
  return `op:${text.length}:${a.toString(16)}${b.toString(16)}`;
}
