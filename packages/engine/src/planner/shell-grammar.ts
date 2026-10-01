/**
 * Phrasings for brightness, per-app volume, the power plan, projection, the
 * Recycle Bin, startup apps, Settings pages, printers, a speed test, and
 * holding a key.
 */

import type { GrammarRule } from './grammar';
import { plan, step } from './grammar';

const APOS = String.raw`['’]?`;

function tidy(s: string): string {
  return s
    .trim()
    .replace(/[?.!]+$/g, '')
    .replace(/^["'“‘]|["'”’]$/g, '')
    .trim();
}

/** Words that mean "the speakers / the mic", never an app — so "mute the sound" stays where it was. */
const NOT_AN_APP =
  /^(?:it|this|that|the\s+sound|sound|volume|audio|everything|all|my\s+mic(?:rophone)?|the\s+mic(?:rophone)?|mic(?:rophone)?|notifications|me|up|down|the\s+music|music)$/i;

/** Spoken name → page id for `system.settingsPage`. Longest first, so "night light" wins over "light". */
const PAGES: Array<[RegExp, string]> = [
  [/default\s+(?:browser|apps?|programs?)|(?:web\s+)?browser\s+default/, 'default-apps'],
  [/night\s*light|blue\s+light(?:\s+filter)?|eye\s+comfort/, 'night-light'],
  [/mobile\s+hot\s*spot|hot\s*spot|tethering/, 'hotspot'],
  [/time\s*zone|date\s+(?:and|&)\s+time|clock\s+settings/, 'time-language'],
  [/language(?:\s+(?:and|&)\s+region)?|region|keyboard\s+language/, 'language'],
  [/(?:screen\s+|display\s+)?resolution|display(?:\s+scale|\s+settings)?|monitors?\s+settings|refresh\s+rate|scaling/, 'display'],
  [/printers?(?:\s+(?:and|&)\s+scanners?)?/, 'printers'],
  [/sound(?:\s+settings)?/, 'sound'],
  [/bluetooth(?:\s+(?:and|&)\s+devices)?/, 'bluetooth'],
  [/wi-?fi/, 'wifi'],
  [/startup\s+apps?/, 'startup-apps'],
  [/installed\s+apps?|apps?\s+(?:and|&)\s+features|uninstall\s+(?:a\s+)?(?:program|app)/, 'installed-apps'],
  [/storage(?:\s+sense)?/, 'storage'],
  [/power(?:\s+(?:and|&)\s+sleep)?|sleep\s+settings/, 'power'],
  [/notifications?/, 'notifications'],
  [/personali[sz]ation|themes?|colou?rs?\s+settings/, 'personalization'],
  [/windows\s+update|updates?/, 'windows-update'],
  [/taskbar/, 'taskbar'],
  [/privacy(?:\s+(?:and|&)\s+security)?/, 'privacy'],
];

function pageFor(text: string): string | null {
  const t = text.toLowerCase();
  for (const [re, id] of PAGES) if (re.test(t)) return id;
  return null;
}

export function createShellGrammar(): GrammarRule[] {
  return [
    {
      name: 'screenBrightness',
      order: -5.4,
      questionSafe: ['brightness'],
      test(lower) {
        const n = lower.match(
          new RegExp(String.raw`^\s*(?:please\s+)?(?:(?:set|change|turn|put|make|bring)\s+)?(?:the\s+|my\s+)?(?:screen\s+|monitor\s+|display\s+)?brightness\s*(?:to|at|=)?\s*(\d{1,3})\s*(?:%|percent)?\s*[?.!]*$`),
        );
        if (n) return plan(step('system.brightness', { level: Number(n[1]) }), 'brightness');
        const dim = /^\s*(?:please\s+)?(?:dim|darken|lower|reduce|turn\s+down)\s+(?:the\s+|my\s+)?(?:screen|monitors?|display|brightness)(?:\s+brightness)?\s*[?.!]*$|^\s*(?:please\s+)?make\s+(?:the\s+|my\s+)?(?:screen|monitors?|display)\s+(?:dimmer|darker)\s*[?.!]*$/;
        if (dim.test(lower)) return plan(step('system.brightness', { direction: 'dimmer' }), 'brightness');
        const bright = /^\s*(?:please\s+)?(?:brighten|raise|increase|turn\s+up)\s+(?:the\s+|my\s+)?(?:screen|monitors?|display|brightness)(?:\s+brightness)?\s*[?.!]*$|^\s*(?:please\s+)?make\s+(?:the\s+|my\s+)?(?:screen|monitors?|display)\s+brighter\s*[?.!]*$/;
        if (bright.test(lower)) return plan(step('system.brightness', { direction: 'brighter' }), 'brightness');
        if (new RegExp(String.raw`^\s*(?:what(?:${APOS}s|\s+is)\s+)?(?:the\s+|my\s+)?(?:current\s+)?(?:screen\s+|monitor\s+)?brightness\s*[?.!]*$|^\s*how\s+bright\s+is\s+(?:my|the)\s+(?:screen|monitor|display)\s*[?.!]*$`).test(lower)) {
          return plan(step('system.brightness', {}), 'brightness');
        }
        return null;
      },
    },

    {
      name: 'appVolume',
      order: -5.245,
      questionSafe: ['app-volume'],
      test(lower) {
        if (/^\s*(?:which|what)\s+(?:apps?|programs?)\s+(?:are|is)\s+(?:playing|making)\s+(?:any\s+)?(?:sound|noise|audio)\s*[?.!]*$|^\s*(?:list|show)\s+(?:the\s+)?(?:app|per-app)\s+volumes?\s*[?.!]*$/.test(lower)) {
          return plan(step('system.appVolume', {}), 'app-volume');
        }
        const set = lower.match(
          /^\s*(?:please\s+)?(?:(?:set|change|turn|put|make)\s+)?(?:the\s+)?([a-z][a-z0-9 .+-]*?)(?:['’]s)?\s+(?:volume|sound)\s*(?:to|at|=)?\s*(\d{1,3})\s*(?:%|percent)?\s*[?.!]*$/,
        );
        if (set && !NOT_AN_APP.test(set[1]!.trim()) && !/\b(?:system|master|main|mic|microphone|speaker|speakers|screen|mouse|computer|pc)\b/.test(set[1]!)) {
          return plan(step('system.appVolume', { app: set[1]!.trim(), level: Number(set[2]) }), 'app-volume');
        }
        const mute = lower.match(/^\s*(?:please\s+)?(mute|unmute)\s+(?:the\s+)?([a-z][a-z0-9 .+-]*?)\s*[?.!]*$/);
        if (mute && !NOT_AN_APP.test(mute[2]!.trim()) && !/\b(?:mic|microphone|sound|volume|audio|notifications?)\b/.test(mute[2]!)) {
          return plan(step('system.appVolume', { app: mute[2]!.trim(), state: mute[1]! }), 'app-volume');
        }
        return null;
      },
    },

    {
      // Ahead of switchToWindow (-6.545): "switch to high performance" is not a window.
      name: 'powerPlan',
      order: -6.6,
      questionSafe: ['power-plan'],
      test(lower) {
        const choose = lower.match(
          /^\s*(?:please\s+)?(?:(?:switch|change|set|go|put\s+(?:my\s+|the\s+)?(?:pc|computer|laptop)\s+)\s*(?:to|on)?\s*(?:the\s+)?(?:power\s+plan\s+(?:to\s+)?)?|(?:turn\s+on|use|enable)\s+)(high[\s-]performance|balanced|power[\s-]sav(?:er|ing)|battery[\s-]sav(?:er|ing)|best\s+performance)(?:\s+(?:mode|plan|power\s+plan))?\s*[?.!]*$/,
        );
        if (choose) {
          const w = choose[1]!;
          const p = /high|best/.test(w) ? 'high-performance' : /sav/.test(w) ? 'power-saver' : 'balanced';
          return plan(step('system.powerPlan', { plan: p }), 'power-plan');
        }
        if (/^\s*(?:which|what)\s+power\s+(?:plan|mode)\s+(?:am\s+i\s+(?:on|using)|is\s+(?:active|on|selected))\s*[?.!]*$|^\s*(?:what(?:['’]?s|\s+is)\s+)?(?:my\s+|the\s+)?(?:current\s+)?power\s+plan\s*[?.!]*$/.test(lower)) {
          return plan(step('system.powerPlan', {}), 'power-plan');
        }
        return null;
      },
    },

    {
      name: 'projectDisplay',
      order: -5.38,
      test(lower) {
        if (/^\s*(?:please\s+)?extend\s+(?:my\s+|the\s+)?(?:screens?|displays?|monitors?|desktop)\s*[?.!]*$/.test(lower)) {
          return plan(step('system.projectDisplay', { mode: 'extend' }), 'project-display');
        }
        if (/^\s*(?:please\s+)?(?:duplicate|mirror|clone)\s+(?:my\s+|the\s+)?(?:screens?|displays?|monitors?|desktop)\s*[?.!]*$/.test(lower)) {
          return plan(step('system.projectDisplay', { mode: 'duplicate' }), 'project-display');
        }
        if (/^\s*(?:please\s+)?(?:show|use|display)\s+(?:only\s+)?(?:on\s+)?(?:my\s+)?(?:pc|main|primary|laptop|computer)\s+screen(?:\s+only)?\s*[?.!]*$|^\s*(?:pc|main)\s+screen\s+only\s*[?.!]*$/.test(lower)) {
          return plan(step('system.projectDisplay', { mode: 'pc-only' }), 'project-display');
        }
        if (/^\s*(?:please\s+)?(?:show|use|display|project)\s+(?:only\s+)?(?:on\s+|to\s+)?(?:my\s+|the\s+)?(?:second|2nd|other|external|projector|tv)\s+(?:screen|display|monitor)(?:\s+only)?\s*[?.!]*$|^\s*(?:second|external)\s+screen\s+only\s*[?.!]*$/.test(lower)) {
          return plan(step('system.projectDisplay', { mode: 'second-only' }), 'project-display');
        }
        return null;
      },
    },

    {
      // Ahead of windowControlBare (-6.685): "restore X from the recycle bin" is not a window.
      name: 'recycleBin',
      order: -6.7,
      questionSafe: ['recycle-bin-list'],
      test(_lower, raw) {
        if (/^\s*(?:what(?:['’]?s|\s+is)\s+in|show(?:\s+me)?\s+what(?:['’]?s|\s+is)\s+in|list|see|check\s+what(?:['’]?s|\s+is)\s+in)\s+(?:the\s+|my\s+)?(?:recycle\s*bin|trash|bin)(?:\s+contents)?\s*[?.!]*$|^\s*what\s+(?:did\s+i|have\s+i)\s+(?:just\s+|recently\s+)?delete[d]?\s*[?.!]*$/i.test(raw)) {
          return plan(step('files.recycleBin', {}), 'recycle-bin-list');
        }
        const m =
          raw.match(/^\s*(?:please\s+)?(?:restore|recover|get\s+back|bring\s+back|put\s+back)\s+(.+?)\s+from\s+(?:the\s+|my\s+)?(?:recycle\s*bin|trash|bin)\s*[?.!]*$/i) ??
          raw.match(/^\s*(?:please\s+)?undelete\s+(.+?)\s*[?.!]*$/i) ??
          raw.match(/^\s*(?:please\s+)?(?:restore|recover)\s+(?:the\s+)?(?:deleted\s+)?(?:file|folder)\s+(.+?)\s*[?.!]*$/i);
        if (!m) return null;
        const name = tidy(m[1]!);
        if (!name || /^(?:it|that|this|them|something)$/i.test(name)) return null;
        return plan(step('files.restore', { name }), 'restore-deleted');
      },
    },

    {
      name: 'startupApps',
      order: -5.37,
      questionSafe: ['startup-list'],
      test(_lower, raw) {
        if (/^\s*(?:what|which)\s+(?:apps?|programs?)\s+(?:start|run|launch|open)\s+(?:with\s+windows|at\s+(?:start\s*up|boot|login)|on\s+(?:start\s*up|boot|login)|when\s+(?:i\s+)?(?:turn\s+on|boot|start|log\s+in))\s*[?.!]*$|^\s*(?:list|show)\s+(?:my\s+|the\s+)?startup\s+(?:apps?|programs?|items)\s*[?.!]*$|^\s*what(?:['’]?s|\s+is)\s+(?:in\s+)?(?:my\s+)?startup\s*[?.!]*$/i.test(raw)) {
          return plan(step('system.startupApps', {}), 'startup-list');
        }
        const off =
          raw.match(/^\s*(?:please\s+)?(?:stop|prevent|disable|block)\s+(.+?)\s+(?:from\s+)?(?:starting|launching|running|opening)\s+(?:with\s+windows|at\s+(?:start\s*up|boot|login)|on\s+(?:start\s*up|boot|login)|automatically)\s*[?.!]*$/i) ??
          raw.match(/^\s*(?:please\s+)?(?:don['’]?t|do\s+not)\s+(?:let\s+)?(?:start|launch|run)\s+(.+?)\s+(?:with\s+windows|at\s+(?:start\s*up|boot|login)|on\s+(?:start\s*up|boot|login))\s*[?.!]*$/i) ??
          raw.match(/^\s*(?:please\s+)?(?:turn\s+off|disable|remove)\s+(.+?)\s+(?:at|on|from)\s+start\s*up\s*[?.!]*$/i) ??
          raw.match(/^\s*(?:please\s+)?disable\s+(?:the\s+)?start\s*up\s+(?:for|of)\s+(.+?)\s*[?.!]*$/i);
        if (off) return plan(step('system.startupApps', { name: tidy(off[1]!), enabled: false }), 'startup-set');
        const on =
          raw.match(/^\s*(?:please\s+)?(?:let|allow|enable|make)\s+(.+?)\s+(?:to\s+)?(?:start|launch|run|open)\s+(?:with\s+windows|at\s+(?:start\s*up|boot|login)|on\s+(?:start\s*up|boot|login))\s*[?.!]*$/i) ??
          raw.match(/^\s*(?:please\s+)?(?:turn\s+on|enable)\s+(.+?)\s+(?:at|on)\s+start\s*up\s*[?.!]*$/i);
        if (on) return plan(step('system.startupApps', { name: tidy(on[1]!), enabled: true }), 'startup-set');
        return null;
      },
    },

    {
      name: 'settingsPage',
      order: -5.36,
      test(_lower, raw) {
        // "open the night light settings" / "open display settings"
        const open = raw.match(/^\s*(?:please\s+)?(?:open|show|take\s+me\s+to|go\s+to|launch)\s+(?:the\s+|my\s+)?(.+?)\s+settings\s*[?.!]*$/i);
        if (open) {
          const page = pageFor(open[1]!);
          if (page) return plan(step('system.settingsPage', { page }), 'settings-page');
        }
        // Things Windows only lets the person do: say what was meant, and go to the page.
        const verbs = raw.match(
          /^\s*(?:please\s+)?(?:(?:change|set|switch|choose|pick|set\s+up|turn\s+on|enable|turn\s+off|disable|adjust|configure|manage|pin\s+.+?\s+to)\s+)(?:the\s+|my\s+)?(.+?)\s*[?.!]*$/i,
        );
        if (verbs) {
          const page = pageFor(verbs[1]!);
          // Only the pages that have no direct skill of their own; "turn off wifi" is a radio.
          if (page && ['default-apps', 'night-light', 'hotspot', 'time-language', 'language', 'display'].includes(page)) {
            return plan(step('system.settingsPage', { page }), 'settings-page', 0.85);
          }
          if (/^pin\s+.+\s+to\s+(?:the\s+)?taskbar/i.test(raw.trim().replace(/^please\s+/i, ''))) {
            return plan(step('system.settingsPage', { page: 'taskbar' }), 'settings-page', 0.8);
          }
        }
        return null;
      },
    },

    {
      name: 'printers',
      order: -5.35,
      questionSafe: ['printers'],
      test(_lower, raw) {
        if (/^\s*(?:what|which)\s+printers?\s+(?:do\s+i\s+have|are\s+(?:installed|there|available)|is\s+(?:my\s+)?default)\s*[?.!]*$|^\s*(?:list|show)\s+(?:my\s+|the\s+)?printers\s*[?.!]*$/i.test(raw)) {
          return plan(step('system.printers', {}), 'printers');
        }
        const m =
          raw.match(/^\s*(?:please\s+)?(?:set|change|make|use)\s+(?:my\s+|the\s+)?default\s+printer\s+(?:to\s+)?(.+?)\s*[?.!]*$/i) ??
          raw.match(/^\s*(?:please\s+)?(?:make|set)\s+(.+?)\s+(?:my\s+|the\s+)?default\s+printer\s*[?.!]*$/i);
        if (m) return plan(step('system.printers', { name: tidy(m[1]!) }), 'printers');
        return null;
      },
    },

    {
      name: 'printFile',
      order: -5.34,
      pathSafe: true,
      test(_lower, raw) {
        const m = raw.match(/^\s*(?:please\s+)?print\s+(?:out\s+)?(?:the\s+|my\s+)?(.+?)\s*[?.!]*$/i);
        if (!m) return null;
        const target = tidy(m[1]!);
        // Only something file-shaped: a name with an extension, or the word file.
        if (!/\.[a-z0-9]{2,5}\b|\bfile\b/i.test(target)) return null;
        return plan(step('files.print', { target }), 'print-file');
      },
    },

    {
      name: 'speedTest',
      order: -5.33,
      questionSafe: ['speed-test'],
      test(lower) {
        if (/^\s*(?:please\s+)?(?:run\s+|do\s+|start\s+)?(?:an?\s+)?(?:internet\s+|network\s+|wifi\s+)?speed\s*test\s*[?.!]*$|^\s*(?:test|check)\s+(?:my\s+)?(?:internet|network|wifi|connection)\s+speed\s*[?.!]*$|^\s*how\s+fast\s+is\s+(?:my\s+)?(?:internet|connection|wifi|network)\s*[?.!]*$/.test(lower)) {
          return plan(step('net.speedTest', {}), 'speed-test');
        }
        return null;
      },
    },

    {
      name: 'holdKey',
      order: -6.671,
      test(lower) {
        const m = lower.match(
          /^\s*(?:please\s+)?hold\s+(?:down\s+)?(?:the\s+)?(?:key\s+)?([a-z0-9]|enter|space|spacebar|tab|escape|esc|up|down|left|right|shift|f\d{1,2})(?:\s+key)?(?:\s+down)?\s+for\s+(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\s*[?.!]*$/,
        );
        if (!m) return null;
        return plan(step('input.holdKey', { key: m[1]!, seconds: Number(m[2]) }), 'hold-key');
      },
    },
  ];
}
