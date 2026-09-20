/**
 * What to ask when an action is missing a detail — the questions, in words a
 * person would use, and how to turn the answer into what the action needs.
 *
 * ── Why this is a table and not a hook on every skill ───────────────────────
 * 100-odd actions need at least one detail to run. The *mechanism* for asking
 * is general (`planner/clarify.ts`) and works for all of them with nothing
 * here — an absent required detail always produces a question. This table only
 * makes the questions good: "How long should the timer run?" instead of "I
 * need one more detail: what is seconds?", and it knows that a file path must
 * be a full path, that "10 minutes" means 600 seconds, that "youtube" is a
 * website. One place to read and to fix, instead of a hundred.
 *
 * Keys are `skillId.param`. An action with no entry still asks, in a plain
 * default wording.
 */

import { resolveSite } from '../text/sites';
import { readFolderInPlace } from '../planner/core-grammar';

export interface ParamAsk {
  /** The question. */
  question: string;
  /** What kind of thing is wanted, singular. Used in the option labels. */
  noun?: string;
  /** Wording for the "type it" option, when the default would read badly. */
  tellLabel?: string;
  /** Hint inside the input. */
  placeholder?: string;
  /** May several be given? Default no: most details are one thing. */
  many?: boolean;
  /** Turn the typed answer into what the action needs, or `null` if unusable. */
  normalize?: (text: string) => string | null;
  /** Said when `normalize` refuses, so the person knows what is wanted. */
  hint?: string;
  /** For a fixed set of answers: readable labels by value. Missing ones are made readable. */
  labels?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// turning answers into values
// ---------------------------------------------------------------------------

const ABSOLUTE = /^(?:[a-z]:[\\/]|\\\\|~?\/)/i;

const unquote = (s: string) =>
  s
    .trim()
    .replace(/^["'“‘]+|["'”’]+$/g, '')
    .trim();

/** A full path, or nothing: a bare name would be resolved against wherever Atlas happens to be. */
export function fullPath(text: string): string | null {
  const t = unquote(text);
  return ABSOLUTE.test(t) ? t : null;
}

/** "D:\Dev\Notes", or "Notes in D:\Dev" — either way, one full path. */
export function pathOrNameInPlace(text: string): string | null {
  const direct = fullPath(text);
  if (direct) return direct;
  return readFolderInPlace(`create a folder called ${unquote(text)}`);
}

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
  m: 60,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  h: 3600,
  hr: 3600,
  hrs: 3600,
  hour: 3600,
  hours: 3600,
};

const WORD_NUMBERS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  sixty: 60,
};

/** "10 minutes", "90 sec", "1h 30m", "half an hour", "5" (minutes) → seconds as a string. */
export function durationSeconds(text: string): string | null {
  const t = unquote(text)
    .toLowerCase()
    .replace(/^for\s+/, '');
  if (!t) return null;
  if (/^half\s+an?\s+hour$/.test(t)) return '1800';
  if (/^(?:a\s+)?quarter\s+(?:of\s+an?\s+)?hour$/.test(t)) return '900';

  // 1:30 → minutes:seconds
  const clock = /^(\d{1,3}):([0-5]\d)$/.exec(t);
  if (clock) return String(Number(clock[1]) * 60 + Number(clock[2]));

  let total = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?|[a-z]+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|[smh])\b/g;
  for (const m of t.matchAll(re)) {
    const raw = m[1]!;
    const n = /^\d/.test(raw) ? Number(raw) : WORD_NUMBERS[raw];
    const unit = UNIT_SECONDS[m[2]!];
    if (n === undefined || unit === undefined) return null;
    total += n * unit;
    matched = true;
  }
  if (!matched) {
    // a bare number is minutes: the way nearly everyone means "a 5 timer"
    if (/^\d+(?:\.\d+)?$/.test(t)) total = Number(t) * 60;
    else return null;
  }
  const seconds = Math.round(total);
  return seconds > 0 && seconds <= 24 * 3600 ? String(seconds) : null;
}

/** "youtube" → its address; "example.com" → https://example.com; a full address stays. */
export function websiteAddress(text: string): string | null {
  const t = unquote(text);
  if (!t) return null;
  if (/^https?:\/\/\S+$/i.test(t)) return t;
  const site = resolveSite(t);
  if (site) return site.url;
  if (/^[\w-]+(?:\.[\w-]+)+(?:\/\S*)?$/.test(t)) return `https://${t}`;
  return null;
}

const anything = (text: string) => unquote(text) || null;

// ---------------------------------------------------------------------------
// the questions
// ---------------------------------------------------------------------------

const FULL_PATH_HINT = 'I need a full path, like D:\\Docs\\report.docx.';
const WHERE_HINT =
  'Give me a full path (D:\\Dev\\Notes), or a name and a place (Notes in D:\\Dev).';

const which = (question: string, extra: Partial<ParamAsk> = {}): ParamAsk => ({
  question,
  ...extra,
});

export const ASKS: Record<string, ParamAsk> = {
  // ---- files -------------------------------------------------------------
  'files.createFolder.path': {
    question: 'Where should I create the folder, and what should it be called?',
    noun: 'folder',
    tellLabel: 'Tell me the name and where',
    placeholder: 'Notes in D:\\Dev   or   D:\\Dev\\Notes',
    normalize: pathOrNameInPlace,
    hint: WHERE_HINT,
  },
  'files.create.path': {
    question: 'What should the file be called, and where should it go?',
    noun: 'file',
    tellLabel: 'Tell me the name and where',
    placeholder: 'notes.txt in D:\\Dev   or   D:\\Dev\\notes.txt',
    normalize: pathOrNameInPlace,
    hint: WHERE_HINT,
  },
  'files.find.query': which('What is the file called? Part of the name is enough.', {
    noun: 'file',
    tellLabel: 'Tell me the name',
    placeholder: 'part of the file name',
    normalize: anything,
  }),
  'files.delete.path': which('Which file should I delete?', {
    noun: 'file',
    tellLabel: 'Tell me which file',
    placeholder: 'D:\\Docs\\old-notes.txt',
    normalize: fullPath,
    hint: FULL_PATH_HINT,
  }),
  'files.rename.path': which('Which file should I rename?', {
    noun: 'file',
    tellLabel: 'Tell me which file',
    placeholder: 'D:\\Docs\\notes.txt',
    normalize: fullPath,
    hint: FULL_PATH_HINT,
  }),
  'files.rename.newName': which('What should it be called?', {
    noun: 'name',
    tellLabel: 'Tell me the new name',
    placeholder: 'new name',
    normalize: anything,
  }),
  'files.move.path': which('Which file should I move?', {
    noun: 'file',
    tellLabel: 'Tell me which file',
    placeholder: 'D:\\Docs\\notes.txt',
    normalize: fullPath,
    hint: FULL_PATH_HINT,
  }),
  'files.move.destDir': which('Which folder should it go in?', {
    noun: 'folder',
    tellLabel: 'Tell me which folder',
    placeholder: 'D:\\Archive',
    normalize: fullPath,
    hint: 'I need a full folder path, like D:\\Archive.',
  }),
  'files.copy.path': which('Which file should I copy?', {
    noun: 'file',
    tellLabel: 'Tell me which file',
    placeholder: 'D:\\Docs\\notes.txt',
    normalize: fullPath,
    hint: FULL_PATH_HINT,
  }),
  'files.copy.destDir': which('Which folder should the copy go in?', {
    noun: 'folder',
    tellLabel: 'Tell me which folder',
    placeholder: 'D:\\Backup',
    normalize: fullPath,
    hint: 'I need a full folder path, like D:\\Backup.',
  }),
  'files.open.path': which('Which file or folder should I open?', {
    noun: 'file',
    tellLabel: 'Tell me which one',
    placeholder: 'D:\\Docs\\report.docx',
    normalize: fullPath,
    hint: FULL_PATH_HINT,
  }),

  // ---- notes, reminders, timers -------------------------------------------
  'notes.add.text': which('What should the note say?', {
    noun: 'note',
    tellLabel: 'Tell me what to write',
    placeholder: 'the note',
    normalize: anything,
  }),
  'todo.add.text': which('What should I remind you about?', {
    noun: 'reminder',
    tellLabel: 'Tell me what to remember',
    placeholder: 'e.g. call mom',
    normalize: anything,
  }),
  'time.timer.seconds': which('How long should the timer run?', {
    noun: 'time',
    tellLabel: 'Tell me how long',
    placeholder: 'e.g. 10 minutes',
    normalize: durationSeconds,
    hint: 'Try a length of time, like 10 minutes or 90 seconds.',
  }),

  // ---- the web -------------------------------------------------------------
  'web.search.query': which('What should I search for?', {
    noun: 'search',
    tellLabel: 'Tell me what to search for',
    placeholder: 'what to search for',
    normalize: anything,
  }),
  'web.searchYoutube.query': which('What would you like to play or watch?', {
    noun: 'video',
    tellLabel: 'Tell me what to look for',
    placeholder: 'a song, an artist, a video',
    normalize: anything,
  }),
  'web.searchImages.query': which('What pictures should I look for?', { normalize: anything }),
  'web.searchMaps.place': which('Which place?', { noun: 'place', normalize: anything }),
  'web.searchWikipedia.query': which('What should I look up?', { normalize: anything }),
  'web.open.url': which('Which website?', {
    noun: 'website',
    tellLabel: 'Tell me which website',
    placeholder: 'e.g. youtube, or example.com',
    normalize: websiteAddress,
    hint: 'Tell me a website’s name (like YouTube) or its address (like example.com).',
  }),
  'research.search.query': which('What should I look into?', { normalize: anything }),

  // ---- windows -------------------------------------------------------------
  ...Object.fromEntries(
    ['focus', 'minimize', 'maximize', 'restore', 'move', 'close'].map((verb) => [
      `window.${verb}.name`,
      which('Which window? Part of its title is enough.', {
        noun: 'window',
        tellLabel: 'Tell me which window',
        placeholder: 'e.g. Notepad',
        normalize: anything,
      }),
    ]),
  ),

  // ---- typing and keys -----------------------------------------------------
  'input.typeText.text': which('What should I type?', {
    noun: 'text',
    tellLabel: 'Tell me what to type',
    placeholder: 'the text',
    normalize: anything,
  }),
  'input.pressKey.key': which('Which key should I press?', {
    placeholder: 'e.g. Enter',
    normalize: anything,
  }),
  'input.hotkey.combo': which('Which shortcut?', {
    placeholder: 'e.g. Ctrl+S',
    normalize: anything,
  }),

  // ---- the machine ---------------------------------------------------------
  'system.volume.direction': which('Turn the volume up or down?'),
  'system.power.action': which('What should I do?', {
    labels: { shutdown: 'Shut down', restart: 'Restart', 'sign-out': 'Sign out' },
  }),
  'system.openTool.tool': which('Which tool would you like to open?', {
    labels: {
      'task-manager': 'Task Manager',
      'device-manager': 'Device Manager',
      'windows-settings': 'Windows Settings',
      'control-panel': 'Control Panel',
      'file-explorer': 'File Explorer',
      'this-pc': 'This PC',
      'recycle-bin': 'Recycle Bin',
    },
  }),
  'files.openKnown.folder': which('Which folder?'),
  'service.status.name': which('Which service?', { noun: 'service', normalize: anything }),
  'service.start.name': which('Which service should I start?', {
    noun: 'service',
    normalize: anything,
  }),
  'service.stop.name': which('Which service should I stop?', {
    noun: 'service',
    normalize: anything,
  }),
  'service.restart.name': which('Which service should I restart?', {
    noun: 'service',
    normalize: anything,
  }),
  'system.endProcess.process': which('Which program should I close?', {
    noun: 'program',
    normalize: anything,
  }),
  'notify.send.message': which('What should the notification say?', { normalize: anything }),
  'clipboard.copy.text': which('What should I copy?', { normalize: anything }),
};

export function askFor(skillId: string, param: string): ParamAsk | undefined {
  return ASKS[`${skillId}.${param}`];
}

/** `task-manager` → `Task manager`, for an option nobody wrote a label for. */
export function readable(value: string): string {
  const spaced = value.replace(/[-_]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
