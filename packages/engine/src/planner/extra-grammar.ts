/**
 * Phrasings for the second half of the catalog: text and encoding, the
 * calculators, notes and to-dos, and the native OS controls.
 *
 * A separate module rather than more of `core-grammar.ts`, because rules are
 * registered, not edited in — the same reason a new domain never has to touch
 * `grammar.ts`. Ordering still matters across files, so every rule here carries
 * an explicit `order` and the ones that could be mistaken for an existing rule
 * say what they are ducking under or over.
 *
 * Most of these want a quoted argument. That is deliberate: "uppercase my
 * report" is about a file, "uppercase “my report”" is about those two words,
 * and the quotes are the only honest way to tell them apart without guessing.
 */

import type { GrammarRule } from './grammar';
import { plan, step } from './grammar';

function stripQuotes(s: string): string {
  return s.trim().replace(/^["'“‘]|["'”’]$/g, '');
}

/** Was the captured text actually quoted? */
function quoted(raw: string): boolean {
  const t = raw.trim();
  return /^["'“‘]/.test(t) && /["'”’]$/.test(t);
}

export function createExtraGrammar(): GrammarRule[] {
  return [
    // ---- text -------------------------------------------------------------

    {
      name: 'textReplace',
      order: -7.12,
      test(_lower, raw) {
        const m = raw.match(
          /^\s*(?:in\s+)?(["'“].+?["'”])\s*,?\s*replace\s+(.+?)\s+with\s+(.*?)\s*[?.!]*$/i,
        );
        if (!m) return null;
        return plan(
          step('text.replace', {
            text: stripQuotes(m[1]!),
            find: stripQuotes(m[2]!),
            replace: stripQuotes(m[3] ?? ''),
          }),
          'replace',
        );
      },
    },

    {
      name: 'textLines',
      order: -7.11,
      test(_lower, raw) {
        const sorted = raw.match(
          /^\s*sort\s+(?:these\s+|the\s+)?lines?\s*:?\s*([\s\S]+?)\s*$/i,
        )?.[1];
        if (sorted) return plan(step('text.sortLines', { text: sorted }), 'sort-lines');

        const deduped = raw.match(
          /^\s*(?:remove|delete|drop)\s+(?:the\s+)?duplicate\s+lines?\s*:?\s*([\s\S]+?)\s*$/i,
        )?.[1];
        if (deduped) return plan(step('text.dedupe', { text: deduped }), 'dedupe');

        const tidied = raw.match(/^\s*(?:tidy|clean)\s+up\s*:?\s*([\s\S]+?)\s*$/i)?.[1];
        if (tidied) return plan(step('text.trim', { text: tidied }), 'tidy');
        return null;
      },
    },

    {
      name: 'textExtract',
      order: -7.1,
      test(_lower, raw) {
        const m = raw.match(
          /^\s*(?:extract|pull out|find)\s+(?:the\s+|all\s+(?:the\s+)?)?(emails?|e-mails?|links?|urls?|numbers?)\s+(?:from|in)\s+([\s\S]+?)\s*[?.!]*$/i,
        );
        if (!m) return null;
        const noun = String(m[1]).toLowerCase();
        const what = noun.startsWith('e') ? 'emails' : noun.startsWith('n') ? 'numbers' : 'links';
        return plan(step('text.extract', { text: stripQuotes(m[2]!), what }), 'extract');
      },
    },

    {
      name: 'textSlug',
      order: -7.09,
      test(_lower, raw) {
        const captured = raw.match(
          /^\s*(?:slugify|make a slug (?:of|for)|slug for)\s+([\s\S]+?)\s*[?.!]*$/i,
        )?.[1];
        if (!captured) return null;
        return plan(step('text.slug', { text: stripQuotes(captured) }), 'slug');
      },
    },

    {
      name: 'textFrequency',
      order: -7.08,
      questionSafe: ['frequency'],
      test(_lower, raw) {
        const captured = raw.match(
          /^\s*(?:what are the\s+)?most (?:common|used|frequent) words (?:in|of)\s+([\s\S]+?)\s*[?.!]*$/i,
        )?.[1];
        if (!captured || !quoted(captured)) return null;
        return plan(step('text.frequency', { text: stripQuotes(captured) }), 'frequency');
      },
    },

    {
      name: 'textLorem',
      order: -7.07,
      test(_lower, raw) {
        const m = raw.match(
          /^\s*(?:generate\s+|give me\s+)?lorem(?:\s+ipsum)?(?:\s+(\d+)\s*words?)?\s*[?.!]*$/i,
        );
        if (!m) return null;
        return plan(step('text.lorem', m[1] ? { words: Number(m[1]) } : {}), 'lorem');
      },
    },

    // ---- encoding ----------------------------------------------------------

    {
      name: 'utilUrlEncode',
      order: -7.06,
      test(_lower, raw) {
        const m = raw.match(/^\s*url\s*(encode|decode)\s+([\s\S]+?)\s*[?.!]*$/i);
        if (!m) return null;
        return plan(
          step('util.urlEncode', { text: stripQuotes(m[2]!), mode: String(m[1]).toLowerCase() }),
          'url-encode',
        );
      },
    },

    {
      name: 'utilHash',
      order: -7.05,
      test(_lower, raw) {
        const m = raw.match(
          /^\s*(?:the\s+)?(sha-?(?:1|256|384|512)|hash)\s+(?:of\s+|for\s+)?([\s\S]+?)\s*[?.!]*$/i,
        );
        if (!m) return null;
        const named = String(m[1]).toLowerCase().replace('sha', 'SHA-').replace('--', '-');
        const algorithm = named === 'hash' ? 'SHA-256' : named.toUpperCase();
        return plan(step('util.hash', { text: stripQuotes(m[2]!), algorithm }), 'hash');
      },
    },

    {
      name: 'utilHex',
      order: -7.04,
      questionSafe: ['base'],
      test(_lower, raw) {
        const m =
          raw.match(
            /^\s*(?:what(?:'s| is)\s+)?(0x[0-9a-f]+|0b[01]+|\d+)\s+in\s+(hex|hexadecimal|binary|decimal)\s*[?.!]*$/i,
          ) ??
          raw.match(
            /^\s*convert\s+(0x[0-9a-f]+|0b[01]+|\d+)\s+to\s+(hex|hexadecimal|binary|decimal)\s*[?.!]*$/i,
          );
        if (!m) return null;
        const to = String(m[2]).toLowerCase().startsWith('hex')
          ? 'hex'
          : String(m[2]).toLowerCase();
        return plan(step('util.hex', { value: m[1]!, to }), 'base');
      },
    },

    {
      name: 'utilJson',
      order: -7.03,
      test(_lower, raw) {
        const m = raw.match(
          /^\s*(format|pretty[- ]?print|minify|validate)\s+(?:this\s+|the\s+)?json\s*:?\s*([\s\S]+?)\s*$/i,
        );
        if (!m) return null;
        const verb = String(m[1]).toLowerCase();
        return plan(
          step('util.json', { text: m[2]!, mode: verb === 'minify' ? 'minify' : 'format' }),
          'json',
        );
      },
    },

    {
      name: 'utilJwt',
      order: -7.02,
      test(_lower, raw) {
        const captured = raw.match(
          /^\s*decode\s+(?:this\s+|the\s+)?jwt\s*:?\s*([\w-]+\.[\w-]+\.[\w-]*)\s*$/i,
        )?.[1];
        if (!captured) return null;
        return plan(step('util.jwt', { token: captured }), 'jwt');
      },
    },

    {
      name: 'utilRoman',
      order: -7.01,
      questionSafe: ['roman'],
      test(_lower, raw) {
        const toRoman = raw.match(
          /^\s*(?:what(?:'s| is)\s+)?(\d{1,4})\s+in\s+roman(?:\s+numerals)?\s*[?.!]*$/i,
        )?.[1];
        if (toRoman) return plan(step('util.roman', { value: toRoman }), 'roman');

        const fromRoman = raw.match(
          /^\s*(?:what(?:'s| is)\s+)?(?:the\s+number\s+)?([IVXLCDM]{2,15})(?:\s+in\s+numbers?)?\s*[?.!]*$/,
        )?.[1];
        if (fromRoman) return plan(step('util.roman', { value: fromRoman }), 'roman');
        return null;
      },
    },

    // ---- calculators --------------------------------------------------------

    {
      name: 'mathTip',
      order: -7.49,
      questionSafe: ['tip'],
      test(_lower, raw) {
        const m = raw.match(
          /^\s*(?:what(?:'s| is)\s+(?:a\s+|the\s+)?)?(?:(\d{1,2})%?\s+)?tip\s+(?:on|for)\s+\$?([\d.,]+)(?:\s*(?:split|between|for)\s+(\d+)(?:\s*(?:ways?|people|of us))?)?\s*[?.!]*$/i,
        );
        if (!m) return null;
        const args: Record<string, number> = { bill: Number(String(m[2]).replace(/,/g, '')) };
        if (m[1]) args.percent = Number(m[1]);
        if (m[3]) args.people = Number(m[3]);
        return plan(step('math.tip', args), 'tip');
      },
    },

    {
      name: 'mathInterest',
      order: -7.48,
      test(_lower, raw) {
        const loan = raw.match(
          /^\s*(?:what(?:'s| is)\s+the\s+)?monthly payment (?:on|for)\s+\$?([\d.,]+)\s+at\s+([\d.]+)%?\s+(?:over|for)\s+([\d.]+)\s*years?\s*[?.!]*$/i,
        );
        if (loan) {
          return plan(
            step('math.interest', {
              amount: Number(String(loan[1]).replace(/,/g, '')),
              rate: Number(loan[2]),
              years: Number(loan[3]),
              mode: 'loan',
            }),
            'interest',
          );
        }
        const savings = raw.match(
          /^\s*compound\s+\$?([\d.,]+)\s+at\s+([\d.]+)%?\s+(?:over|for)\s+([\d.]+)\s*years?\s*[?.!]*$/i,
        );
        if (savings) {
          return plan(
            step('math.interest', {
              amount: Number(String(savings[1]).replace(/,/g, '')),
              rate: Number(savings[2]),
              years: Number(savings[3]),
              mode: 'savings',
            }),
            'interest',
          );
        }
        return null;
      },
    },

    {
      name: 'mathAspect',
      order: -7.47,
      questionSafe: ['aspect'],
      test(_lower, raw) {
        const resize = raw.match(
          /^\s*(?:resize|scale)\s+(\d+)\s*[x×]\s*(\d+)\s+to\s+(width|height)\s+(\d+)\s*[?.!]*$/i,
        );
        if (resize) {
          const key = String(resize[3]).toLowerCase() === 'width' ? 'toWidth' : 'toHeight';
          return plan(
            step('math.aspect', {
              width: Number(resize[1]),
              height: Number(resize[2]),
              [key]: Number(resize[4]),
            }),
            'aspect',
          );
        }
        const ratio = raw.match(
          /^\s*(?:what(?:'s| is)\s+the\s+)?aspect ratio (?:of|for)\s+(\d+)\s*[x×]\s*(\d+)\s*[?.!]*$/i,
        );
        if (!ratio) return null;
        return plan(
          step('math.aspect', { width: Number(ratio[1]), height: Number(ratio[2]) }),
          'aspect',
        );
      },
    },

    {
      // Ahead of unitConvert, which owns "convert X to Y" but knows nothing
      // about data sizes and would decline after the phrasing was already lost.
      name: 'mathBytes',
      order: -7.46,
      questionSafe: ['bytes'],
      test(_lower, raw) {
        const units = '(bytes?|bits?|[kmgt]i?b)';
        const howMany = raw.match(
          new RegExp(
            `^\\s*how many\\s+${units}\\s+(?:are\\s+)?in\\s+([\\d.]+)\\s*${units}\\s*[?.!]*$`,
            'i',
          ),
        );
        if (howMany) {
          return plan(
            step('math.bytes', { value: Number(howMany[2]), from: howMany[3]!, to: howMany[1]! }),
            'bytes',
          );
        }
        const convert = raw.match(
          new RegExp(
            `^\\s*convert\\s+([\\d.]+)\\s*${units}\\s+(?:to|into)\\s+${units}\\s*[?.!]*$`,
            'i',
          ),
        );
        if (!convert) return null;
        return plan(
          step('math.bytes', { value: Number(convert[1]), from: convert[2]!, to: convert[3]! }),
          'bytes',
        );
      },
    },

    {
      name: 'mathPrimes',
      order: -7.45,
      questionSafe: ['primes'],
      test(_lower, raw) {
        const isPrime = raw.match(/^\s*is\s+(\d+)\s+(?:a\s+)?prime(?:\s+number)?\s*[?.!]*$/i)?.[1];
        if (isPrime) return plan(step('math.primes', { value: Number(isPrime) }), 'primes');

        const factor = raw.match(/^\s*(?:prime\s+)?factou?r(?:ise|ize)?\s+(\d+)\s*[?.!]*$/i)?.[1];
        if (factor) return plan(step('math.primes', { value: Number(factor) }), 'primes');
        return null;
      },
    },

    {
      name: 'mathFraction',
      order: -7.44,
      questionSafe: ['fraction'],
      test(_lower, raw) {
        const m = raw.match(
          /^\s*(?:what(?:'s| is)\s+)?(-?[\d.]+|\d+\s*\/\s*\d+)\s+as\s+a\s+(fraction|decimal)\s*[?.!]*$/i,
        );
        if (!m) return null;
        return plan(step('math.fraction', { value: m[1]! }), 'fraction');
      },
    },

    // ---- dates ---------------------------------------------------------------

    {
      name: 'timeZoneDiff',
      order: -7.33,
      questionSafe: ['zone-diff'],
      test(_lower, raw) {
        const m = raw.match(
          /^\s*(?:what(?:'s| is)\s+the\s+)?(?:time\s+)?difference\s+between\s+([a-z .'/_-]+?)\s+and\s+([a-z .'/_-]+?)\s*[?.!]*$/i,
        );
        if (!m) return null;
        return plan(step('time.zoneDiff', { from: m[1]!.trim(), to: m[2]!.trim() }), 'zone-diff');
      },
    },

    {
      name: 'timeAge',
      order: -7.29,
      questionSafe: ['age'],
      test(_lower, raw) {
        const m = raw.match(
          /^\s*how old (?:is|are)\s+(?:someone|you|they|a person)?\s*(?:who was\s+)?born\s+(?:on\s+|in\s+)?(.+?)\s*[?.!]*$/i,
        );
        if (!m) return null;
        return plan(step('time.age', { date: m[1]!.trim() }), 'age');
      },
    },

    {
      name: 'timeBetween',
      order: -7.27,
      questionSafe: ['between'],
      test(_lower, raw) {
        const m = raw.match(
          /^\s*(?:how many\s+)?days?\s+(?:are\s+there\s+)?between\s+(.+?)\s+and\s+(.+?)\s*[?.!]*$/i,
        );
        if (!m) return null;
        // "days between london and tokyo" is a time-zone question, not a date
        // one; a date has a digit in it.
        if (!/\d/.test(m[1]!) || !/\d/.test(m[2]!)) return null;
        return plan(step('time.between', { from: m[1]!.trim(), to: m[2]!.trim() }), 'between');
      },
    },

    {
      name: 'timeWeekday',
      order: -7.26,
      questionSafe: ['weekday'],
      test(_lower, raw) {
        const m = raw.match(
          /^\s*what day (?:of the week )?(?:is|was|will)\s+(.+?)(?:\s+be)?\s*[?.!]*$/i,
        );
        if (!m || !/\d/.test(m[1]!)) return null;
        return plan(step('time.weekday', { date: m[1]!.trim() }), 'weekday');
      },
    },

    {
      name: 'timeUnix',
      order: -7.25,
      test(_lower, raw) {
        const stamp = raw.match(/^\s*(?:unix\s+)?timestamp\s+(?:for\s+)?(.+?)\s*[?.!]*$/i)?.[1];
        if (stamp) return plan(step('time.unix', { value: stamp.trim() }), 'unix');

        const forDate = raw.match(/^\s*unix time (?:for|of)\s+(.+?)\s*[?.!]*$/i)?.[1];
        if (forDate) return plan(step('time.unix', { value: forDate.trim() }), 'unix');
        return null;
      },
    },

    // ---- notes and to-dos ----------------------------------------------------

    {
      // Ahead of `rememberAlias` (-9.5), which owns "remember my X is Y" — a
      // note is free text and has no "is".
      name: 'notesAdd',
      order: -9.6,
      pathSafe: true,
      test(_lower, raw) {
        const m =
          raw.match(/^\s*(?:take a note|make a note|note)\s*[:-]\s*([\s\S]+?)\s*$/i) ??
          raw.match(/^\s*note that\s+([\s\S]+?)\s*[?.!]*$/i) ??
          raw.match(/^\s*write down\s+(?:that\s+)?([\s\S]+?)\s*[?.!]*$/i);
        if (!m) return null;
        return plan(step('notes.add', { text: stripQuotes(m[1]!) }), 'note-add');
      },
    },

    {
      name: 'notesList',
      order: -9.59,
      questionSafe: ['note-list'],
      test(lower) {
        if (
          /^\s*(?:read|show|list)\s+(?:me\s+)?(?:my\s+|the\s+)?notes\s*[?.!]*$/.test(lower) ||
          /\bwhat (?:are|were) my notes\b/.test(lower)
        ) {
          return plan(step('notes.list', {}), 'note-list');
        }
        return null;
      },
    },

    {
      name: 'notesClear',
      order: -9.58,
      test(lower) {
        if (/^\s*(?:clear|delete|wipe)\s+(?:all\s+)?(?:my\s+|the\s+)?notes\s*[?.!]*$/.test(lower)) {
          return plan(step('notes.clear', {}), 'note-clear');
        }
        return null;
      },
    },

    {
      name: 'todoAdd',
      order: -9.57,
      test(_lower, raw) {
        const m =
          raw.match(/^\s*add\s+([\s\S]+?)\s+to (?:my )?(?:to-?do|todo)(?:\s+list)?\s*[?.!]*$/i) ??
          raw.match(/^\s*(?:to-?do|todo)\s*[:-]\s*([\s\S]+?)\s*$/i) ??
          raw.match(/^\s*remind me to\s+([\s\S]+?)\s*[?.!]*$/i);
        if (!m) return null;
        return plan(step('todo.add', { text: stripQuotes(m[1]!) }), 'todo-add');
      },
    },

    {
      name: 'todoList',
      order: -9.56,
      questionSafe: ['todo-list'],
      test(lower) {
        if (
          /\bwhat(?:'s| is)? (?:on )?my (?:to-?do|todo)(?: list)?\b/.test(lower) ||
          /^\s*(?:show|list|read)\s+(?:me\s+)?(?:my\s+)?(?:to-?dos?|todos?)(?:\s+list)?\s*[?.!]*$/.test(
            lower,
          )
        ) {
          return plan(step('todo.list', {}), 'todo-list');
        }
        return null;
      },
    },

    {
      name: 'todoDone',
      order: -9.55,
      test(_lower, raw) {
        const m =
          raw.match(/^\s*(?:tick|check)\s+off\s+([\s\S]+?)\s*[?.!]*$/i) ??
          raw.match(/^\s*mark\s+([\s\S]+?)\s+(?:as\s+)?done\s*[?.!]*$/i) ??
          raw.match(/^\s*(?:i\s+)?(?:finished|completed)\s+([\s\S]+?)\s*[?.!]*$/i);
        if (!m) return null;
        return plan(step('todo.done', { text: stripQuotes(m[1]!) }), 'todo-done');
      },
    },

    // ---- the machine ---------------------------------------------------------

    {
      // Before atlasHide (-5), which owns a bare "lock"-adjacent dismissal
      // vocabulary ("hide", "close", "go away") — this one names the PC.
      name: 'systemLock',
      order: -5.2,
      test(lower) {
        if (
          /^\s*lock\s+(?:my\s+|the\s+|this\s+)?(?:pc|computer|machine|screen|workstation)\s*[?.!]*$/.test(
            lower,
          )
        ) {
          return plan(step('system.lock', {}), 'lock');
        }
        return null;
      },
    },

    {
      name: 'systemPower',
      order: -5.19,
      test(lower) {
        if (
          /\b(?:shut\s?down|power off|turn off)\b.*\b(?:pc|computer|machine|windows)\b/.test(lower)
        ) {
          return plan(step('system.power', { action: 'shutdown' }), 'power');
        }
        if (
          /\brestart\b.*\b(?:pc|computer|machine|windows)\b/.test(lower) ||
          /^\s*reboot\s*[?.!]*$/.test(lower)
        ) {
          return plan(step('system.power', { action: 'restart' }), 'power');
        }
        if (/\bsign (?:me )?out\b|\blog (?:me )?out of windows\b/.test(lower)) {
          return plan(step('system.power', { action: 'sign-out' }), 'power');
        }
        return null;
      },
    },

    {
      name: 'systemVolume',
      order: -5.18,
      test(_lower, raw) {
        const m = raw.match(
          /^\s*(?:turn\s+(?:the\s+)?(?:volume|sound|it)\s+)?(?:volume\s+)?(up|down)(?:\s+(?:the\s+)?(?:volume|sound))?(?:\s+(?:by\s+)?(\d+))?\s*(?:a bit|a little|please)?\s*[?.!]*$/i,
        );
        if (!m) return null;
        // "up"/"down" alone is too broad to claim; the sentence has to have
        // mentioned volume or sound somewhere.
        if (!/\b(volume|sound|louder|quieter)\b/i.test(raw)) return null;
        const args: Record<string, string | number> = { direction: String(m[1]).toLowerCase() };
        if (m[2]) args.steps = Number(m[2]);
        return plan(step('system.volume', args), 'volume');
      },
    },

    {
      name: 'systemVolumeWords',
      order: -5.175,
      test(lower) {
        if (/^\s*(?:make it\s+)?louder\s*[?.!]*$/.test(lower)) {
          return plan(step('system.volume', { direction: 'up' }), 'volume');
        }
        if (/^\s*(?:make it\s+)?(?:quieter|softer)\s*[?.!]*$/.test(lower)) {
          return plan(step('system.volume', { direction: 'down' }), 'volume');
        }
        return null;
      },
    },

    {
      name: 'systemMute',
      order: -5.17,
      test(lower) {
        if (/^\s*(?:un)?mute\s*(?:the\s+)?(?:sound|volume|audio|it)?\s*[?.!]*$/.test(lower)) {
          return plan(step('system.mute', {}), 'mute');
        }
        return null;
      },
    },

    {
      name: 'mediaControl',
      order: -5.16,
      test(lower) {
        if (
          /^\s*(?:pause|resume|play)\s*(?:the\s+)?(?:music|song|track|video|playback|it)?\s*[?.!]*$/.test(
            lower,
          )
        ) {
          return plan(step('media.control', { key: 'play-pause' }), 'media');
        }
        if (/\b(?:skip|next)\b.*\b(?:track|song|this)\b|^\s*next track\s*[?.!]*$/.test(lower)) {
          return plan(step('media.control', { key: 'next' }), 'media');
        }
        if (/\b(?:previous|last|go back a)\b.*\b(?:track|song)\b/.test(lower)) {
          return plan(step('media.control', { key: 'previous' }), 'media');
        }
        return null;
      },
    },

    {
      name: 'systemDisplayOff',
      order: -5.15,
      test(lower) {
        if (
          /^\s*(?:turn\s+)?(?:off|display off|screen off)\s*(?:the\s+)?(?:screen|display|monitor)?\s*[?.!]*$/.test(
            lower,
          ) &&
          /\b(screen|display|monitor)\b/.test(lower)
        ) {
          return plan(step('system.displayOff', {}), 'display-off');
        }
        return null;
      },
    },

    {
      name: 'systemRecycleBin',
      order: -5.14,
      test(lower) {
        if (/\bempty\b.*\b(?:recycle bin|trash|bin)\b/.test(lower)) {
          return plan(step('system.emptyRecycleBin', {}), 'recycle-bin');
        }
        return null;
      },
    },

    // ---- files and clipboard -------------------------------------------------

    {
      // Path-safe: every one of these names a path, which would otherwise make
      // the grammar skip the rule entirely.
      name: 'filesInspect',
      order: -3.95,
      pathSafe: true,
      // "how big is …" and "what is in …" are questions, and questions are
      // declined by default — without this the rule is unreachable.
      questionSafe: ['file-info', 'file-peek', 'file-list', 'file-append'],
      test(_lower, raw) {
        const info = raw.match(
          /^\s*(?:how big is|file info (?:for|on)|details (?:for|of))\s+(.+?)\s*[?.!]*$/i,
        )?.[1];
        if (info) return plan(step('files.info', { path: stripQuotes(info) }), 'file-info');

        const peek = raw.match(/^\s*(?:peek (?:at|inside)|preview|head)\s+(.+?)\s*[?.!]*$/i)?.[1];
        if (peek) return plan(step('files.peek', { path: stripQuotes(peek) }), 'file-peek');

        const list = raw.match(
          /^\s*(?:what(?:'s| is) in|list|contents of)\s+(.+?)\s*[?.!]*$/i,
        )?.[1];
        if (list) return plan(step('files.list', { path: stripQuotes(list) }), 'file-list');

        const append = raw.match(/^\s*(?:append|add)\s+(["'“].+?["'”])\s+to\s+(.+?)\s*[?.!]*$/i);
        if (append) {
          return plan(
            step('files.append', { path: stripQuotes(append[2]!), text: stripQuotes(append[1]!) }),
            'file-append',
          );
        }
        return null;
      },
    },

    {
      // Before appOpen, which would look for an application called "downloads".
      name: 'filesKnownFolder',
      order: -3.6,
      test(_lower, raw) {
        const m = raw.match(
          /^\s*(?:open|show|go to)\s+(?:my\s+|the\s+)?(downloads?|documents?|desktop|pictures?|photos|music|videos?|home)(?:\s+folder)?\s*[?.!]*$/i,
        );
        if (!m) return null;
        const word = String(m[1]).toLowerCase();
        const folder = word.startsWith('download')
          ? 'downloads'
          : word.startsWith('document')
            ? 'documents'
            : word === 'desktop'
              ? 'desktop'
              : word.startsWith('picture') || word === 'photos'
                ? 'pictures'
                : word === 'music'
                  ? 'music'
                  : word.startsWith('video')
                    ? 'videos'
                    : 'home';
        return plan(step('files.openKnown', { folder }), 'known-folder');
      },
    },

    {
      name: 'clipboardExtras',
      order: -4.08,
      test(_lower, raw) {
        const lower = raw.toLowerCase();
        if (/^\s*(?:clear|empty|wipe)\s+(?:my\s+|the\s+)?clipboard\s*[?.!]*$/.test(lower)) {
          return plan(step('clipboard.clear', {}), 'clipboard-clear');
        }

        const transform = lower.match(
          /^\s*(uppercase|lowercase|trim|flatten|single[- ]line)\s+(?:my\s+|the\s+)?clipboard\s*[?.!]*$/,
        )?.[1];
        if (transform) {
          const style =
            transform === 'uppercase'
              ? 'upper'
              : transform === 'lowercase'
                ? 'lower'
                : transform === 'trim'
                  ? 'trim'
                  : 'single-line';
          return plan(step('clipboard.transform', { style }), 'clipboard-transform');
        }

        const append = raw.match(
          /^\s*add\s+(["'“].+?["'”])\s+to\s+(?:my\s+|the\s+)?clipboard\s*[?.!]*$/i,
        )?.[1];
        if (append)
          return plan(step('clipboard.append', { text: stripQuotes(append) }), 'clipboard-append');
        return null;
      },
    },

    {
      name: 'clipboardSave',
      order: -4.07,
      pathSafe: true,
      test(_lower, raw) {
        const captured = raw.match(
          /^\s*save\s+(?:my\s+|the\s+)?clipboard\s+(?:to|as|into)\s+(.+?)\s*[?.!]*$/i,
        )?.[1];
        if (!captured) return null;
        return plan(step('clipboard.save', { path: stripQuotes(captured) }), 'clipboard-save');
      },
    },

    // ---- the machine, reported ------------------------------------------------

    {
      name: 'systemReadouts',
      order: -6.95,
      questionSafe: ['battery', 'disk', 'uptime'],
      test(lower) {
        if (/\bbattery\b/.test(lower) && !/\bstatus\b.*\bsystem\b/.test(lower)) {
          return plan(step('system.battery', {}), 'battery');
        }
        if (/\b(?:disk|drive|storage)\s+space\b|\bhow much space\b|\bfree space\b/.test(lower)) {
          return plan(step('system.disk', {}), 'disk');
        }
        if (
          /\buptime\b|\bhow long has (?:my|this) (?:pc|computer|machine) been (?:on|up|running)\b/.test(
            lower,
          )
        ) {
          return plan(step('system.uptime', {}), 'uptime');
        }
        return null;
      },
    },
  ];
}
