/**
 * Reading what a setup should do from plain words.
 *
 * "open OBS and Discord, close Chrome, put Discord on the left, check my mic is
 * the MV7, make sure D: has 50 GB free" → five `SetupItem`s. Used for the
 * inline form ("get my PC ready for streaming: open OBS…"), for the answers to
 * the guided questions, and by Settings when someone types an item.
 *
 * Deterministic and closed: each clause either becomes one of the six item
 * kinds or is reported back as not understood. Nothing here is ever turned
 * into a free-form action.
 */

import type { SetupItem, WindowPosition } from '@atlas/core';

export interface ParsedSpec {
  items: SetupItem[];
  /** Clauses that matched nothing, so the caller can say which. */
  unknown: string[];
}

const POSITION_WORDS: Array<[RegExp, WindowPosition]> = [
  [/^(?:top|upper)[\s-]?left$/, 'top-left'],
  [/^(?:top|upper)[\s-]?right$/, 'top-right'],
  [/^(?:bottom|lower)[\s-]?left$/, 'bottom-left'],
  [/^(?:bottom|lower)[\s-]?right$/, 'bottom-right'],
  [/^left$/, 'left'],
  [/^right$/, 'right'],
  [/^(?:top|upper)$/, 'top'],
  [/^(?:bottom|lower)$/, 'bottom'],
  [/^(?:cent(?:er|re)|middle)$/, 'center'],
  [/^(?:max(?:imi[sz]ed?)?|full ?screen|full)$/, 'maximize'],
];

/** "the top right corner" → `top-right`. */
export function readPosition(text: string): WindowPosition | null {
  const t = text
    .toLowerCase()
    .trim()
    .replace(/^(?:the|a)\s+/, '')
    .replace(/\s+(?:half|side|corner|quarter|of the screen|of my screen|part)$/, '')
    .replace(/\s+(?:half|side|corner)$/, '')
    .trim();
  for (const [pattern, position] of POSITION_WORDS) if (pattern.test(t)) return position;
  return null;
}

/** "OBS, Discord and Spotify" → three names. */
export function splitNames(text: string): string[] {
  return text
    .split(/\s*(?:,|\band\b|&|\bplus\b)\s*/i)
    .map((s) =>
      s
        .trim()
        .replace(/^(?:the|my)\s+/i, '')
        .replace(/\s+(?:app|application|program)$/i, '')
        .replace(/[.!]+$/, '')
        .trim(),
    )
    .filter((s) => s && !/^(?:nothing|none|no|nope|n\/a)$/i.test(s));
}

/** "D:", "drive d", "the D drive" → "D:". */
function readDrive(text: string): string | null {
  const m =
    /\b([a-z]):(?:\\|\/)?(?=\s|$|,)/i.exec(text) ??
    /\bdrive\s+([a-z])\b/i.exec(text) ??
    /\b(?:the\s+)?([a-z])\s+drive\b/i.exec(text);
  return m ? `${m[1]!.toUpperCase()}:` : null;
}

function readGb(text: string): number | null {
  const m = /(\d+(?:\.\d+)?)\s*(tb|t|gb|gigs?|g|gib)\b/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return /^t/i.test(m[2]!) ? n * 1024 : n;
}

/**
 * One clause → items. Returns [] when the clause matched nothing (the caller
 * records it as unknown).
 */
export function readClause(clause: string): SetupItem[] {
  const c = clause
    .trim()
    .replace(/[.!]+$/, '')
    .replace(/^(?:and|then|also|please)\s+/i, '')
    .trim();
  if (!c) return [];
  const lower = c.toLowerCase();

  const open = /^(?:open|launch|start|run|load|boot up|fire up)\s+(?:up\s+)?(.+)$/i.exec(c);
  if (open) return splitNames(open[1]!).map((app) => ({ kind: 'open', app }));

  const close = /^(?:close|quit|exit|kill|end|shut down|shut)\s+(?:down\s+)?(.+)$/i.exec(c);
  if (close) return splitNames(close[1]!).map((app) => ({ kind: 'close', app }));

  const place =
    /^(?:put|move|place|snap|dock|send)\s+(.+?)\s+(?:on|to|in|at|into)\s+(.+?)(?:\s+(?:of|on)\s+(?:display|monitor|screen)\s+(\d))?$/i.exec(
      c,
    ) ??
    /^(.+?)\s+(?:on|to|in|at)\s+(?:the\s+)?(.+?)(?:\s+(?:of|on)\s+(?:display|monitor|screen)\s+(\d))?$/i.exec(
      c,
    );
  if (place) {
    const position = readPosition(place[2]!);
    if (position) {
      const display = place[3] ? Number(place[3]) : undefined;
      return splitNames(place[1]!).map((app) =>
        display ? { kind: 'place', app, position, display } : { kind: 'place', app, position },
      );
    }
  }
  const maximize = /^(?:maximi[sz]e|full ?screen)\s+(.+)$/i.exec(c);
  if (maximize)
    return splitNames(maximize[1]!).map((app) => ({ kind: 'place', app, position: 'maximize' }));

  if (/\b(?:mic|microphone)\b/.test(lower)) {
    const expect =
      /\b(?:mic|microphone)\s+(?:is|should be|=|to be|set to)\s+(?:my\s+|the\s+)?(.+)$/i.exec(c);
    return [expect ? { kind: 'mic', expect: expect[1]!.trim() } : { kind: 'mic' }];
  }

  if (/\b(?:space|storage|free|room|disk|drive)\b/.test(lower) && (readDrive(c) || readGb(c))) {
    return [{ kind: 'storage', drive: readDrive(c) ?? 'C:', minGb: readGb(c) ?? 20 }];
  }

  if (/\b(?:internet|online|network|wi-?fi|connection)\b/.test(lower)) return [{ kind: 'online' }];

  return [];
}

/** A whole spec: clauses split on commas, semicolons, new lines and "then". */
export function parseSpec(text: string): ParsedSpec {
  const clauses = text
    .split(/\s*(?:[;\n]|\band then\b|\bthen\b)\s*/i)
    .flatMap((part) => splitVerbs(part))
    .map((s) => s.trim())
    .filter(Boolean);
  const items: SetupItem[] = [];
  const unknown: string[] = [];
  for (const clause of clauses) {
    const read = readClause(clause);
    if (read.length) items.push(...read);
    else unknown.push(clause);
  }
  return { items: dedupe(items), unknown };
}

/**
 * "open OBS, Discord, close Chrome" — a comma can separate two names *or* two
 * instructions. Split only where the next piece starts with a verb of its own
 * (or is a placement / check), so "OBS, Discord" stays one list.
 */
const OWN_CLAUSE =
  /^(?:and\s+)?(?:open|launch|start|run|load|close|quit|exit|kill|end|shut|put|move|place|snap|dock|send|maximi[sz]e|check|make sure|ensure|verify|confirm|at least)\b/i;

function splitVerbs(part: string): string[] {
  const pieces = part
    .split(
      /\s+and\s+(?=(?:open|launch|start|run|close|quit|exit|kill|put|move|place|snap|maximi[sz]e|check|make sure|ensure|verify)\b)/i,
    )
    .flatMap((p) => p.split(/\s*,\s*/));
  const out: string[] = [];
  for (const piece of pieces) {
    // A piece that opens with some other verb is an instruction too — one this
    // parser may not understand, which is exactly why it must not be swallowed
    // into the previous list as an app called "make me a sandwich".
    const own =
      OWN_CLAUSE.test(piece) ||
      /^(?:make|get|set|turn|do|play|go|find|show|tell|give|take|buy|order|write|call|delete|remove|install|download)\b/i.test(
        piece,
      ) ||
      piece.trim().split(/\s+/).length > 4 ||
      /\b(?:mic|microphone|internet|online|space|free)\b/i.test(piece) ||
      /\s(?:on|to)\s+the\s+(?:left|right|top|bottom|middle|cent(?:er|re))/i.test(piece);
    if (!out.length || own) out.push(piece.replace(/^and\s+/i, ''));
    else out[out.length - 1] = `${out[out.length - 1]}, ${piece}`;
  }
  return out;
}

function dedupe(items: SetupItem[]): SetupItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = JSON.stringify(item).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** An item in words, for cards, reports and Settings. */
export function describeItem(item: SetupItem): string {
  switch (item.kind) {
    case 'open':
      return `Open ${item.app}`;
    case 'close':
      return `Close ${item.app}`;
    case 'mic':
      return item.expect
        ? `Check the microphone is ${item.expect}`
        : 'Check which microphone is in use';
    case 'storage':
      return `At least ${item.minGb} GB free on ${item.drive}`;
    case 'place':
      return `${item.app.charAt(0).toUpperCase()}${item.app.slice(1)} ${placeWords(item.position)}${item.display ? ` of display ${item.display}` : ''}`;
    case 'online':
      return 'Check the internet is working';
  }
}

function placeWords(position: WindowPosition): string {
  switch (position) {
    case 'maximize':
      return 'maximized';
    case 'center':
      return 'in the centre';
    case 'left':
    case 'right':
    case 'top':
    case 'bottom':
      return `on the ${position}`;
    default:
      return `in the ${position} corner`;
  }
}

/**
 * The name a person gives a setup → the key it is stored under.
 * "my Recording" → "recording"; "to stream" → "streaming".
 */
export function setupKey(name: string): string {
  let n = name
    .toLowerCase()
    .trim()
    .replace(/[.!?]+$/, '')
    .replace(/^(?:my|a|the|some|me|us)\s+/, '')
    .replace(/\s+(?:setup|set up|routine|mode|session|time)$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const to = /^to\s+(\w+)(.*)$/.exec(n);
  if (to) n = `${gerund(to[1]!)}${to[2]}`;
  return n;
}

function gerund(verb: string): string {
  if (verb.endsWith('ing')) return verb;
  if (/[^aeiou]e$/.test(verb)) return `${verb.slice(0, -1)}ing`;
  return `${verb}ing`;
}
