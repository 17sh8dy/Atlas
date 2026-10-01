/**
 * Phrasings for the file tools: zip, unzip, duplicates, what changed,
 * hide/read-only, copy a path.
 *
 * The target stays as the words that were said ("downloads", "notes.txt in
 * documents"); `locate.ts` turns it into a path at run time, where it can look
 * at the machine. Every rule here is `pathSafe`, since the target may itself be
 * a full path ("zip C:\Users\me\Reports").
 */

import type { GrammarRule } from './grammar';
import { plan, step } from './grammar';

function tidy(s: string): string {
  return s
    .trim()
    .replace(/[?.!]+$/g, '')
    .replace(/^["'“‘]|["'”’]$/g, '')
    .trim();
}

/** "today" / "this week" / "in the last 3 hours" / "yesterday" → hours. */
function spanHours(text: string): { hours: number; rest: string } {
  let hours = 24;
  let rest = text;
  const last = /\s+(?:in|over|during)?\s*(?:the\s+)?(?:last|past)\s+(\d+)\s*(hours?|hrs?|days?|weeks?)\s*$/i.exec(rest);
  if (last) {
    const n = Number(last[1]);
    const u = last[2]!.toLowerCase();
    hours = /^d/.test(u) ? n * 24 : /^w/.test(u) ? n * 168 : n;
    rest = rest.slice(0, last.index);
  } else if (/\s+this\s+week\s*$/i.test(rest)) {
    hours = 168;
    rest = rest.replace(/\s+this\s+week\s*$/i, '');
  } else if (/\s+this\s+month\s*$/i.test(rest)) {
    hours = 720;
    rest = rest.replace(/\s+this\s+month\s*$/i, '');
  } else if (/\s+yesterday\s*$/i.test(rest)) {
    hours = 48;
    rest = rest.replace(/\s+yesterday\s*$/i, '');
  } else if (/\s+(?:today|recently|lately)\s*$/i.test(rest)) {
    rest = rest.replace(/\s+(?:today|recently|lately)\s*$/i, '');
  }
  return { hours, rest };
}

/** Looks like a file or folder name, not a phrase: has an extension, or says "file"/"folder". */
const FILE_LIKE = /\.[a-z0-9]{1,5}\b|\b(?:file|folder|directory)\b/i;

export function createFileGrammar(): GrammarRule[] {
  return [
    {
      name: 'filesZip',
      order: -10.8,
      pathSafe: true,
      test(_lower, raw) {
        const m =
          raw.match(/^\s*(?:please\s+)?(?:zip(?:\s+up)?|compress|archive)\s+(?:up\s+)?(?:the\s+|my\s+)?([\s\S]+?)\s*[?.!]*$/i) ??
          raw.match(/^\s*(?:please\s+)?(?:make|create)\s+(?:a\s+)?zip\s+(?:file\s+)?(?:of|from|for)\s+(?:the\s+|my\s+)?([\s\S]+?)\s*[?.!]*$/i);
        if (!m) return null;
        const target = tidy(m[1]!);
        // "zip code", "zip it" — not something to compress.
        if (!target || /^(?:code|codes|it|them|that|this)$/i.test(target)) return null;
        return plan(step('files.zip', { target }), 'zip');
      },
    },

    {
      name: 'filesUnzip',
      order: -10.79,
      pathSafe: true,
      test(_lower, raw) {
        const m = raw.match(
          /^\s*(?:please\s+)?(?:unzip|decompress|unpack|un-zip|extract|open\s+up)\s+(?:the\s+|my\s+)?([\s\S]+?)\s*[?.!]*$/i,
        );
        if (!m) return null;
        const target = tidy(m[1]!);
        if (!target) return null;
        // "extract" and "open up" are everyday words: only an archive is meant here.
        const verb = raw.trim().split(/\s+/)[0]!.toLowerCase();
        const archive = /\.zip\b|\bzip\b|\barchive\b/i.test(target);
        if (/^(?:extract|open)$/.test(verb) && !archive) return null;
        return plan(step('files.unzip', { target }), 'unzip');
      },
    },

    {
      name: 'filesDuplicates',
      order: -10.78,
      pathSafe: true,
      questionSafe: ['duplicates'],
      test(_lower, raw) {
        const m = raw.match(
          /^\s*(?:please\s+)?(?:(?:find|show|list|look\s+for|check\s+for|are\s+there|is\s+there|do\s+i\s+have|any)\s+)?(?:me\s+)?(?:any\s+)?(?:all\s+)?(?:the\s+)?duplicate(?:s|d)?(?:\s+files?)?(?:\s+(?:in|on|under|inside|from)\s+(?:the\s+|my\s+)?([\s\S]+?))?\s*[?.!]*$/i,
        );
        if (!m) return null;
        return plan(step('files.duplicates', { target: m[1] ? tidy(m[1]) : 'downloads' }), 'duplicates');
      },
    },

    {
      name: 'filesRecent',
      order: -10.77,
      pathSafe: true,
      questionSafe: ['files-recent'],
      test(_lower, raw) {
        const m =
          raw.match(/^\s*(?:what|which\s+files?)\s+(?:has\s+|have\s+|did\s+)?(?:changed|changed|got\s+changed|was\s+changed|were\s+changed|i\s+change(?:d)?|new)\s+(?:in|on|inside|under)\s+(?:the\s+|my\s+)?([\s\S]+?)\s*[?.!]*$/i) ??
          raw.match(/^\s*(?:show|list)\s+(?:me\s+)?(?:the\s+)?(?:recent(?:ly)?\s+(?:changed|modified)|new(?:est)?)\s+files\s+(?:in|on)\s+(?:the\s+|my\s+)?([\s\S]+?)\s*[?.!]*$/i) ??
          raw.match(/^\s*(?:what(?:['’]?s|\s+is)\s+new)\s+(?:in|on)\s+(?:the\s+|my\s+)?([\s\S]+?)\s*[?.!]*$/i);
        if (!m) return null;
        const { hours, rest } = spanHours(tidy(m[1]!));
        const target = tidy(rest);
        if (!target) return null;
        return plan(step('files.recent', { target, hours }), 'files-recent');
      },
    },

    {
      name: 'filesAttributes',
      order: -10.76,
      pathSafe: true,
      questionSafe: ['file-attributes'],
      test(_lower, raw) {
        // The question: "is notes.txt hidden", "is budget.xlsx read only"
        const q = raw.match(/^\s*is\s+(?:the\s+|my\s+)?([\s\S]+?)\s+(?:hidden|read[\s-]?only|protected|editable)\s*\??\s*$/i);
        if (q && FILE_LIKE.test(q[1]!)) return plan(step('files.attributes', { target: tidy(q[1]!) }), 'file-attributes');

        const hide = raw.match(/^\s*(?:please\s+)?(hide|unhide)\s+(?:the\s+|my\s+)?([\s\S]+?)\s*[?.!]*$/i);
        // A bare "hide" is Atlas hiding itself; only something file-shaped is meant here.
        if (hide && (FILE_LIKE.test(hide[2]!) || /\s(?:in|on|from)\s+(?:the\s+|my\s+)?(?:downloads?|documents?|desktop|pictures|music|videos)\b/i.test(hide[2]!))) {
          return plan(
            step('files.attributes', { target: tidy(hide[2]!), hidden: hide[1]!.toLowerCase() === 'hide' }),
            'file-attributes',
          );
        }

        const ro = raw.match(/^\s*(?:please\s+)?make\s+(?:the\s+|my\s+)?([\s\S]+?)\s+(read[\s-]?only|protected|editable|writable|writeable)\s*[?.!]*$/i);
        if (ro) {
          return plan(
            step('files.attributes', {
              target: tidy(ro[1]!),
              readOnly: /read|protect/i.test(ro[2]!),
            }),
            'file-attributes',
          );
        }
        return null;
      },
    },

    {
      name: 'filesCompare',
      order: -10.755,
      pathSafe: true,
      questionSafe: ['files-compare'],
      test(_lower, raw) {
        // "compare notes.txt and notes backup.txt in documents" / "diff a.txt b.txt" / "are a.txt and b.txt the same"
        const m =
          raw.match(/^\s*(?:please\s+)?(?:compare|diff)\s+(?:the\s+(?:files?\s+)?)?(.+?)\s+(?:and|with|to|against|vs\.?)\s+(.+?)\s*[?.!]*$/i) ??
          raw.match(/^\s*(?:is|are)\s+(.+?)\s+(?:and|the\s+same\s+as|identical\s+to)\s+(.+?)\s+(?:the\s+same|identical|different|equal)\s*[?.!]*$/i);
        // "diff a.txt b.txt" — two file names and no joining word.
        const bare = m ? null : raw.match(/^\s*(?:please\s+)?(?:compare|diff)\s+(\S+\.[a-z0-9]{1,5})\s+(\S+\.[a-z0-9]{1,5})\s*[?.!]*$/i);
        if (!m && !bare) return null;
        const a = tidy((m ?? bare)![1]!);
        let b = tidy((m ?? bare)![2]!);
        // Both must look like files; "compare prices and quality" is not this.
        if (!FILE_LIKE.test(a) || !/\.[a-z0-9]{1,5}\b/i.test(b.replace(/\s+(?:in|on|from)\s+.+$/i, ''))) return null;
        // "A and B in documents": the place belongs to both.
        const place = /\s+(?:in|on|from)\s+(?:the\s+|my\s+)?(.+)$/i.exec(b);
        const args: Record<string, string> = { a };
        if (place) {
          b = b.replace(/\s+(?:in|on|from)\s+(?:the\s+|my\s+)?.+$/i, '');
          args.place = tidy(place[1]!);
          args.a = /\s(?:in|on|from)\s/i.test(a) ? a : `${a} in ${args.place}`;
        }
        args.b = b;
        return plan(step('files.compare', args), 'files-compare');
      },
    },

    {
      name: 'filesSearchInside',
      order: -10.754,
      pathSafe: true,
      test(_lower, raw) {
        const PLACE = String.raw`(?:(?:the\s+|my\s+)?(?:documents?|downloads?|desktop|pictures|music|videos|home)(?:\s+folder)?|(?:[a-z]:[\/]|\\)\S+)`;
        const m =
          new RegExp(String.raw`^\s*(?:please\s+)?(?:search|look|grep)\s+(?:(?:inside|within|through|in)\s+)?(${PLACE})\s+for\s+(.+?)\s*[?.!]*$`, 'i').exec(raw) ??
          // "find X in documents" is a search for a file called X; only "inside"/"within"
          // (or a quoted phrase) means the contents of the files.
          new RegExp(String.raw`^\s*(?:please\s+)?(?:find|search\s+for|look\s+for|grep)\s+(.+?)\s+(?:inside|within)\s+(${PLACE})\s*[?.!]*$`, 'i').exec(raw) ??
          new RegExp(String.raw`^\s*(?:please\s+)?(?:find|search\s+for|look\s+for|grep)\s+(["“'‘].+?["”'’])\s+in\s+(${PLACE})\s*[?.!]*$`, 'i').exec(raw);
        if (!m) return null;
        const swapped = /^\s*(?:please\s+)?(?:find|search\s+for|look\s+for|grep)/i.test(raw);
        const where = tidy(swapped ? m[2]! : m[1]!);
        const query = tidy(swapped ? m[1]! : m[2]!);
        if (!query || !where) return null;
        return plan(step('code.search', { path: where, query }), 'search-inside');
      },
    },

    {
      name: 'filesCopyPath',
      order: -10.75,
      pathSafe: true,
      test(_lower, raw) {
        const m =
          raw.match(/^\s*(?:please\s+)?copy\s+(?:the\s+)?(?:full\s+)?path\s+(?:of|to|for)\s+(?:the\s+|my\s+)?([\s\S]+?)\s*[?.!]*$/i) ??
          raw.match(/^\s*(?:please\s+)?copy\s+([\s\S]+?)['’]s\s+path\s*[?.!]*$/i);
        if (!m) return null;
        return plan(step('files.copyPath', { target: tidy(m[1]!) }), 'copy-path');
      },
    },
  ];
}
