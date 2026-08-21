/**
 * Deterministic phrasings for the shipped skill pack.
 *
 * These are the sentences people actually type at a desktop assistant. Each
 * one recognised here is a network round trip that never happens and a wrong
 * answer that can't occur.
 *
 * Ordering is the whole craft. The rules are arranged most-specific first,
 * because a generic "open X" rule will happily eat "open my downloads folder"
 * and turn it into an application launch. Where a rule could plausibly claim
 * something that isn't its business, it declines instead — a declined rule
 * costs one more comparison, while a wrong claim costs the user their trust.
 */

import type { GrammarRule } from './grammar';
import { plan, step } from './grammar';
import type { WorkingMemory } from '../working-memory';
import { splitBrowserHint } from '../text/normalize';
import { resolveSite } from '../text/sites';

/** Strip filler so "open up the calculator please" leaves "calculator". */
function clean(s: string): string {
  return s
    .replace(/\b(please|for me|now|app|application|program)\b/gi, ' ')
    .replace(/^\s*(up|the|a|an|my)\s+/i, '')
    .replace(/[?!.]+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Words that mean "the thing we were just talking about", not a name. */
const REFERENTIAL = /^(it|that|this|them|those|the (first|second|third|last) one|one)$/i;

/** Nouns that make a request about files rather than applications. */
const FILE_NOUN =
  /\b(file|files|document|documents|pdf|photo|photos|picture|pictures|image|images|video|videos|screenshot|screenshots|folder|folders|spreadsheet|invoice|invoices|note|notes|report|resume|cv|download|downloads)\b/i;

/**
 * The same set, for removing *every* file noun rather than testing for one.
 *
 * A separate constant because a `/g` regex carries `lastIndex` between calls,
 * and sharing one instance between a `.test()` and a `.replace()` makes the
 * test skip matches on every other call — a bug that looks like the grammar
 * being intermittently wrong.
 */
const FILE_NOUNS_GLOBAL = new RegExp(FILE_NOUN.source, 'gi');

/** A Windows drive path, a UNC path, or a POSIX absolute path, at the start of a string. */
const ABS_PATH_START = /^(?:[a-z]:[\\/]|\\\\|~?\/)/i;

function stripQuotes(s: string): string {
  return s.trim().replace(/^["']|["']$/g, '');
}

export function createCoreGrammar(working: WorkingMemory): GrammarRule[] {
  return [
    // --- Find files ---------------------------------------------------------
    // Before the generic open rule: "find my tax pdf" is unambiguous, and
    // letting an app-launch rule see it first would be a mistake.
    {
      name: 'filesFind',
      order: -10,
      pathSafe: false,
      test(_lower, raw) {
        const m = raw.match(
          /^\s*(?:find|search for|look for|where (?:is|are)|show me)\s+(?:my\s+|the\s+|all\s+)?(.+?)\s*[?.!]*$/i,
        );
        const captured = m?.[1];
        if (!captured) return null;

        const target = clean(captured);
        if (!target || REFERENTIAL.test(target)) return null;
        if (!FILE_NOUN.test(target)) return null;

        const kind = detectKind(target);
        // Drop the type word from the query — searching for the literal string
        // "pdf" inside file *names* finds far less than searching "tax" does.
        const query = target.replace(FILE_NOUN, '').replace(/\s+/g, ' ').trim() || target;
        return plan(step('files.find', kind ? { query, kind } : { query }), 'find-files');
      },
    },

    // --- Open a path directly -----------------------------------------------
    // The only path-safe rule. A concrete path is unambiguous, so it wins
    // outright — and because it's the only rule allowed to run when a path is
    // present, no keyword rule can hijack the English words inside a filename.
    {
      name: 'openPath',
      order: -9,
      pathSafe: true,
      test(_lower, raw) {
        const captured = raw.match(/^\s*(?:open|show|reveal)\s+(.+?)\s*$/i)?.[1];
        if (!captured) return null;
        const target = captured.trim().replace(/^["']|["']$/g, '');
        if (!/(?:^[a-z]:[\\/]|^\\\\|^~?\/)/i.test(target)) return null;
        return plan(
          step(/reveal/i.test(raw) ? 'files.reveal' : 'files.open', { path: target }),
          'open-path',
        );
      },
    },

    // --- Remember an alias ----------------------------------------------------
    // "remember my work folder is D:\Dev" — teaches a name Atlas didn't ship
    // with. Ordered early: nothing else in the grammar starts with "remember",
    // so there's no rule to lose a race against.
    {
      name: 'rememberAlias',
      order: -9.5,
      // The value being remembered is very often a literal path ("...is
      // D:\Dev"), which would otherwise make the path guard skip this rule
      // entirely. The "remember my X is Y" shape is specific enough that it
      // won't misfire on an unrelated path-bearing sentence.
      pathSafe: true,
      test(_lower, raw) {
        const m = raw.match(/^\s*remember\s+(?:that\s+)?my\s+(.+?)\s+is\s+(.+?)\s*[?.!]*$/i);
        const subject = m?.[1];
        const value = m?.[2];
        if (!subject || !value) return null;
        return plan(
          step('memory.remember', { subject: subject.trim(), value: value.trim() }),
          'remember-alias',
        );
      },
    },

    // --- Open a URL ----------------------------------------------------------
    {
      // A bare "name.tld" is deliberately NOT claimed here. "open steelseries.gg"
      // names an application on the machine that said it; "open github.com"
      // names a website. Only the layer that can see the installed apps can
      // tell those apart, so anything without a scheme, a path or a "www." is
      // left to `app.open`, which opens the address itself when no app matches.
      name: 'openUrl',
      order: -8,
      test(_lower, raw) {
        const captured = raw.match(
          /^\s*(?:open|go to|visit|browse)\s+(https?:\/\/\S+|www\.[\w-]+\.[a-z]{2,}\S*|[\w-]+\.[a-z]{2,}\/\S*)\s*$/i,
        )?.[1];
        if (!captured) return null;
        const url = captured.startsWith('http') ? captured : `https://${captured}`;
        return plan(step('web.open', { url }), 'open-url');
      },
    },

    // --- Colour conversion ---------------------------------------------------
    // Ahead of unitConvert, which also owns the word "convert" but expects a
    // number and two unit names — "#7c5cff to rgb" would make it decline, and
    // a declined rule is a rule that never got to answer.
    {
      name: 'colorConvert',
      order: -7.55,
      questionSafe: ['color'],
      test(_lower, raw) {
        const captured = raw.match(
          /^\s*(?:what(?:'s| is)\s+|convert\s+)?(#[0-9a-f]{3,6}|rgba?\([^)]*\))(?:\s+(?:to|in|as)\s+(?:hex|rgb|hsl))?\s*[?.!]*$/i,
        )?.[1];
        if (!captured) return null;
        return plan(step('util.color', { color: captured }), 'color');
      },
    },

    // --- Percentages ---------------------------------------------------------
    // Before mathCalculate: "15% of 240" has letters in it, so the calculator
    // declines it, and without this rule the whole phrasing would fall through
    // to the model for arithmetic a regex can do exactly.
    {
      name: 'mathPercent',
      order: -7.52,
      questionSafe: ['percent'],
      test(_lower, raw) {
        const of = raw.match(
          /^\s*(?:what(?:'s| is)\s+)?([\d.]+)\s*(?:%|percent)\s+of\s+([\d.,]+)\s*[?.!]*$/i,
        );
        if (of) {
          return plan(
            step('math.percent', {
              a: Number(of[1]),
              b: Number(String(of[2]).replace(/,/g, '')),
              mode: 'of',
            }),
            'percent',
          );
        }

        const is = raw.match(
          /^\s*([\d.]+)\s+is\s+what\s+(?:%|percent)\s+of\s+([\d.,]+)\s*[?.!]*$/i,
        );
        if (is) {
          return plan(
            step('math.percent', {
              a: Number(is[1]),
              b: Number(String(is[2]).replace(/,/g, '')),
              mode: 'is',
            }),
            'percent',
          );
        }

        const change = raw.match(
          /^\s*(?:what(?:'s| is)\s+the\s+)?(?:%|percent(?:age)?)\s*(?:change|difference|increase|decrease)?\s+from\s+([\d.,]+)\s+to\s+([\d.,]+)\s*[?.!]*$/i,
        );
        if (change) {
          return plan(
            step('math.percent', {
              a: Number(String(change[1]).replace(/,/g, '')),
              b: Number(String(change[2]).replace(/,/g, '')),
              mode: 'change',
            }),
            'percent',
          );
        }
        return null;
      },
    },

    // --- Average -------------------------------------------------------------
    {
      name: 'mathAverage',
      order: -7.51,
      questionSafe: ['average'],
      test(_lower, raw) {
        const captured = raw.match(
          /^\s*(?:what(?:'s| is)\s+the\s+)?(?:average|mean)\s+of\s+(.+?)\s*[?.!]*$/i,
        )?.[1];
        if (!captured) return null;
        // Only claim it when it really is a list of numbers: "the average of
        // the group" is a question about words, not a calculation.
        if (!/\d/.test(captured) || /[a-z]{3,}/i.test(captured.replace(/\band\b/gi, '')))
          return null;
        return plan(step('math.average', { numbers: captured }), 'average');
      },
    },

    // --- Time somewhere else --------------------------------------------------
    // Must precede timeNow, which answers "what time is it" and would happily
    // ignore the "in Tokyo" that makes it a different question.
    {
      name: 'timeInZone',
      order: -7.32,
      questionSafe: ['time-zone'],
      test(_lower, raw) {
        const captured = raw.match(
          /^\s*(?:what(?:'s| is)\s+the\s+time|what time is it|time)\s+in\s+([a-z .'\-/_]+?)\s*[?.!]*$/i,
        )?.[1];
        if (!captured) return null;
        return plan(step('time.inZone', { place: captured.trim() }), 'time-zone');
      },
    },

    // --- Days until -----------------------------------------------------------
    {
      name: 'timeUntil',
      order: -7.31,
      questionSafe: ['days-until'],
      test(_lower, raw) {
        const captured = raw.match(
          /^\s*(?:how many days (?:are there )?(?:un)?til|how long (?:un)?til|days (?:un)?til|countdown to)\s+(?:the\s+)?(.+?)\s*[?.!]*$/i,
        )?.[1];
        if (!captured) return null;
        return plan(step('time.until', { occasion: captured.trim() }), 'days-until');
      },
    },

    // --- Set a timer ----------------------------------------------------------
    {
      name: 'timeTimer',
      order: -7.28,
      test(_lower, raw) {
        const m =
          raw.match(
            /^\s*(?:set|start)\s+(?:a\s+|an\s+)?timer\s+(?:for\s+)?(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b(?:\s+(?:to|for)\s+(.+?))?\s*[?.!]*$/i,
          ) ??
          raw.match(
            /^\s*remind me in\s+(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b(?:\s+(?:to|about)\s+(.+?))?\s*[?.!]*$/i,
          );
        if (!m) return null;

        const amount = Number(m[1]);
        const unit = String(m[2]).toLowerCase();
        const perUnit = /^(h|hr|hrs|hour|hours)$/.test(unit)
          ? 3600
          : /^(s|sec|secs|second|seconds)$/.test(unit)
            ? 1
            : 60;
        const label = m[3]?.trim();
        return plan(
          step(
            'time.timer',
            label ? { seconds: amount * perUnit, label } : { seconds: amount * perUnit },
          ),
          'timer',
        );
      },
    },

    // --- Generators -----------------------------------------------------------
    {
      name: 'utilPassword',
      order: -7.2,
      test(_lower, raw) {
        // Two optional numbers, and they mean different things: the bare one is
        // how many passwords, the one attached to "character" is how long each
        // is. Backtracking sorts out "generate 20 character passwords", where
        // the first group would otherwise swallow the length.
        const m = raw.match(
          /^\s*(?:generate|create|make|give me|new)\s+(?:me\s+)?(?:a\s+|an\s+)?(?:new\s+)?(?:(\d+)\s+)?(?:(\d+)[\s-]*(?:character|char)s?\s+)?(?:strong\s+|secure\s+|random\s+)?passwords?\s*[?.!]*$/i,
        );
        if (!m) return null;
        const args: { length?: number; count?: number } = {};
        if (m[1]) args.count = Number(m[1]);
        if (m[2]) args.length = Number(m[2]);
        return plan(step('util.password', args), 'password');
      },
    },

    {
      name: 'utilUuid',
      order: -7.19,
      test(lower) {
        if (
          /^\s*(?:generate|create|make|give me|new)\s+(?:me\s+)?(?:a\s+|an\s+)?(?:new\s+)?(uuid|guid)\s*[?.!]*$/.test(
            lower,
          )
        ) {
          return plan(step('util.uuid', {}), 'uuid');
        }
        return null;
      },
    },

    {
      name: 'utilRandom',
      order: -7.18,
      questionSafe: ['random'],
      test(_lower, raw) {
        const m = raw.match(
          /\b(?:random number|pick a number|random)\b[^\d]*(\d+)\s*(?:and|to|-|–)\s*(\d+)\s*[?.!]*$/i,
        );
        if (m) {
          return plan(step('util.random', { min: Number(m[1]), max: Number(m[2]) }), 'random');
        }
        if (/^\s*(?:give me\s+)?(?:a\s+)?random number\s*[?.!]*$/i.test(raw)) {
          return plan(step('util.random', {}), 'random');
        }
        return null;
      },
    },

    {
      name: 'utilCoin',
      order: -7.17,
      test(lower) {
        if (
          /\b(?:flip|toss)\s+(?:a\s+|the\s+)?coin\b/.test(lower) ||
          /^\s*coin flip\s*[?.!]*$/.test(lower)
        ) {
          return plan(step('util.coin', {}), 'coin');
        }
        return null;
      },
    },

    {
      name: 'utilDice',
      order: -7.16,
      test(_lower, raw) {
        const notation = raw.match(/\broll\s+(?:a\s+|the\s+)?(\d*)d(\d+)\b/i);
        if (notation) {
          return plan(
            step('util.dice', { count: Number(notation[1] || 1), sides: Number(notation[2]) }),
            'dice',
          );
        }
        if (/\broll\s+(?:a\s+|the\s+|some\s+)?(?:dice|die|d6)\b/i.test(raw)) {
          return plan(step('util.dice', {}), 'dice');
        }
        return null;
      },
    },

    // --- Base64 ---------------------------------------------------------------
    {
      name: 'utilBase64',
      order: -7.15,
      test(_lower, raw) {
        const m =
          raw.match(/^\s*(encode|decode)\s+(.+?)\s+(?:to|from|in|as|into)\s+base ?64\s*[?.!]*$/i) ??
          raw.match(/^\s*base ?64\s+(encode|decode)\s+(.+?)\s*[?.!]*$/i);
        if (!m) return null;
        const mode = String(m[1]).toLowerCase();
        return plan(step('util.base64', { text: stripQuotes(String(m[2])), mode }), 'base64');
      },
    },

    // --- Counting and casing --------------------------------------------------
    {
      name: 'textCount',
      order: -7.14,
      questionSafe: ['text-count'],
      test(_lower, raw) {
        const asked = raw.match(
          /^\s*(?:how many (?:words|characters|chars|letters) (?:are )?in|count the words in|word count (?:of|for))\s+(.+?)\s*[?.!]*$/i,
        )?.[1];
        if (!asked) return null;
        const text = stripQuotes(asked);
        // Quoted text is the unambiguous case; unquoted, this rule would claim
        // "how many words in the English language", which isn't a count.
        if (text === asked.trim()) return null;
        return plan(step('text.count', { text }), 'text-count');
      },
    },

    {
      name: 'textCase',
      order: -7.13,
      test(_lower, raw) {
        const leading = raw.match(
          /^\s*(?:make\s+(?:it\s+)?)?(uppercase|upper case|lowercase|lower case|title case|sentence case)\s+(.+?)\s*[?.!]*$/i,
        );
        const trailing = raw.match(
          /^\s*(?:convert\s+|change\s+)?(.+?)\s+to\s+(uppercase|upper case|lowercase|lower case|title case|sentence case)\s*[?.!]*$/i,
        );
        const rawStyle = leading?.[1] ?? trailing?.[2];
        const rawText = leading?.[2] ?? trailing?.[1];
        if (!rawStyle || !rawText) return null;

        const text = stripQuotes(rawText);
        if (text === rawText.trim()) return null; // quoted text only — see textCount
        const style = String(rawStyle).toLowerCase().replace(/\s+/g, '').replace('case', '');
        return plan(step('text.case', { text, style }), 'text-case');
      },
    },

    // --- Calculate -------------------------------------------------------------
    // A guarded rule: it only claims the captured text if every character in
    // it is arithmetic. That's what stops "what is the capital of Peru?" from
    // being wrongly swallowed by the "what is X" phrasing this also matches.
    {
      name: 'mathCalculate',
      order: -7.5,
      questionSafe: ['calculate'],
      test(_lower, raw) {
        const captured = raw.match(
          /^\s*(?:what(?:'s| is)|calculate|calc|compute)\s+(.+?)\s*[?]*$/i,
        )?.[1];
        if (!captured) return null;
        if (!/^[\d\s+\-*/^().%]+$/.test(captured)) return null;
        return plan(step('math.calculate', { expression: captured }), 'calculate');
      },
    },

    // --- Convert units -----------------------------------------------------------
    {
      name: 'unitConvert',
      order: -7.4,
      questionSafe: ['convert'],
      test(_lower, raw) {
        const convertMatch = raw.match(
          /^\s*convert\s+([\d.]+)\s*([a-z°]+)\s+(?:to|into)\s+([a-z°]+)\s*[?.!]*$/i,
        );
        if (convertMatch) {
          const [, rawValue, from, to] = convertMatch;
          if (!rawValue || !from || !to) return null;
          const value = Number(rawValue);
          if (!Number.isFinite(value)) return null;
          return plan(step('math.convert', { value, from, to }), 'convert');
        }
        const howManyMatch = raw.match(
          /^\s*how many\s+([a-z°]+)\s+(?:is|are|in)\s+([\d.]+)\s*([a-z°]+)\s*[?.!]*$/i,
        );
        if (howManyMatch) {
          const [, to, rawValue, from] = howManyMatch;
          if (!to || !rawValue || !from) return null;
          const value = Number(rawValue);
          if (!Number.isFinite(value)) return null;
          return plan(step('math.convert', { value, from, to }), 'convert');
        }
        return null;
      },
    },

    // --- Help ------------------------------------------------------------------
    // "What can you do?" is a question, so it needs questionSafe — otherwise
    // the grammar declines it on principle before this rule ever gets a look.
    {
      name: 'engineHelp',
      order: -7.35,
      questionSafe: ['help'],
      test(lower) {
        if (
          /^\s*help\s*[?.!]*$/.test(lower) ||
          /\bwhat (?:can|do) you do\b/.test(lower) ||
          /\bwhat are your (?:skills|capabilities|actions|commands)\b/.test(lower)
        ) {
          return plan(step('engine.help', {}), 'help');
        }
        return null;
      },
    },

    // --- Time and date -----------------------------------------------------------
    {
      name: 'timeNow',
      order: -7.3,
      questionSafe: ['time'],
      test(lower) {
        if (
          /\b(what(?:'s| is) the time|what time is it|what(?:'s| is) the date|what day is it|what(?:'s| is) today'?s date)\b/.test(
            lower,
          )
        ) {
          return plan(step('time.now', {}), 'time');
        }
        return null;
      },
    },

    // --- System --------------------------------------------------------------
    {
      name: 'systemInfo',
      order: -7,
      questionSafe: ['system'],
      test(lower) {
        if (
          /\b(system|machine|computer|pc)\s+(status|info|information|stats)\b/.test(lower) ||
          /\bhow (?:much|many)\s+(?:ram|memory|disk|space|cpu)\b/.test(lower) ||
          /\b(cpu|memory|ram|disk|battery)\s+(usage|status|level)\b/.test(lower)
        ) {
          return plan(step('system.info', {}), 'system');
        }
        return null;
      },
    },

    // --- What's running --------------------------------------------------------
    {
      name: 'systemProcesses',
      order: -6.9,
      questionSafe: ['processes'],
      test(lower) {
        if (
          /\bwhat(?:'s| is)\s+running\b/.test(lower) ||
          /\b(?:show|list)\s+(?:me\s+)?(?:my\s+|the\s+|all\s+)?(?:running\s+)?(?:processes|tasks)\b/.test(
            lower,
          ) ||
          /\bwhat(?:'s| is)\s+(?:using|eating|hogging)\s+(?:my\s+)?(?:memory|ram|cpu)\b/.test(lower)
        ) {
          return plan(step('system.processes', {}), 'processes');
        }
        return null;
      },
    },

    // --- The clipboard ---------------------------------------------------------
    {
      name: 'clipboardRead',
      order: -4.1,
      questionSafe: ['clipboard-read'],
      test(lower) {
        if (
          /\bwhat(?:'s| is)\s+(?:on|in)\s+(?:my\s+|the\s+)?clipboard\b/.test(lower) ||
          /^\s*(?:show|read)\s+(?:me\s+)?(?:my\s+|the\s+)?clipboard\s*[?.!]*$/.test(lower)
        ) {
          return plan(step('clipboard.read', {}), 'clipboard-read');
        }
        return null;
      },
    },

    // --- Notifications ---------------------------------------------------------
    {
      name: 'notifySend',
      order: -4.05,
      test(_lower, raw) {
        const captured = raw.match(
          /^\s*(?:send|show|post)?\s*(?:me\s+)?(?:a\s+)?notif(?:y|ication)?\s*(?:me\s+)?(?:saying|that says|with|:)?\s*["“](.+?)["”]\s*[?.!]*$/i,
        )?.[1];
        if (!captured) return null;
        return plan(step('notify.send', { message: captured }), 'notify');
      },
    },

    // --- Memory ----------------------------------------------------------------
    {
      name: 'memoryList',
      order: -4.02,
      questionSafe: ['memory-list'],
      test(lower) {
        if (
          /\bwhat do you remember\b/.test(lower) ||
          /^\s*(?:list|show)\s+(?:me\s+)?(?:what you remember|your memory|my aliases)\s*[?.!]*$/.test(
            lower,
          )
        ) {
          return plan(step('memory.list', {}), 'memory-list');
        }
        return null;
      },
    },

    {
      name: 'memoryForget',
      order: -4.01,
      test(_lower, raw) {
        const captured = raw.match(/^\s*forget\s+(?:that\s+)?my\s+(.+?)\s*[?.!]*$/i)?.[1];
        if (!captured) return null;
        return plan(step('memory.forget', { subject: captured.trim() }), 'forget');
      },
    },

    // --- Web shortcuts ----------------------------------------------------------
    // All ahead of appOpen, which would read "open a browser" as the name of an
    // application and go looking for one called "browser".
    {
      name: 'webOpenBrowser',
      order: -3.5,
      test(_lower, raw) {
        const m = raw.match(
          /^\s*(?:open|launch|start)\s+(?:up\s+)?(?:my\s+|a\s+|an\s+|any\s+|the\s+)?(?:web\s+)?browser\s*[?.!]*$/i,
        );
        if (!m) return null;
        return plan(step('web.openBrowser', {}), 'open-browser');
      },
    },

    {
      // Ahead of filesFind, whose noun list quite rightly contains "images" —
      // "find images of red pandas" is a search of the web, and "find my
      // images" is a search of the disk. The possessive is the tell, so this
      // rule declines anything owned ("pictures of my wedding") and lets the
      // file rule have it.
      name: 'webImages',
      order: -10.5,
      test(_lower, raw) {
        const captured = raw.match(
          /^\s*(?:find|search(?:\s+for)?|show me|google)\s+(?:some\s+)?(?:images|pictures|photos|pics)\s+(?:of|for)\s+(.+?)\s*[?.!]*$/i,
        )?.[1];
        if (!captured) return null;
        if (/^(?:my|our|his|her|their)\b/i.test(captured.trim())) return null;
        return plan(step('web.searchImages', { query: captured.trim() }), 'images');
      },
    },

    {
      name: 'webMaps',
      order: -3.48,
      test(_lower, raw) {
        const directions = raw.match(/^\s*(?:get\s+)?directions\s+to\s+(.+?)\s*[?.!]*$/i)?.[1];
        if (directions) {
          return plan(
            step('web.searchMaps', { place: directions.trim(), directions: true }),
            'maps',
          );
        }
        const place = raw.match(
          /^\s*(?:show me\s+|open\s+)?(?:a\s+)?maps?\s+(?:of|for)\s+(.+?)\s*[?.!]*$/i,
        )?.[1];
        if (!place) return null;
        return plan(step('web.searchMaps', { place: place.trim() }), 'maps');
      },
    },

    {
      name: 'webWikipedia',
      order: -3.47,
      test(_lower, raw) {
        const captured =
          raw.match(/^\s*(?:wikipedia|wiki)\s+(.+?)\s*[?.!]*$/i)?.[1] ??
          raw.match(/^\s*look up\s+(.+?)\s+on\s+wikipedia\s*[?.!]*$/i)?.[1];
        if (!captured) return null;
        return plan(step('web.searchWikipedia', { query: captured.trim() }), 'wikipedia');
      },
    },

    // --- Open a system tool ------------------------------------------------------
    // Before appList and well before appOpen: "task manager" isn't the name of
    // an installed application, and the generic open-app rule would otherwise
    // dutifully fail to find one called that.
    {
      name: 'systemToolOpen',
      order: -6.5,
      test(lower) {
        if (/\btask manager\b/.test(lower)) {
          return plan(step('system.openTool', { tool: 'task-manager' }), 'system-tool');
        }
        if (/\bdevice manager\b/.test(lower)) {
          return plan(step('system.openTool', { tool: 'device-manager' }), 'system-tool');
        }
        // Deliberately not bare "settings" — that's ambiguous with Atlas's own
        // Settings screen, already one click away in the title bar.
        if (/\b(?:windows|system) settings\b/.test(lower)) {
          return plan(step('system.openTool', { tool: 'windows-settings' }), 'system-tool');
        }
        if (/\bcontrol panel\b/.test(lower)) {
          return plan(step('system.openTool', { tool: 'control-panel' }), 'system-tool');
        }
        // The shells, and the reason this rule has to run this early: "File
        // Explorer" contains the word "file", so the file rules below claimed
        // it long before the app rules got a look — which is how asking for
        // the file manager produced an offer to teach Atlas what "File
        // Explorer" means.
        //
        // Unlike the utilities above, these three require an opening verb.
        // "task manager" names one thing and nothing else, but "my computer"
        // is a phrase that turns up in sentences about the machine rather than
        // about the folder — "restart my computer" being the one that caught
        // this, and it is a bad sentence to get wrong.
        const opening = /\b(?:open|show|launch|start|bring up|go to)\b/.test(lower);
        if (opening && /\b(?:file explorer|windows explorer|explorer)\b/.test(lower)) {
          return plan(step('system.openTool', { tool: 'file-explorer' }), 'system-tool');
        }
        if (opening && /\b(?:this pc|my computer)\b/.test(lower)) {
          return plan(step('system.openTool', { tool: 'this-pc' }), 'system-tool');
        }
        // Opening the bin only. Emptying it is `system.emptyRecycleBin`, which
        // is still confirm-gated — that one does not come back.
        if (
          opening &&
          /\brecycle bin\b/.test(lower) &&
          !/\b(?:empty|clear|delete)\b/.test(lower)
        ) {
          return plan(step('system.openTool', { tool: 'recycle-bin' }), 'system-tool');
        }
        return null;
      },
    },

    // --- List apps ------------------------------------------------------------
    {
      name: 'appList',
      order: -6,
      questionSafe: ['app-list'],
      test(lower) {
        if (
          /\b(what|which)\s+(apps?|applications?|programs?)\b.*\b(installed|do i have|are there)\b/.test(
            lower,
          ) ||
          /\b(list|show)\s+(?:my\s+|all\s+)?(apps?|applications?|programs?)\b/.test(lower)
        ) {
          return plan(step('app.list', {}), 'app-list');
        }
        return null;
      },
    },

    // --- Hide Atlas ------------------------------------------------------------
    {
      name: 'atlasHide',
      order: -5,
      test(lower) {
        if (
          /^\s*(?:hide|dismiss|close|go away|never ?mind)\s*(?:atlas|yourself|this)?\s*[?.!]*$/.test(
            lower,
          )
        ) {
          return plan(step('atlas.hide', {}), 'atlas');
        }
        return null;
      },
    },

    // --- Copy ------------------------------------------------------------------
    {
      name: 'clipboardCopy',
      order: -4,
      test(_lower, raw) {
        const text = raw.match(/^\s*copy\s+(?:this\s+)?["“](.+?)["”]\s*$/i)?.[1];
        if (!text) return null;
        return plan(step('clipboard.copy', { text }), 'clipboard');
      },
    },

    // --- File and folder operations -----------------------------------------
    // Path-safe and, unlike most rules here, only claim phrasings with an
    // *explicit absolute path* in them. "create a folder called Projects in
    // my documents" needs alias resolution this layer can't do (no Platform
    // access) — that's real, separate work, not a one-line addition.

    {
      name: 'fileCreate',
      order: -3.9,
      pathSafe: true,
      test(_lower, raw) {
        const captured = raw.match(
          /^\s*(?:create|make)\s+(?:a\s+|an\s+)?(?:new\s+)?file\s+(?:at|called|named)\s+(.+?)\s*[?.!]*$/i,
        )?.[1];
        if (!captured) return null;
        const path = stripQuotes(captured);
        if (!ABS_PATH_START.test(path)) return null;
        return plan(step('files.create', { path }), 'create-file');
      },
    },

    {
      name: 'folderCreate',
      order: -3.8,
      pathSafe: true,
      test(_lower, raw) {
        const captured = raw.match(
          /^\s*(?:create|make)\s+(?:a\s+|an\s+)?(?:new\s+)?(?:folder|directory)\s+(?:at|called|named)\s+(.+?)\s*[?.!]*$/i,
        )?.[1];
        if (!captured) return null;
        const path = stripQuotes(captured);
        if (!ABS_PATH_START.test(path)) return null;
        return plan(step('files.createFolder', { path }), 'create-folder');
      },
    },

    {
      name: 'fileRename',
      order: -3.7,
      pathSafe: true,
      test(_lower, raw) {
        const m = raw.match(/^\s*rename\s+(.+?)\s+to\s+(.+?)\s*[?.!]*$/i);
        const rawPath = m?.[1];
        const rawNewName = m?.[2];
        if (!rawPath || !rawNewName) return null;
        const path = stripQuotes(rawPath);
        const newName = stripQuotes(rawNewName);
        if (!ABS_PATH_START.test(path)) return null;
        if (/[\\/]/.test(newName)) return null; // a bare name, not another path
        return plan(step('files.rename', { path, newName }), 'rename-file');
      },
    },

    {
      name: 'fileMove',
      order: -3.6,
      pathSafe: true,
      test(_lower, raw) {
        const m = raw.match(/^\s*move\s+(.+?)\s+to\s+(.+?)\s*[?.!]*$/i);
        const rawPath = m?.[1];
        const rawDest = m?.[2];
        if (!rawPath || !rawDest) return null;
        const path = stripQuotes(rawPath);
        const destDir = stripQuotes(rawDest);
        if (!ABS_PATH_START.test(path) || !ABS_PATH_START.test(destDir)) return null;
        return plan(step('files.move', { path, destDir }), 'move-file');
      },
    },

    {
      name: 'fileCopy',
      order: -3.5,
      pathSafe: true,
      test(_lower, raw) {
        // Quoted text ("copy "hello"") belongs to `clipboardCopy`, which
        // already had its turn (order -4, before this rule) — anything that
        // reaches here without quotes was never going to match that rule.
        const m = raw.match(/^\s*copy\s+(.+?)\s+to\s+(.+?)\s*[?.!]*$/i);
        const rawPath = m?.[1];
        const rawDest = m?.[2];
        if (!rawPath || !rawDest) return null;
        const path = stripQuotes(rawPath);
        const destDir = stripQuotes(rawDest);
        if (!ABS_PATH_START.test(path) || !ABS_PATH_START.test(destDir)) return null;
        return plan(step('files.copy', { path, destDir }), 'copy-file');
      },
    },

    {
      name: 'fileDelete',
      order: -3.2,
      pathSafe: true,
      test(_lower, raw) {
        const captured = raw.match(/^\s*delete\s+(.+?)\s*[?.!]*$/i)?.[1];
        if (!captured) return null;
        const path = stripQuotes(captured);
        if (!ABS_PATH_START.test(path)) return null;
        return plan(step('files.delete', { path }), 'delete-file');
      },
    },

    {
      name: 'fileReadText',
      order: -3.1,
      pathSafe: true,
      test(_lower, raw) {
        const captured = raw.match(/^\s*(?:read|show me the contents of)\s+(.+?)\s*[?.!]*$/i)?.[1];
        if (!captured) return null;
        const path = stripQuotes(captured);
        if (!ABS_PATH_START.test(path)) return null;
        return plan(step('files.readText', { path }), 'read-file');
      },
    },

    // --- Open "it" / "the second one" -------------------------------------------
    // Working memory is in-process (see `WorkingMemory`'s doc comment), so
    // unlike aliases this can resolve synchronously, right here, instead of
    // needing a skill to do the lookup. Reuses the target row's own `actions`
    // — the same data a click on that row in the UI would use — so this rule
    // never has to know which skill "open" means for a given result.
    {
      name: 'referentialOpen',
      order: -2.65,
      // Deliberately tested against `lower`, not `clean(captured)` — `clean`
      // strips a leading "the", which would turn "the second one" into
      // "second one" and miss REFERENTIAL's "the (first|second|third|last)
      // one" alternative entirely.
      test(lower) {
        const target = lower.match(/^\s*(?:open|show|reveal)\s+(.+?)\s*[?.!]*$/)?.[1]?.trim();
        if (!target || !REFERENTIAL.test(target)) return null;

        const ordinalWord = target.match(/^the (first|second|third|last) one$/)?.[1];
        const row = ordinalWord ? working.resolveOrdinal(ordinalWord) : working.resolveFocusRow();
        const action = row?.actions?.[0];
        if (!action) return null;
        return plan(step(action.skill, action.args), 'open-referential');
      },
    },

    // --- Open a remembered name -------------------------------------------------
    // "open my work folder": a file-noun target with no absolute path. Never
    // steals from appOpen — that rule already declines anything matching
    // FILE_NOUN, so this only claims phrasings that would otherwise fall
    // through the whole grammar untouched. Whether the name is actually known
    // is a memory lookup files.openAlias makes at run time, not something the
    // grammar (no storage access) can check.
    {
      name: 'filesOpenAlias',
      order: -2.6,
      pathSafe: false,
      test(_lower, raw) {
        const captured = raw.match(/^\s*(?:open|show|reveal)\s+(.+?)\s*[?.!]*$/i)?.[1];
        if (!captured) return null;
        // The possessive is what makes this a *remembered name*, and it is
        // checked before `clean()` strips it. Without it the rule claimed
        // anything containing a file word — "File Explorer", "Notes",
        // "Photos" — and answered a request to open an application with an
        // offer to teach Atlas what its name meant.
        if (!/^\s*(?:my|our)\s+/i.test(captured)) return null;
        const target = clean(captured);
        if (!target || REFERENTIAL.test(target)) return null;
        // A file noun is no longer required. "remember my gaming rig is
        // D:\\Games" was always allowed, so "open my gaming rig" has to work
        // too — and with the possessive present there is nothing left to
        // confuse this with.
        return plan(step('files.openAlias', { subject: target }), 'open-alias', 0.85);
      },
    },

    // --- Search the internet (actually retrieves results) -----------------------
    // Distinct from `webSearch` below, which just opens a browser tab: "search
    // the internet/web for X" and "research X" mean Atlas should read the
    // results itself, not hand the user a tab. No phrase overlap with
    // `webSearch`'s pattern ("search for X" / "google X"), so order relative
    // to it doesn't matter — placed first for readability, not correctness.
    {
      name: 'researchSearch',
      order: -2.62,
      test(_lower, raw) {
        const captured =
          raw.match(/^\s*search\s+the\s+(?:internet|web)\s+for\s+(.+?)\s*[?.!]*$/i)?.[1] ??
          raw.match(/^\s*research\s+(.+?)\s*[?.!]*$/i)?.[1];
        if (!captured) return null;
        const query = captured.trim();
        if (!query) return null;
        return plan(step('research.search', { query }), 'research-search');
      },
    },

    // --- Search the web / YouTube -----------------------------------------------
    // Both are web.open in disguise. Ordered after filesFind (-10), so "search
    // for my resume" still resolves to a file search first — these only get a
    // turn once the file rules have already declined.
    {
      name: 'webSearch',
      order: -2.5,
      test(_lower, raw) {
        const captured = raw.match(
          /^\s*(?:search (?:the web |google )?for|google)\s+(.+?)\s*[?.!]*$/i,
        )?.[1];
        if (!captured) return null;
        const query = captured.trim();
        if (!query) return null;
        return plan(step('web.search', { query }), 'web-search');
      },
    },

    {
      name: 'youtubeSearch',
      order: -2.4,
      test(_lower, raw) {
        const captured = raw.match(/^\s*(?:search youtube for|youtube)\s+(.+?)\s*[?.!]*$/i)?.[1];
        if (!captured) return null;
        const query = captured.trim();
        if (!query) return null;
        return plan(step('web.searchYoutube', { query }), 'youtube-search');
      },
    },

    // --- Open an application ---------------------------------------------------
    // Last, because it's the greediest: anything still shaped like "open X"
    // after the specific rules have declined is treated as an app name.
    // --- Open a site, or open something in the browser -----------------------
    // Sits just ahead of `appOpen` and handles the two things that rule
    // cannot: the web-flavoured verbs ("go to youtube"), and a trailing
    // destination hint ("open youtube on Google"). Left to `appOpen`, the hint
    // becomes part of the name and Atlas hunts for an application called
    // "youtube on google".
    //
    // Where the target is *not* a site it knows, this rule hands back rather
    // than guessing — except when a browser was named outright, since "open X
    // on Google" with an unknown X is a request to look X up, which is a thing
    // Atlas can do locally and correctly.
    {
      name: 'openSite',
      order: -1.2,
      pathSafe: false,
      test(_lower, raw) {
        const m = raw.match(
          /^\s*(?:(open|launch|start|run)|(go to|goto|visit|browse to|browse|pull up|bring up|take me to))\s+(.+?)\s*[?.!]*$/i,
        );
        if (!m) return null;
        const webVerb = Boolean(m[2]);
        const captured = m[3];
        if (!captured) return null;

        const { text, wantsBrowser } = splitBrowserHint(captured);
        const target = clean(text);
        if (!target || REFERENTIAL.test(target.trim().toLowerCase())) return null;
        // File talk belongs to the file rules, which already had their turn.
        if (FILE_NOUN.test(target)) return null;

        const site = resolveSite(target);

        if (wantsBrowser) {
          return site
            ? plan(step('web.open', { url: site.url }), 'open-site')
            : plan(step('web.search', { query: target }), 'web-search');
        }

        // No hint. Only the web verbs may claim a bare name here; "open X"
        // stays with `appOpen`, so an installed program still wins over a
        // site of the same name.
        if (!webVerb) return null;
        if (site) return plan(step('web.open', { url: site.url }), 'open-site');
        return plan(step('app.open', { name: target }), 'open-app', 0.85);
      },
    },

    {
      name: 'appOpen',
      order: -1,
      pathSafe: false,
      test(_lower, raw) {
        const captured = raw.match(/^\s*(?:open|launch|start|run)\s+(.+?)\s*[?.!]*$/i)?.[1];
        if (!captured) return null;

        // Checked before `clean()`, which strips a leading "the" and would
        // turn "the second one" into "second one" — missing REFERENTIAL's
        // "the (first|second|third|last) one" shape entirely and letting it
        // fall through here as if "second one" were an app name.
        // `referentialOpen` (order -2.65, before this rule) already resolves
        // what it can; reaching here means it couldn't, so this must still
        // decline rather than treat the phrase as a literal name.
        if (REFERENTIAL.test(captured.trim().toLowerCase())) return null;

        const target = clean(captured);
        if (!target) return null;
        // File talk belongs to the file rules, which already had their turn —
        // but only when the target *is* file talk. "documents" is; "File
        // Explorer" is a name that happens to contain a file word, and
        // vetoing that left no rule at all willing to handle the request. So
        // the veto now applies only when removing the file nouns leaves
        // nothing behind. Every one of them, not just the first: "invoice
        // folder" is two file nouns and is still entirely file talk.
        if (FILE_NOUN.test(target) && !target.replace(FILE_NOUNS_GLOBAL, '').trim()) return null;

        // Slightly under the usual grammar confidence: the app might not exist,
        // and the skill will say so.
        return plan(step('app.open', { name: target }), 'open-app', 0.85);
      },
    },
  ];
}

function detectKind(text: string): string | null {
  if (/\b(pdf|document|documents|doc|docx|report|invoice|resume|cv|note|notes)\b/i.test(text))
    return 'document';
  if (/\b(photo|photos|picture|pictures|image|images|screenshot|screenshots)\b/i.test(text))
    return 'image';
  if (/\b(video|videos|movie|movies|clip|clips)\b/i.test(text)) return 'video';
  if (/\b(song|songs|music|audio|track|tracks)\b/i.test(text)) return 'audio';
  if (/\b(zip|archive|rar)\b/i.test(text)) return 'archive';
  if (/\b(folder|folders|directory|directories)\b/i.test(text)) return 'folder';
  return null;
}
