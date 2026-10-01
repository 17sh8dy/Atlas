/**
 * The everyday phrasings that used to fall through to "I don't know how to do
 * that" even though the skill existed (or was trivial): quitting an app, "is X
 * running", "turn it up", a bare "shut down", "brightness up", "timer 10
 * minutes", "how many cups in a liter", "uuid", "spell necessary", "paste"…
 *
 * A sweep of a few hundred ordinary sentences found these; each is one rule to
 * a skill that already knew how. None of them guesses: a sentence that is
 * ambiguous (a bare "restart", which could be the PC) takes the confirming
 * route, and anything that needs a missing detail is asked for, not invented.
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

/** Words that are not an app: a bare "quit it" / "exit" is not about one. */
const NOT_AN_APP = /^(?:it|this|that|them|atlas|everything|all|up|down|now|out)$/i;

const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5 };

export function createCoverageGrammar(): GrammarRule[] {
  return [
    {
      name: 'quitApp',
      order: -6.686,
      test(lower) {
        const m = lower.match(/^\s*(?:please\s+)?(?:quit|exit|close\s+down)\s+(?:the\s+|my\s+)?([a-z0-9][a-z0-9 .+'-]*?)(?:\s+app)?\s*[?.!]*$/);
        if (!m || NOT_AN_APP.test(m[1]!.trim())) return null;
        return plan(step('window.close', { name: m[1]!.trim() }), 'quit-app', 0.85);
      },
    },

    {
      name: 'whichAppsOpen',
      order: -6.4,
      questionSafe: ['window-list', 'is-running'],
      test(lower) {
        if (/^\s*(?:what|which)\s+(?:apps?|programs?|windows?)\s+(?:do\s+i\s+have\s+|are\s+(?:currently\s+)?)?open\s*[?.!]*$/.test(lower)) {
          return plan(step('window.list', {}), 'window-list');
        }
        const m = lower.match(/^\s*is\s+(?:the\s+|my\s+)?([a-z0-9][a-z0-9 .+'-]*?)\s+(?:running|open|on|up)\s*[?.!]*$/);
        if (m && !/^(?:it|this|that|bluetooth|wi-?fi|wifi|the\s+internet|internet|do not disturb|dnd|dark mode|my mic|mic|the mic)$/.test(m[1]!.trim()) && !/\b(?:mic|microphone|bluetooth|wi-?fi|internet|dnd|notifications?)\b/.test(m[1]!)) {
          return plan(step('app.isRunning', { name: m[1]!.trim() }), 'is-running', 0.85);
        }
        return null;
      },
    },

    {
      // "start a new chrome window" / "open two chrome windows": open it, then Ctrl+N for each extra.
      name: 'newAppWindow',
      order: -6.39,
      test(lower) {
        const m = lower.match(/^\s*(?:please\s+)?(?:open|start|launch|make|create)\s+(?:me\s+)?(a|an|one|two|three|four|five|\d)\s+(?:new\s+)?([a-z0-9][a-z0-9 .+'-]*?)\s+windows?\s*[?.!]*$/);
        if (!m) return null;
        const count = NUMBER_WORDS[m[1]!] ?? Number(m[1]);
        const name = m[2]!.trim();
        if (!count || count > 5 || /^(?:new|another|browser|terminal|file|incognito|private|inprivate|chrome incognito)$/.test(name)) return null;
        const steps = [step('app.open', { name }), step('window.await', { window: name })];
        for (let i = 1; i < count || (i === 1 && count === 1 && /\bnew\b/.test(lower)); i++) {
          steps.push(step('input.hotkey', { combo: 'ctrl+n' }));
          if (count === 1) break;
        }
        return plan(steps, 'new-window', 0.8);
      },
    },

    {
      name: 'lookUp',
      order: -9.35,
      questionSafe: ['lookup'],
      test(_lower, raw) {
        const m = raw.match(/^\s*(?:please\s+)?look\s+up\s+(.+?)\s*[?.!]*$/i);
        if (!m) return null;
        return plan(step('web.search', { query: tidy(m[1]!) }), 'lookup');
      },
    },

    {
      name: 'playOn',
      order: -9.34,
      test(_lower, raw) {
        const yt = raw.match(/^\s*(?:please\s+)?play\s+(.+?)\s+(?:on|in|from)\s+youtube\s*[?.!]*$/i);
        if (yt) return plan(step('web.searchYoutube', { query: tidy(yt[1]!) }), 'play-youtube');
        const sp = raw.match(/^\s*(?:please\s+)?play\s+(.+?)\s+(?:on|in|with|using|from)\s+spotify\s*[?.!]*$/i);
        if (sp) {
          const q = tidy(sp[1]!);
          // "play music on spotify" names nothing to search for: just open it.
          if (/^(?:some\s+)?(?:music|something|songs?|a song|my music|tunes)$/i.test(q)) return plan(step('app.open', { name: 'spotify' }), 'play-spotify');
          return plan(step('media.playOn', { query: q, service: 'spotify' }), 'play-spotify');
        }
        return null;
      },
    },

    {
      name: 'nudgeVolumeAndBrightness',
      order: -5.26,
      test(lower) {
        if (/^\s*(?:please\s+)?turn\s+it\s+up(?:\s+a\s+(?:bit|little|notch))?\s*[?.!]*$/.test(lower)) return plan(step('system.volume', { direction: 'up' }), 'volume');
        if (/^\s*(?:please\s+)?turn\s+it\s+down(?:\s+a\s+(?:bit|little|notch))?\s*[?.!]*$/.test(lower)) return plan(step('system.volume', { direction: 'down' }), 'volume');
        if (/^\s*(?:please\s+)?(?:brightness\s+up|more\s+brightness|brighter)\s*[?.!]*$/.test(lower)) return plan(step('system.brightness', { direction: 'brighter' }), 'brightness');
        if (/^\s*(?:please\s+)?(?:brightness\s+down|less\s+brightness|dimmer|darker)\s*[?.!]*$/.test(lower)) return plan(step('system.brightness', { direction: 'dimmer' }), 'brightness');
        if (/^\s*(?:please\s+)?dark\s+mode\s*[?.!]*$/.test(lower)) return plan(step('system.theme', { mode: 'dark' }), 'theme');
        if (/^\s*(?:please\s+)?light\s+mode\s*[?.!]*$/.test(lower)) return plan(step('system.theme', { mode: 'light' }), 'theme');
        if (/^\s*(?:please\s+)?night\s*light\s*[?.!]*$/.test(lower)) return plan(step('system.settingsPage', { page: 'night-light' }), 'settings-page');
        return null;
      },
    },

    {
      // A bare "shut down" / "restart" / "log off" is the PC — and system.power asks first.
      name: 'barePower',
      order: -5.195,
      test(lower) {
        if (/^\s*(?:please\s+)?(?:shut\s?down|power\s+off|turn\s+off)\s*[?.!]*$/.test(lower)) return plan(step('system.power', { action: 'shutdown' }), 'power');
        if (/^\s*(?:please\s+)?(?:restart|reboot)\s*[?.!]*$/.test(lower)) return plan(step('system.power', { action: 'restart' }), 'power');
        if (/^\s*(?:please\s+)?(?:log\s*off|log\s*out|sign\s*off)\s*[?.!]*$/.test(lower)) return plan(step('system.power', { action: 'sign-out' }), 'power');
        return null;
      },
    },

    {
      name: 'netCheck',
      order: -6.89,
      questionSafe: ['online'],
      test(lower) {
        if (/^\s*(?:please\s+)?(?:check|test)\s+(?:my\s+|the\s+)?(?:internet|connection|network|wi-?fi)(?:\s+connection)?\s*[?.!]*$/.test(lower)) return plan(step('net.online', {}), 'online');
        return null;
      },
    },

    {
      name: 'specs',
      order: -7.34,
      questionSafe: ['specs'],
      test(lower) {
        if (/^\s*(?:what(?:['’]?s|\s+(?:are|is))\s+)?(?:my\s+|this\s+pc['’]?s\s+|the\s+)?(?:pc\s+|computer\s+)?(?:specs|specifications|hardware)\s*[?.!]*$|^\s*(?:what|which)\s+(?:graphics\s+card|gpu|cpu|processor|video\s+card)\s+(?:do\s+i\s+have|am\s+i\s+using|is\s+(?:in\s+)?(?:my|this)\s+(?:pc|computer))\s*[?.!]*$|^\s*(?:how\s+much\s+ram\s+do\s+i\s+have)\s*[?.!]*$|^\s*what\s+(?:kind\s+of\s+)?(?:pc|computer)\s+(?:do\s+i\s+have|is\s+this)\s*[?.!]*$/.test(lower)) {
          return plan(step('system.specs', {}), 'specs');
        }
        return null;
      },
    },

    {
      name: 'timerShort',
      order: -7.29,
      test(lower) {
        const m =
          lower.match(/^\s*(?:please\s+)?(?:set\s+(?:a\s+)?|start\s+(?:a\s+)?)?timer\s+(?:for\s+)?(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\s*[?.!]*$/) ??
          lower.match(/^\s*(?:please\s+)?(?:set\s+(?:a\s+)?|start\s+(?:a\s+)?)?(\d+(?:\.\d+)?)[\s-]*(second|sec|minute|min|hour|hr)s?\s+timer\s*[?.!]*$/);
        if (!m) return null;
        const n = Number(m[1]);
        const unit = m[2]!;
        const seconds = Math.round(n * (/^h/.test(unit) ? 3600 : /^m/.test(unit) ? 60 : 1));
        return plan(step('time.timer', { seconds }), 'timer');
      },
    },

    {
      name: 'wordMath',
      order: -7.53,
      questionSafe: ['convert', 'percent', 'tip'],
      test(_lower, raw) {
        const pct = raw.match(/^\s*(?:please\s+)?(?:calculate|work\s+out|what(?:['’]?s|\s+is))\s+([\d.]+)\s*(?:%|percent)\s+of\s+([\d.,]+)\s*[?.!]*$/i);
        if (pct) {
          return plan(step('math.percent', { a: Number(pct[1]), b: Number(String(pct[2]).replace(/,/g, '')), mode: 'of' }), 'percent');
        }
        // "how many cups in a liter" — the number is the one in "a liter".
        const hm = raw.match(/^\s*how\s+many\s+([a-z°]+)\s+(?:are\s+)?(?:in|per)\s+(?:an?|one|1)\s+([a-z°]+)\s*[?.!]*$/i);
        if (hm) return plan(step('math.convert', { value: 1, from: hm[2]!, to: hm[1]! }), 'convert');
        // "what's 20 celsius in fahrenheit" — no "to".
        const cv = raw.match(/^\s*(?:what(?:['’]?s|\s+is)\s+)?(-?[\d.]+)\s*(?:degrees?\s+)?([a-z°]+)\s+in\s+([a-z°]+)\s*[?.!]*$/i);
        if (cv && Number.isFinite(Number(cv[1]))) return plan(step('math.convert', { value: Number(cv[1]), from: cv[2]!, to: cv[3]! }), 'convert');
        const tip = raw.match(/^\s*(?:what(?:['’]?s|\s+is)\s+)?(?:the\s+)?tip\s+(?:on|for)\s+\$?([\d.]+)(?:\s+dollars?)?\s*[?.!]*$/i);
        if (tip) return plan(step('math.tip', { bill: Number(tip[1]) }), 'tip');
        const split = raw.match(/^\s*split\s+\$?([\d.]+)(?:\s+dollars?)?\s+(?:between|among|by|ways?)\s+(\d+)(?:\s+(?:people|ways))?\s*[?.!]*$/i);
        if (split) return plan(step('math.tip', { bill: Number(split[1]), percent: 0, people: Number(split[2]) }), 'tip');
        return null;
      },
    },

    {
      name: 'tinyUtilities',
      order: -7.2,
      test(_lower, raw) {
        if (/^\s*(?:please\s+)?(?:a\s+)?(?:uuid|guid)\s*[?.!]*$/i.test(raw)) return plan(step('util.uuid', {}), 'uuid');
        const spell = raw.match(/^\s*(?:please\s+)?spell\s+(?:the\s+word\s+)?["“']?([A-Za-z'-]+)["”']?\s*[?.!]*$/i);
        if (spell) return plan(step('text.spell', { text: spell[1]! }), 'spell');
        const rev = raw.match(/^\s*(?:please\s+)?reverse\s+(?:the\s+(?:text|word|string)\s+)?["“']?(.+?)["”']?\s*[?.!]*$/i);
        if (rev && !/\b(?:the\s+(?:order|queue|list)|my|these|those)\b/i.test(rev[1]!)) return plan(step('text.reverse', { text: tidy(rev[1]!) }), 'reverse');
        const up = raw.match(/^\s*(?:please\s+)?(uppercase|lowercase|capitali[sz]e)\s+["“']?(.+?)["”']?\s*[?.!]*$/i);
        if (up && !/\b(?:all\s+)?(?:files?|folders?)\b|\bclipboard\b/i.test(up[2]!)) {
          const w = up[1]!.toLowerCase();
          return plan(step('text.case', { text: tidy(up[2]!), style: w === 'uppercase' ? 'upper' : w === 'lowercase' ? 'lower' : 'title' }), 'case');
        }
        if (/^\s*(?:word\s+count|count\s+(?:the\s+)?words(?:\s+in\s+(?:this|that|it))?|how\s+many\s+words\s+(?:is\s+this|are\s+(?:in\s+)?(?:this|that)))\s*[?.!]*$/i.test(raw)) {
          return plan(step('text.count', {}), 'count');
        }
        return null;
      },
    },

    {
      name: 'listsAndClipboard',
      order: -9.56,
      test(_lower, raw) {
        const shop = raw.match(/^\s*(?:please\s+)?add\s+(.+?)\s+to\s+(?:my\s+|the\s+)?(shopping|grocery|groceries|packing|wish)\s*list\s*[?.!]*$/i);
        if (shop) return plan(step('todo.add', { text: `${tidy(shop[1]!)} (${shop[2]!.toLowerCase()} list)` }), 'todo-add');
        if (/^\s*(?:please\s+)?copy\s+(?:this|that|it)\s*[?.!]*$/i.test(raw)) return plan(step('clipboard.copy', {}), 'clipboard');
        if (/^\s*(?:please\s+)?paste(?:\s+(?:it|that|this|here))?\s*[?.!]*$/i.test(raw)) return plan(step('input.hotkey', { combo: 'ctrl+v' }), 'paste');
        return null;
      },
    },

    {
      // "what is the largest folder in D:\Dev" — which part of it is the big part.
      name: 'largestFolders',
      order: -10.3,
      pathSafe: true,
      questionSafe: ['largest-folders'],
      test(_lower, asked) {
        // "…folder in: D:\Dev?" — a colon after the preposition is just punctuation.
        const raw = asked.replace(/\b(in|inside|under|of|within|on)\s*:\s*/i, '$1 ');
        const m =
          raw.match(/^\s*(?:what(?:['’]?s|\s+is|\s+are)\s+)?(?:the\s+)?(?:largest|biggest)\s+(?:sub-?)?(?:folders?|directories|directory)\s+(?:in|inside|under|of|within|on)\s+(?:my\s+|the\s+)?(.+?)(?:\s+folder)?\s*[?.!]*$/i) ??
          raw.match(/^\s*(?:which|what)\s+(?:sub-?)?(?:folder|directory)\s+(?:in|inside|under|of)\s+(?:my\s+|the\s+)?(.+?)\s+(?:is\s+(?:the\s+)?(?:largest|biggest)|takes?\s+(?:up\s+)?the\s+most\s+(?:space|room|storage)|uses?\s+the\s+most\s+(?:space|storage))\s*[?.!]*$/i) ??
          raw.match(/^\s*(?:what(?:['’]?s|\s+is)\s+)?(?:taking\s+up|using|eating)\s+(?:the\s+most\s+)?(?:space|storage)\s+(?:in|inside|under|of)\s+(?:my\s+|the\s+)?(.+?)(?:\s+folder)?\s*[?.!]*$/i);
        if (!m) return null;
        const path = tidy(m[1]!);
        if (!path) return null;
        return plan(step('storage.largestFolders', { path }), 'largest-folders');
      },
    },

    {
      name: 'filesEveryday',
      order: -10.1,
      questionSafe: ['find-files', 'recent', 'largest'],
      test(_lower, raw) {
        const where = raw.match(/^\s*where(?:['’]?s|\s+is|\s+are)\s+(?:my\s+|the\s+)?(.+?)\s*[?.!]*$/i);
        if (where && !/^(?:the\s+)?(?:nearest|closest|best)\b|\b(?:in the world|located|mouse|cursor|pointer)\b/i.test(where[1]!) && !/^(?:i|we|you|he|she|it|that|this)\b/i.test(where[1]!)) {
          return plan(step('files.find', { query: tidy(where[1]!) }), 'find-files', 0.8);
        }
        const show = raw.match(/^\s*(?:show|open|bring\s+up)\s+(?:me\s+)?(?:my|the)\s+(downloads|documents|desktop|pictures|music|videos)(?:\s+folder)?\s*[?.!]*$/i);
        if (show) return plan(step('files.openKnown', { folder: show[1]!.toLowerCase() }), 'open-known');
        if (/^\s*(?:show|list)\s+(?:me\s+)?(?:my\s+)?recent(?:ly\s+(?:changed|used|modified))?\s+files\s*[?.!]*$/i.test(raw)) {
          return plan(step('files.recent', { target: 'documents', hours: 168 }), 'files-recent');
        }
        if (/^\s*what\s+(?:did\s+i|have\s+i)\s+download(?:ed)?(?:\s+(?:today|recently|lately))?\s*[?.!]*$/i.test(raw)) {
          return plan(step('files.recent', { target: 'downloads', hours: 24 }), 'files-recent');
        }
        if (/^\s*(?:what(?:['’]?s|\s+is)\s+(?:taking\s+up|using|eating)\s+(?:all\s+)?(?:the\s+|my\s+)?(?:space|disk|storage)(?:\s+on\s+my\s+(?:pc|drive|disk))?|why\s+is\s+my\s+(?:disk|drive|pc)\s+full)\s*[?.!]*$/i.test(raw)) {
          return plan(step('storage.largestFiles', { path: 'home' }), 'largest');
        }
        if (/^\s*(?:please\s+)?(?:restore|recover|get\s+back)\s+(?:something|a\s+file|my\s+files?|stuff)?\s*from\s+(?:the\s+|my\s+)?(?:recycle\s*bin|trash|bin)\s*[?.!]*$/i.test(raw)) {
          return plan(step('files.recycleBin', {}), 'recycle-bin-list');
        }
        return null;
      },
    },

    {
      name: 'devEveryday',
      order: -11.43,
      test(_lower, raw) {
        if (/^\s*(?:please\s+)?(?:git\s+)?commit\s+(?:all\s+)?(?:my\s+|the\s+)?changes\s*[?.!]*$/i.test(raw)) {
          // Stages everything, then asks for the message — it is never invented.
          return plan([step('git.add', { file: '.' }), step('git.commit', {})], 'git-commit-all');
        }
        if (/^\s*(?:please\s+)?(?:install|get)\s+(?:all\s+)?(?:the\s+|my\s+|its\s+)?(?:project\s+)?dependencies\s*[?.!]*$|^\s*(?:npm|pnpm)\s+install\s*[?.!]*$/i.test(raw)) {
          return plan(step('dependency.installAll', {}), 'install-deps');
        }
        return null;
      },
    },
  ];
}
