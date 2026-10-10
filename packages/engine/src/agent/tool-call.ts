/**
 * Reading a model's one-step reply, whatever shape it chose.
 *
 * Atlas asks for `{"skill": "...", "args": {...}}` or `{"done": true, "summary": "..."}`. Models do not all
 * obey: some wrap it in a ```json fence, some say a sentence first, some use the names of their native
 * function-calling formats (`name` / `tool` / `function` with `arguments` / `parameters` / `input`), some
 * send the arguments as a JSON *string*, some send two objects, some are cut off mid-object. All of that is
 * normalised HERE, deterministically, into one internal shape — and nothing is guessed: a reply that cannot
 * be read as exactly one clear action is reported as what it is, so the loop can ask again or stop.
 *
 * The model's words about what it did are never evidence that it did it; only the executor's result is.
 */

export interface ParsedAction {
  done?: boolean;
  summary?: string;
  say?: string;
  skill?: string;
  args?: Record<string, unknown>;
}

export type ToolCallParse =
  | { kind: 'action'; action: ParsedAction; notes: string[] }
  | { kind: 'invalid'; reason: 'empty' | 'no-json' | 'truncated' | 'not-an-action' | 'bad-arguments'; detail: string };

/** Every top-level `{...}` object in the text that parses, in order. Braces inside strings do not count. */
export function jsonObjectsIn(text: string): Array<{ value: unknown; start: number; end: number }> {
  const out: Array<{ value: unknown; start: number; end: number }> = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j += 1) {
      const c = text[j]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            out.push({ value: JSON.parse(text.slice(i, j + 1)), start: i, end: j + 1 });
            i = j;
          } catch {
            /* not JSON: keep scanning from the next character */
          }
          break;
        }
      }
    }
  }
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The tool name, from whichever key this model uses. */
function nameOf(o: Record<string, unknown>): string | undefined {
  for (const k of ['skill', 'tool', 'tool_name', 'name', 'action', 'function_name']) {
    if (typeof o[k] === 'string' && (o[k] as string).trim()) return (o[k] as string).trim();
  }
  return undefined;
}

function argsOf(o: Record<string, unknown>): { ok: true; args: Record<string, unknown> } | { ok: false; detail: string } {
  for (const k of ['args', 'arguments', 'parameters', 'params', 'input']) {
    if (!(k in o)) continue;
    const v = o[k];
    if (v === null || v === undefined || v === '') return { ok: true, args: {} };
    if (isRecord(v)) return { ok: true, args: v };
    if (typeof v === 'string') {
      try {
        const parsed = JSON.parse(v) as unknown;
        if (isRecord(parsed)) return { ok: true, args: parsed };
      } catch {
        /* fall through */
      }
      return { ok: false, detail: `the arguments were a string that is not a JSON object` };
    }
    return { ok: false, detail: 'the arguments were not an object' };
  }
  return { ok: true, args: {} };
}

/** Unwrap the shapes native function-calling formats use. */
function unwrap(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  // { "function": { "name": "...", "arguments": ... } }  and  { "tool_calls": [ { "function": {...} } ] }
  if (isRecord(value.function)) return { ...value.function, say: value.say };
  if (Array.isArray(value.tool_calls) && isRecord(value.tool_calls[0])) return unwrap(value.tool_calls[0]);
  if (Array.isArray(value.tool_calls) && value.tool_calls.length === 0) return value;
  if (isRecord(value.tool_call)) return unwrap(value.tool_call);
  if (isRecord(value.action) && !('skill' in value) && !('done' in value)) return { ...value.action, say: value.say };
  return value;
}

/**
 * The one closing `}` / `]` a reply is missing, or null if it is balanced, has stray closers, stops
 * inside a string (genuinely cut off) or is missing more than the outermost closer.
 */
function missingClosers(text: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const c of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') {
      if (stack.pop() !== c) return null;
    }
  }
  if (inString || stack.length !== 1) return null;
  // Exactly the outermost brace is missing and the value before it is a closed object or list: the
  // reply is complete, the model just forgot the last `}`. Anything that stops deeper, or in the
  // middle of a value, is a cut-off reply and is reported as one.
  if (!/[}\]]\s*$/.test(text)) return null;
  return stack[0]!;
}

export function parseToolCall(reply: string | null | undefined): ToolCallParse {
  const text = String(reply ?? '').trim();
  if (!text) return { kind: 'invalid', reason: 'empty', detail: 'the reply was empty' };

  const notes: string[] = [];
  let body = text;
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(text);
  if (fence) {
    body = fence[1]!;
    notes.push('code fence removed');
  }

  let found = jsonObjectsIn(body);

  // A small model often forgets the closing brace of the OUTER object ({"skill":…,"args":{…}  — one
  // `}` for args and none for the action). Left alone, the scan above finds only the inner `args`
  // object and the reply is thrown away as "not an action". If the text is complete up to those
  // missing closers (not cut off mid-string), put them back and read it as what was meant.
  const opened = body.indexOf('{');
  if (opened >= 0 && !found.some((f) => f.start <= opened)) {
    const closers = missingClosers(body.slice(opened));
    if (closers) {
      const repaired = jsonObjectsIn(body.slice(opened) + closers);
      if (repaired.length && repaired[0]!.start === 0) {
        found = repaired;
        notes.push('missing closing brace added');
      }
    }
  }

  if (!found.length) {
    // A reply that opens an object and never closes it is a cut-off reply, not an absent one.
    return opened >= 0
      ? { kind: 'invalid', reason: 'truncated', detail: 'the reply stopped in the middle of the JSON' }
      : { kind: 'invalid', reason: 'no-json', detail: 'there was no JSON action in the reply' };
  }

  // The first object that reads as an action; extra objects are ignored but noted — one step at a time.
  let chosen: Record<string, unknown> | null = null;
  for (const f of found) {
    const u = unwrap(f.value);
    if (u && (u.done === true || nameOf(u))) {
      chosen = u;
      break;
    }
  }
  if (!chosen) return { kind: 'invalid', reason: 'not-an-action', detail: 'the JSON was neither a {"done":true} nor a {"skill":…} action' };
  if (found.length > 1) notes.push('only the first action was used');

  const say = typeof chosen.say === 'string' ? chosen.say : undefined;
  if (chosen.done === true) {
    const summary = typeof chosen.summary === 'string' ? chosen.summary : typeof chosen.message === 'string' ? chosen.message : undefined;
    return { kind: 'action', action: { done: true, summary, say }, notes };
  }
  const skill = nameOf(chosen)!;
  const args = argsOf(chosen);
  if (!args.ok) return { kind: 'invalid', reason: 'bad-arguments', detail: args.detail };
  return { kind: 'action', action: { skill, args: args.args, say }, notes };
}
