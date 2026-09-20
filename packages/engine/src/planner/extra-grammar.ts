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

import { createIncompleteRules } from './incomplete-grammar';
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

/**
 * "activate|press|push|toggle|select|expand|collapse|click" → the one skill
 * each actually means. Shared by `uiaInvokeOrExpand` and `uiaInvokeNoWindow`
 * — the same verb list means the same three-way dispatch either way; only
 * the args shape (a `window` or not) and confidence differ between them.
 */
function planUiaVerb(verb: string, args: Record<string, string>, confidence?: number) {
  if (verb === 'expand') return plan(step('uia.expand', args), 'uia-expand', confidence);
  if (verb === 'collapse') return plan(step('uia.collapse', args), 'uia-collapse', confidence);
  return plan(step('uia.invoke', args), 'uia-invoke', confidence);
}

export function createExtraGrammar(): GrammarRule[] {
  return [
    // Requests that name an action and leave out what it needs: last in line,
    // so they only ever catch what every more specific rule declined.
    ...createIncompleteRules(),

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

    // ---- the network, reported ------------------------------------------------
    //
    // All questions, all read-only. `questionSafe` matters here more than
    // anywhere else in this file: "what is my ip" is unambiguously a question,
    // and triage would otherwise route it to conversation and answer it with a
    // sentence about not knowing rather than with the address.

    {
      name: 'networkReadouts',
      order: -6.9,
      // ⚠️ These are the *intents* this rule returns, not keywords in the
      // text — naming anything else silently declines every question-shaped
      // phrasing, which is most of them: "what is my ip" is a question.
      questionSafe: ['ip', 'wifi', 'wifi-saved', 'online', 'adapters'],
      test(lower) {
        // Saved networks first: "my saved wifi" is about the list, not about
        // the connection, and the more specific reading is the one meant.
        if (
          /\bsaved\s+(?:wi-?fi|wireless)\b|\b(?:wi-?fi|wireless)\s+(?:networks|profiles)\b/.test(
            lower,
          )
        ) {
          return plan(step('net.savedNetworks', {}), 'wifi-saved');
        }
        if (
          /\b(?:am i online|are we online|is the internet (?:working|up|down)|do i have internet|is my internet (?:working|up|down))\b/.test(
            lower,
          )
        ) {
          return plan(step('net.online', {}), 'online');
        }
        if (/\b(?:wi-?fi|wireless)\b/.test(lower)) {
          return plan(step('net.wifi', {}), 'wifi');
        }
        // The word boundaries are load-bearing. "ip" is two letters and sits
        // inside "zip", "clip" and "recipe"; without \b this rule would claim
        // "unzip my downloads".
        if (/\b(?:my|the)\s+ip(?:\s+address)?\b|\bip address\b/.test(lower)) {
          return plan(step('net.ip', {}), 'ip');
        }
        if (/\bnetwork\s+adapters?\b|\badapters?\b.*\bnetwork\b/.test(lower)) {
          return plan(step('net.adapters', {}), 'adapters');
        }
        return null;
      },
    },

    // ---- services -------------------------------------------------------------
    //
    // ⚠️ These sit above `systemPower` (-5.19) on purpose, and the reason is a
    // real collision rather than a hypothetical one: that rule claims
    // /restart.*windows/, so "restart the Windows Update service" would
    // otherwise reboot the machine. Ordering is the fix, and the test named
    // after it is why this comment is here.
    //
    // Every rule below requires the literal word "service". That is a
    // deliberate limit rather than an oversight: "is Steam running" is a
    // question about a process and Atlas already answers it, so the word is
    // what tells the two apart without guessing.

    {
      name: 'serviceReadouts',
      order: -6.92,
      // ⚠️ The *intents* below, not keywords in the text — the trap the
      // network pack hit. Every phrasing here is question-shaped, so a wrong
      // list here declines all of them silently.
      questionSafe: ['services', 'service-status'],
      test(lower) {
        // "list all services" means all of them; "what services are running"
        // means the running ones, which is what people almost always want.
        if (
          /\b(?:list|show)\s+(?:me\s+)?all\s+(?:the\s+)?(?:windows\s+)?services\b/.test(lower)
        ) {
          return plan(step('service.list', { all: true }), 'services');
        }
        if (
          /\b(?:what|which)\s+services\s+(?:are\s+)?(?:running|started|going|on)\b/.test(lower) ||
          /\b(?:list|show)\s+(?:me\s+)?(?:the\s+)?(?:running\s+)?(?:windows\s+)?services\b/.test(
            lower,
          )
        ) {
          return plan(step('service.list', {}), 'services');
        }

        // "is the print spooler service running"
        const asked = lower.match(
          /^\s*(?:is|are)\s+(?:the\s+)?(.+?)\s+service\s+(?:running|started|up|on|stopped|down|off)\s*[?.!]*$/,
        );
        if (asked?.[1]) return plan(step('service.status', { name: asked[1] }), 'service-status');

        // "what's the status of the windows update service"
        const status = lower.match(
          /^\s*(?:what(?:'s| is)\s+(?:the\s+)?)?status\s+of\s+(?:the\s+)?(.+?)\s+service\s*[?.!]*$/,
        );
        if (status?.[1]) return plan(step('service.status', { name: status[1] }), 'service-status');

        // "check the spooler service"
        const check = lower.match(/^\s*check\s+(?:on\s+)?(?:the\s+)?(.+?)\s+service\s*[?.!]*$/);
        if (check?.[1]) return plan(step('service.status', { name: check[1] }), 'service-status');

        return null;
      },
    },

    {
      name: 'serviceControl',
      order: -6.91,
      test(lower) {
        const m =
          lower.match(/^\s*(start|stop|restart)\s+(?:the\s+)?(.+?)\s+service\s*[?.!]*$/) ??
          lower.match(/^\s*(start|stop|restart)\s+(?:the\s+)?service\s+(.+?)\s*[?.!]*$/);
        if (!m?.[1] || !m[2]) return null;

        const verb = m[1];
        const name = m[2];
        const id =
          verb === 'start' ? 'service.start' : verb === 'stop' ? 'service.stop' : 'service.restart';
        return plan(step(id, { name }), `service-${verb}`);
      },
    },

    // ---- environment --------------------------------------------------------
    //
    // Every rule below requires the literal word "environment" (or, for
    // delete/get, "variable") — the same tell-them-apart trick the services
    // block above uses with "service", and for the same reason: a bare name
    // ("what is PATH") is not obviously a command at all.

    {
      name: 'environmentReadouts',
      order: -6.89,
      // A variable's *name* never looks like a path, but its value can (see
      // `environmentSet`'s comment) — set on every rule in this block so a
      // path-shaped value never silently reroutes any of the four verbs to
      // the AI-plan path instead of the skill that was actually asked for.
      pathSafe: true,
      questionSafe: ['environment-list', 'environment-get'],
      test(_lower, raw) {
        if (/\b(?:list|show)\s+(?:me\s+)?(?:all\s+)?(?:the\s+)?system\s+environment\s+variables?\b/i.test(raw)) {
          return plan(step('environment.list', { scope: 'system' }), 'environment-list');
        }
        if (
          /\b(?:list|show)\s+(?:me\s+)?(?:all\s+)?(?:the\s+)?my\s+environment\s+variables?\b/i.test(
            raw,
          )
        ) {
          return plan(step('environment.list', { scope: 'user' }), 'environment-list');
        }
        if (
          /\b(?:list|show)\s+(?:me\s+)?(?:all\s+)?(?:the\s+)?environment\s+variables?\b/i.test(
            raw,
          ) ||
          /\bwhat\s+environment\s+variables?\s+(?:are\s+)?(?:set|there)\b/i.test(raw)
        ) {
          return plan(step('environment.list', { scope: 'all' }), 'environment-list');
        }

        // "what is the PATH environment variable", "the JAVA_HOME environment variable"
        const named = raw.match(
          /^\s*(?:what(?:'s|\s+is)\s+(?:the\s+)?)?([A-Za-z0-9_.()%-]+)\s+environment\s+variable\s*[?.!]*$/i,
        );
        if (named?.[1]) return plan(step('environment.get', { name: named[1] }), 'environment-get');

        // "get the environment variable FOO", "what is the environment variable FOO"
        const get = raw.match(
          /^\s*(?:get|what(?:'s|\s+is))\s+(?:the\s+)?environment\s+variable\s+([A-Za-z0-9_.()%-]+)\s*[?.!]*$/i,
        );
        if (get?.[1]) return plan(step('environment.get', { name: get[1] }), 'environment-get');

        return null;
      },
    },

    {
      name: 'environmentSet',
      order: -6.88,
      // ⚠️ Environment variable values are routinely paths — `PATH` itself is
      // the extreme case — and without this the guard built for "open C:\…"
      // would silently swallow every one of them, sending "set PATH to
      // C:\tools" to the AI-plan path instead of the skill actually named.
      pathSafe: true,
      test(_lower, raw) {
        const system = raw.match(
          /^\s*set\s+(?:the\s+)?system\s+environment\s+variable\s+([A-Za-z0-9_.()%-]+)\s+to\s+(.+?)\s*[?.!]*$/i,
        );
        if (system?.[1] && system[2] !== undefined) {
          return plan(
            step('environment.setSystem', { name: system[1], value: system[2] }),
            'environment-set-system',
          );
        }

        const user = raw.match(
          /^\s*set\s+(?:the\s+|my\s+)?environment\s+variable\s+([A-Za-z0-9_.()%-]+)\s+to\s+(.+?)\s*[?.!]*$/i,
        );
        if (user?.[1] && user[2] !== undefined) {
          return plan(step('environment.set', { name: user[1], value: user[2] }), 'environment-set');
        }

        return null;
      },
    },

    {
      name: 'environmentDelete',
      order: -6.87,
      pathSafe: true,
      test(_lower, raw) {
        const system = raw.match(
          /^\s*(?:remove|delete)\s+(?:the\s+)?system\s+environment\s+variable\s+([A-Za-z0-9_.()%-]+)\s*[?.!]*$/i,
        );
        if (system?.[1]) {
          return plan(step('environment.deleteSystem', { name: system[1] }), 'environment-delete-system');
        }

        const user =
          raw.match(
            /^\s*(?:remove|delete)\s+(?:the\s+|my\s+)?environment\s+variable\s+([A-Za-z0-9_.()%-]+)\s*[?.!]*$/i,
          ) ??
          raw.match(/^\s*(?:remove|delete)\s+(?:the\s+|my\s+)?([A-Za-z0-9_.()%-]+)\s+variable\s*[?.!]*$/i);
        if (user?.[1]) {
          return plan(step('environment.delete', { name: user[1] }), 'environment-delete');
        }

        return null;
      },
    },

    // ---- storage --------------------------------------------------------------
    //
    // Every rule below requires the literal word "folder" — the same
    // tell-it-apart device the services and environment blocks use with their
    // own nouns — so "how big is Notepad" (not a folder question at all)
    // never reaches here.

    {
      name: 'storageFolderSize',
      order: -6.86,
      pathSafe: true,
      questionSafe: ['storage-folder-size'],
      test(_lower, raw) {
        const m =
          raw.match(/\bhow\s+(?:big|large)\s+is\s+(?:my\s+|the\s+)?(.+?)\s+folder\b/i) ??
          raw.match(/\b(?:size|space)\s+of\s+(?:my\s+|the\s+)?(.+?)\s+folder\b/i) ??
          raw.match(/\bhow\s+much\s+space\s+is\s+(?:my\s+|the\s+)?(.+?)\s+folder\s+using\b/i);
        if (!m?.[1]) return null;
        return plan(step('storage.folderSize', { path: m[1] }), 'storage-folder-size');
      },
    },

    {
      name: 'storageLargestFiles',
      order: -6.85,
      pathSafe: true,
      questionSafe: ['storage-largest-files'],
      test(_lower, raw) {
        const m =
          raw.match(/\blargest\s+files\s+in\s+(?:my\s+|the\s+)?(.+?)(?:\s+folder)?\s*[?.!]*$/i) ??
          raw.match(
            /\b(?:find|show)\s+(?:me\s+)?large\s+files\s+in\s+(?:my\s+|the\s+)?(.+?)(?:\s+folder)?\s*[?.!]*$/i,
          );
        if (!m?.[1]) return null;
        return plan(step('storage.largestFiles', { path: m[1] }), 'storage-largest-files');
      },
    },

    {
      name: 'storageEmptyFolder',
      order: -6.84,
      pathSafe: true,
      test(_lower, raw) {
        const m =
          raw.match(/^\s*empty\s+(?:my\s+|the\s+)?(.+?)\s+folder\s*[?.!]*$/i) ??
          raw.match(/^\s*clear\s+out\s+(?:my\s+|the\s+)?(.+?)\s+folder\s*[?.!]*$/i);
        if (!m?.[1]) return null;
        return plan(step('storage.emptyFolder', { path: m[1] }), 'storage-empty-folder');
      },
    },

    // ---- windows ----------------------------------------------------------
    //
    // Every rule below requires the literal word "window", the same way the
    // services block above requires "service" — it's what tells "close the
    // notepad window" apart from "close notepad" (an app-lifecycle question
    // this grammar doesn't otherwise have a rule for) and from bare "close",
    // which `core-grammar.ts` already claims for dismissing Atlas itself.

    {
      name: 'windowList',
      order: -6.7,
      questionSafe: ['window-list', 'window-active'],
      test(lower) {
        if (/\b(?:what|which)\s+windows\s+(?:do\s+i\s+have\s+)?(?:are\s+)?open\b/.test(lower) ||
          /\b(?:list|show)\s+(?:me\s+)?(?:the\s+)?(?:open\s+)?windows\b/.test(lower)) {
          return plan(step('window.list', {}), 'window-list');
        }
        if (
          /\b(?:what|which)\s+window\s+is\s+(?:active|focused|focussed)\b/.test(lower) ||
          /\bwhat'?s\s+focused\s+(?:right\s+now)?\b/.test(lower)
        ) {
          return plan(step('window.active', {}), 'window-active');
        }
        return null;
      },
    },

    {
      name: 'windowControl',
      order: -6.69,
      test(lower) {
        const m = lower.match(
          /^\s*(minimize|maximize|restore|close|focus)\s+(?:on\s+)?(?:the\s+|my\s+)?(.+?)\s+window\s*[?.!]*$/,
        );
        if (!m?.[1] || !m[2]) return null;

        const verb = m[1];
        const name = m[2];
        const id =
          verb === 'minimize'
            ? 'window.minimize'
            : verb === 'maximize'
              ? 'window.maximize'
              : verb === 'restore'
                ? 'window.restore'
                : verb === 'close'
                  ? 'window.close'
                  : 'window.focus';
        return plan(step(id, { name }), `window-${verb}`);
      },
    },

    {
      name: 'endProcess',
      order: -6.68,
      test(lower) {
        const m =
          lower.match(/^\s*(?:end|kill|force\s*(?:close|quit|end))\s+(?:the\s+)?process\s+(.+?)\s*[?.!]*$/) ??
          lower.match(/^\s*(?:end|kill|force\s*(?:close|quit))\s+(?:the\s+)?(.+?)\s*[?.!]*$/);
        if (!m?.[1]) return null;
        return plan(step('system.endProcess', { process: m[1] }), 'end-process');
      },
    },

    // ---- input --------------------------------------------------------------
    //
    // Originally only the phrasings with no coordinates in them, on the
    // reasoning that "click at 500, 300" is what the AI-planner tier exists
    // for. That reasoning had a hole in it: the AI tier needs a provider, and
    // Atlas is built to be fully useful with none — so on a machine with
    // nothing configured, every mouse skill was unreachable while the
    // capability list went on advertising "click at 500, 300" as an example
    // of something you could say. A phrasing an action *documents as its own
    // example* has to work without a model. These rules are those examples,
    // verbatim.

    {
      name: 'pressNamedKeyOrHotkey',
      order: -6.67,
      test(lower) {
        // "press ctrl+c" / "press ctrl + shift + s" — a combo, not a single
        // named key, told apart by the presence of "+".
        const combo = lower.match(/^\s*press\s+([a-z0-9]+(?:\s*\+\s*[a-z0-9]+)+)\s*[?.!]*$/);
        if (combo?.[1]) {
          return plan(
            step('input.hotkey', { combo: combo[1].replace(/\s*\+\s*/g, '+') }),
            'hotkey',
          );
        }

        const single = lower.match(
          /^\s*press\s+(enter|return|escape|esc|tab|backspace|delete|del|insert|ins|home|end|space|spacebar|up|down|left|right|pageup|pagedown|f[1-9]|f1[0-2])\s*[?.!]*$/,
        );
        if (single?.[1]) return plan(step('input.pressKey', { key: single[1] }), 'press-key');

        return null;
      },
    },

    {
      name: 'scroll',
      order: -6.66,
      test(lower) {
        const m = lower.match(/^\s*scroll\s+(up|down)(?:\s+(\d+))?\s*[?.!]*$/);
        if (!m?.[1]) return null;
        const notches = m[2] ? Number(m[2]) : 3;
        const amount = m[1] === 'up' ? notches : -notches;
        return plan(step('input.scroll', { amount }), 'scroll');
      },
    },

    {
      name: 'typeText',
      order: -6.65,
      test(_lower, raw) {
        const m = raw.match(/^\s*type\s+(["'“].+?["'”])\s*[?.!]*$/i);
        if (!m?.[1]) return null;
        return plan(step('input.typeText', { text: stripQuotes(m[1]) }), 'type-text');
      },
    },

    {
      name: 'moveMouse',
      order: -6.64,
      test(lower) {
        // "move the mouse to 500, 300" — and the same without "the", and with
        // a space instead of a comma, because both are what people type.
        const m = lower.match(
          /^\s*move\s+(?:the\s+)?(?:mouse|cursor|pointer)\s+to\s+(-?\d+)\s*(?:,|\s)\s*(-?\d+)\s*[?.!]*$/,
        );
        if (!m) return null;
        return plan(
          step('input.moveMouse', { x: Number(m[1]), y: Number(m[2]) }),
          'move-mouse',
        );
      },
    },

    {
      name: 'clickAt',
      order: -6.63,
      test(lower) {
        // "click at 500, 300", "right-click at …", "double click at …".
        // "at" stays required: "click play" is a request to find something on
        // screen and press it, which is a different, much larger feature — and
        // quietly clicking wherever the pointer happens to sit would be a
        // worse answer than not understanding the sentence.
        const m = lower.match(
          /^\s*(?:(left|right|middle|double)[\s-]*)?click\s+(?:at\s+)?\(?(-?\d+)\s*(?:,|\s)\s*(-?\d+)\)?\s*[?.!]*$/,
        );
        if (!m) return null;
        const kind = m[1];
        return plan(
          step('input.click', {
            x: Number(m[2]),
            y: Number(m[3]),
            button: kind === 'right' || kind === 'middle' ? kind : 'left',
            double: kind === 'double',
          }),
          'click-at',
        );
      },
    },

    {
      name: 'dragBetweenPoints',
      order: -6.62,
      test(lower) {
        const m = lower.match(
          /^\s*drag\s+(?:from\s+)?\(?(-?\d+)\s*(?:,|\s)\s*(-?\d+)\)?\s+to\s+\(?(-?\d+)\s*(?:,|\s)\s*(-?\d+)\)?\s*[?.!]*$/,
        );
        if (!m) return null;
        return plan(
          step('input.drag', {
            fromX: Number(m[1]),
            fromY: Number(m[2]),
            toX: Number(m[3]),
            toY: Number(m[4]),
          }),
          'drag',
        );
      },
    },

    {
      name: 'cursorPosition',
      order: -6.61,
      // "where is the mouse" is question-shaped, and the grammar skips rules
      // for questions unless they say otherwise — the protection that keeps
      // "what is the capital of Peru?" from being run as a command. This one
      // is only ever a question, so it has to opt in or it can never fire.
      questionSafe: ['cursor-position'],
      test(lower) {
        if (
          !/^\s*(?:where(?:'s| is)?\s+(?:the\s+)?(?:mouse|cursor|pointer)|(?:mouse|cursor)\s+position)\s*[?.!]*$/.test(
            lower,
          )
        ) {
          return null;
        }
        return plan(step('input.cursorPosition', {}), 'cursor-position');
      },
    },

    {
      name: 'switchToWindow',
      order: -6.545,
      test(lower) {
        // "switch to discord" — distinct from "open discord", which launches.
        // Switching is for something already running, so it goes to
        // window.focus and says nothing about starting anything.
        // Only "switch to", never "go to": "go to youtube" is web
        // navigation and has meant that far longer than this rule has
        // existed. Claiming it here focused a window instead of opening a
        // site — a regression three existing tests caught immediately.
        const m = lower.match(
          /^\s*switch\s+(?:back\s+)?to\s+(?:the\s+)?(.+?)(?:\s+window)?\s*[?.!]*$/,
        );
        if (!m?.[1]) return null;
        const name = m[1].trim();
        if (!name || name.length > 60) return null;
        return plan(step('window.focus', { name }), 'focus-window');
      },
    },

    {
      name: 'moveOrResizeWindow',
      order: -6.54,
      test(lower) {
        // "move the notepad window to 0, 0"
        const moved = lower.match(
          /^\s*move\s+(?:the\s+)?(.+?)\s+window\s+to\s+\(?(-?\d+)\s*(?:,|\s)\s*(-?\d+)\)?\s*[?.!]*$/,
        );
        if (moved) {
          return plan(
            step('window.move', {
              name: moved[1]!.trim(),
              x: Number(moved[2]),
              y: Number(moved[3]),
            }),
            'move-window',
          );
        }

        // "resize the notepad window to 800 by 600" — and "800x600".
        const sized = lower.match(
          /^\s*resize\s+(?:the\s+)?(.+?)\s+window\s+to\s+(\d+)\s*(?:by|x|\*|,)\s*(\d+)\s*[?.!]*$/,
        );
        if (sized) {
          return plan(
            step('window.move', {
              name: sized[1]!.trim(),
              width: Number(sized[2]),
              height: Number(sized[3]),
            }),
            'resize-window',
          );
        }
        return null;
      },
    },

    {
      name: 'screenshotOfWindow',
      order: -6.535,
      test(lower) {
        // Before the plain-screenshot rule, which would otherwise capture the
        // whole screen and ignore the window that was actually asked for.
        const m = lower.match(
          /^\s*(?:take\s+)?(?:a\s+)?(?:screenshot|screen\s*shot|capture|screengrab)\s+of\s+(?:the\s+)?(.+?)\s+window\s*[?.!]*$/,
        );
        if (!m?.[1]) return null;
        return plan(step('screen.captureWindow', { window: m[1].trim() }), 'capture-window');
      },
    },

    // ---- environment variables ----------------------------------------------
    //
    // `environment.list` had a rule; reading, setting and removing one did
    // not, so three of this pack's four skills could only be reached by an
    // AI planner. A variable name is the one argument, and it is matched as
    // an UPPER_SNAKE token rather than free text so that "remove the FOO
    // environment variable" cannot be read as a request to delete a file.

    {
      name: 'environmentVariable',
      order: -6.53,
      pathSafe: true,
      questionSafe: ['env-get'],
      test(_lower, raw) {
        const NAME = '([A-Za-z_][A-Za-z0-9_]*)';

        const get = raw.match(
          new RegExp(`^\\s*what(?:'s| is)\\s+(?:my\\s+|the\\s+)?${NAME}\\s+set\\s+to\\s*[?.!]*$`, 'i'),
        );
        if (get?.[1]) return plan(step('environment.get', { name: get[1] }), 'env-get');

        // System-wide first: it is the narrower phrasing, and the per-user
        // rule below would otherwise claim it and quietly change the wrong
        // scope — the one mistake in this pack that needs an admin to undo.
        const delSystem = raw.match(
          new RegExp(
            `^\\s*(?:remove|delete|unset)\\s+the\\s+system\\s+environment\\s+variable\\s+${NAME}(?:\\s+for\\s+(?:every|all)\\s+users?)?\\s*[?.!]*$`,
            'i',
          ),
        );
        if (delSystem?.[1]) {
          return plan(step('environment.deleteSystem', { name: delSystem[1] }), 'env-delete-system');
        }

        const del = raw.match(
          new RegExp(
            `^\\s*(?:remove|delete|unset)\\s+(?:my\\s+|the\\s+)?${NAME}\\s+environment\\s+variable\\s*[?.!]*$`,
            'i',
          ),
        );
        if (del?.[1]) return plan(step('environment.delete', { name: del[1] }), 'env-delete');

        const set = raw.match(
          new RegExp(`^\\s*set\\s+(?:my\\s+|the\\s+)?${NAME}\\s+to\\s+(.+?)\\s*[?.!]*$`, 'i'),
        );
        if (set?.[1] && set[2]) {
          // An all-caps name is what tells this apart from "set the search
          // field in the notepad window to hello", which is a UIA sentence.
          if (set[1] !== set[1].toUpperCase()) return null;
          return plan(
            step('environment.set', { name: set[1], value: stripQuotes(set[2].trim()) }),
            'env-set',
          );
        }
        return null;
      },
    },

    // ---- operating another app's controls -----------------------------------
    //
    // These were the whole `uia.*` pack's only route once the AI planner was
    // ruled out, and there wasn't one: every skill here advertised an example
    // naming a control ("the save button"), the skills only accepted the
    // numeric path `uia.tree` prints, and no grammar rule matched either. The
    // skills now take a `control` name; these are the sentences that reach it.
    //
    // "in the <name> window" is the shared tail. It stays required rather than
    // defaulting to the foreground window: acting on whatever happens to be in
    // front, when the sentence did not say so, is the kind of guess that types
    // into the wrong application. (Atlas's own window is foreground the
    // instant a command arrives, which is exactly why "the foreground
    // window" was never the answer here.)
    //
    // `uiaInvokeNoWindow`, just below, is the one exception, and only for the
    // family of rules that click rather than type: when no window is named
    // *and* there is exactly one other window open, that is the only
    // reasonable target and asking "which window?" would be theatre. Two or
    // more candidates still gets the same disambiguation card `targetWindowId`
    // already shows for an ambiguous named query — never a guess.

    {
      name: 'uiaTree',
      order: -6.59,
      questionSafe: ['uia-tree'],
      test(lower) {
        const m =
          lower.match(/^\s*(?:inspect|examine)\s+(?:the\s+)?(.+?)\s+window\s*[?.!]*$/) ??
          lower.match(
            /^\s*what\s+controls\s+(?:does|has)\s+(?:the\s+)?(.+?)\s+window\s+(?:have|got)\s*[?.!]*$/,
          ) ??
          lower.match(/^\s*(?:list|show)\s+(?:the\s+)?controls\s+in\s+(?:the\s+)?(.+?)\s+window\s*[?.!]*$/);
        if (!m?.[1]) return null;
        return plan(step('uia.tree', { window: m[1].trim() }), 'uia-tree');
      },
    },

    {
      name: 'uiaFocusedElement',
      order: -6.58,
      questionSafe: ['uia-focused'],
      test(lower) {
        if (!/^\s*what\s+(?:control|element|field)\s+(?:has|is\s+in)\s+focus(?:ed)?\s*[?.!]*$/.test(lower)) {
          return null;
        }
        return plan(step('uia.focusedElement', {}), 'uia-focused');
      },
    },

    {
      name: 'uiaTypeIntoControl',
      order: -6.575,
      test(_lower, raw) {
        // Before `uiaInvoke`, because "type X into Y" also begins with a verb
        // that rule's "activate the … " shape would otherwise not claim — and
        // before `typeText`, whose bare `type "…"` would swallow the whole
        // line including the destination.
        const m = raw.match(
          /^\s*type\s+(["'“].+?["'”])\s+(?:in|into)\s+(?:the\s+)?(.+?)\s+in\s+(?:the\s+)?(.+?)\s+window\s*[?.!]*$/i,
        );
        if (!m) return null;
        return plan(
          step('uia.typeInto', {
            window: m[3]!.trim(),
            control: m[2]!.trim(),
            text: stripQuotes(m[1]!),
          }),
          'uia-type-into',
        );
      },
    },

    {
      name: 'uiaSetValue',
      order: -6.57,
      test(_lower, raw) {
        const m = raw.match(
          /^\s*set\s+(?:the\s+)?(.+?)\s+in\s+(?:the\s+)?(.+?)\s+window\s+to\s+(.+?)\s*[?.!]*$/i,
        );
        if (!m) return null;
        return plan(
          step('uia.setValue', {
            window: m[2]!.trim(),
            control: m[1]!.trim(),
            value: stripQuotes(m[3]!.trim()),
          }),
          'uia-set-value',
        );
      },
    },

    {
      name: 'uiaInvokeOrExpand',
      order: -6.56,
      test(lower) {
        const m = lower.match(
          /^\s*(activate|press|push|toggle|select|expand|collapse|click)\s+(?:on\s+)?(?:the\s+)?(.+?)\s+in\s+(?:the\s+)?(.+?)\s+window\s*[?.!]*$/,
        );
        if (!m) return null;
        const args = { window: m[3]!.trim(), control: m[2]!.trim() };
        return planUiaVerb(m[1]!, args);
      },
    },

    // "click play", "press the save button", "toggle mute" — the shape above
    // minus the window clause. Reaches `uia.invoke`/`expand`/`collapse` with
    // no `window` argument at all; the skill itself decides from there
    // (`targetWindowId` in `uia-skills.ts`) — act on the one other window
    // open, or ask which one when there's more than one. Ordered right after
    // `uiaInvokeOrExpand` so an explicit "... in the X window" is always
    // claimed by that rule first; this one only ever sees a sentence that
    // rule's own regex already declined.
    {
      name: 'uiaInvokeNoWindow',
      order: -6.555,
      test(lower) {
        const m = lower.match(
          /^\s*(activate|press|push|toggle|select|expand|collapse|click)\s+(?:on\s+)?(?:the\s+)?(.+?)\s*[?.!]*$/,
        );
        if (!m?.[2]) return null;
        const args = { control: m[2]!.trim() };
        return planUiaVerb(m[1]!, args, 0.8);
      },
    },

    // ---- screen -------------------------------------------------------------

    {
      name: 'screenCapture',
      order: -6.64,
      questionSafe: ['displays'],
      test(lower) {
        if (
          /^\s*(?:take\s+a\s+)?screenshot\s*[?.!]*$/.test(lower) ||
          /^\s*capture\s+(?:the\s+)?screen\s*[?.!]*$/.test(lower)
        ) {
          return plan(step('screen.capture', {}), 'screenshot');
        }
        if (/\b(?:what|which)\s+(?:monitors?|displays?)\b.*\b(?:have|connected|do i have)\b/.test(lower) ||
          /^\s*(?:list|show)\s+(?:me\s+)?(?:my\s+)?(?:monitors?|displays?)\s*[?.!]*$/.test(lower)) {
          return plan(step('screen.listDisplays', {}), 'displays');
        }
        return null;
      },
    },
  ];
}
