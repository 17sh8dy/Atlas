/**
 * Phrasings for the everyday settings: wallpaper, mouse speed, file extensions
 * and hidden files, Explorer, Do Not Disturb, Wi-Fi and Bluetooth, and what is
 * playing.
 *
 * Ordered ahead of the file rules (-10.75…) because "hide hidden files" is a
 * sentence about an Explorer setting, and would otherwise be read as hiding a
 * file called "hidden files".
 */

import type { GrammarRule } from './grammar';
import { plan, step } from './grammar';

const ON = String.raw`(?:turn\s+on|switch\s+on|enable|activate|start|set\s+on)`;
const OFF = String.raw`(?:turn\s+off|switch\s+off|disable|deactivate|stop|set\s+off)`;

function tidy(s: string): string {
  return s
    .trim()
    .replace(/[?.!]+$/g, '')
    .replace(/^["'“‘]|["'”’]$/g, '')
    .trim();
}

export function createSettingsGrammar(): GrammarRule[] {
  return [
    {
      name: 'settingsWallpaper',
      order: -10.95,
      pathSafe: true,
      test(_lower, raw) {
        const m =
          raw.match(/^\s*(?:please\s+)?(?:set|change|make|use|put)\s+(?:my\s+|the\s+)?(?:desktop\s+)?(?:wallpaper|background)\s+(?:to|as)\s+([\s\S]+?)\s*[?.!]*$/i) ??
          raw.match(/^\s*(?:please\s+)?(?:use|set|make)\s+([\s\S]+?)\s+(?:as|for)\s+(?:my\s+|the\s+)?(?:desktop\s+)?(?:wallpaper|background)\s*[?.!]*$/i) ??
          raw.match(/^\s*(?:please\s+)?make\s+([\s\S]+?)\s+my\s+(?:desktop\s+)?(?:wallpaper|background)\s*[?.!]*$/i);
        if (!m) return null;
        const target = tidy(m[1]!);
        if (!target) return null;
        return plan(step('system.wallpaper', { target }), 'wallpaper');
      },
    },

    {
      name: 'settingsMouseSpeed',
      order: -10.94,
      questionSafe: ['mouse-speed'],
      test(lower) {
        const n = lower.match(/^\s*(?:please\s+)?(?:set|change|put|make)?\s*(?:the\s+|my\s+)?(?:mouse|pointer|cursor)\s+(?:speed|sensitivity)\s*(?:to|at|=)?\s*(\d{1,2})\s*[?.!]*$/);
        if (n) return plan(step('system.mouseSpeed', { speed: Number(n[1]) }), 'mouse-speed');
        const dir = lower.match(/^\s*(?:please\s+)?make\s+(?:the\s+|my\s+)?(?:mouse|pointer|cursor)(?:\s+(?:pointer|cursor))?\s+(faster|slower)\s*[?.!]*$/);
        if (dir) return plan(step('system.mouseSpeed', { direction: dir[1]! }), 'mouse-speed');
        if (/^\s*(?:what(?:['’]?s|\s+is)\s+)?(?:the\s+|my\s+)?(?:current\s+)?(?:mouse|pointer|cursor)\s+(?:speed|sensitivity)\s*[?.!]*$/.test(lower)) {
          return plan(step('system.mouseSpeed', {}), 'mouse-speed');
        }
        return null;
      },
    },

    {
      name: 'settingsExplorer',
      order: -10.93,
      questionSafe: ['explorer-option'],
      test(lower) {
        const SHOW = String.raw`(?:show|display|reveal|turn\s+on|enable|unhide)`;
        const HIDE = String.raw`(?:hide|turn\s+off|disable)`;
        const EXT = String.raw`(?:(?:the\s+|my\s+|all\s+)?file\s+(?:name\s+)?extensions?)`;
        const HID = String.raw`(?:(?:the\s+|my\s+|all\s+)?hidden\s+(?:files?|folders?|items?)(?:\s+and\s+folders?)?)`;
        const re = (verbs: string, what: string) => new RegExp(String.raw`^\s*(?:please\s+)?${verbs}\s+${what}\s*[?.!]*$`);
        if (re(SHOW, EXT).test(lower)) return plan(step('system.explorerOption', { which: 'file-extensions', show: true }), 'explorer-option');
        if (re(HIDE, EXT).test(lower)) return plan(step('system.explorerOption', { which: 'file-extensions', show: false }), 'explorer-option');
        if (re(SHOW, HID).test(lower)) return plan(step('system.explorerOption', { which: 'hidden-files', show: true }), 'explorer-option');
        if (re(HIDE, HID).test(lower)) return plan(step('system.explorerOption', { which: 'hidden-files', show: false }), 'explorer-option');
        if (/^\s*(?:are|is)\s+(?:file\s+)?extensions?\s+(?:shown|visible|showing|on)\s*\??\s*$/.test(lower)) {
          return plan(step('system.explorerOption', { which: 'file-extensions' }), 'explorer-option');
        }
        return null;
      },
    },

    {
      name: 'settingsRestartExplorer',
      order: -10.92,
      test(lower) {
        if (/^\s*(?:please\s+)?(?:restart|reload|relaunch|reset)\s+(?:windows\s+|file\s+)?explorer\s*[?.!]*$/.test(lower) ||
          /^\s*(?:please\s+)?(?:restart|reset)\s+(?:the\s+)?taskbar\s*[?.!]*$/.test(lower)) {
          return plan(step('system.restartExplorer', {}), 'restart-explorer');
        }
        return null;
      },
    },

    {
      name: 'settingsDoNotDisturb',
      order: -10.91,
      questionSafe: ['dnd'],
      test(lower) {
        const NAME = String.raw`(?:do\s+not\s+disturb|dnd|focus\s+assist|quiet\s+mode)`;
        if (new RegExp(String.raw`^\s*(?:please\s+)?${ON}\s+${NAME}\s*[?.!]*$|^\s*${NAME}\s+on\s*[?.!]*$|^\s*(?:please\s+)?(?:silence|mute|snooze)\s+(?:all\s+)?notifications\s*[?.!]*$`).test(lower)) {
          return plan(step('system.doNotDisturb', { on: true }), 'dnd');
        }
        if (new RegExp(String.raw`^\s*(?:please\s+)?${OFF}\s+${NAME}\s*[?.!]*$|^\s*${NAME}\s+off\s*[?.!]*$|^\s*(?:please\s+)?(?:unmute|resume|restore)\s+notifications\s*[?.!]*$`).test(lower)) {
          return plan(step('system.doNotDisturb', { on: false }), 'dnd');
        }
        if (new RegExp(String.raw`^\s*(?:is|are)\s+${NAME}\s+(?:on|off|enabled|active)\s*\??\s*$`).test(lower)) {
          return plan(step('system.doNotDisturb', {}), 'dnd');
        }
        return null;
      },
    },

    {
      name: 'settingsRadios',
      order: -10.9,
      questionSafe: ['radio'],
      test(lower) {
        const RADIO = String.raw`(wi-?fi|wireless|bluetooth|airplane\s+mode|flight\s+mode)`;
        const kindOf = (w: string) => (/blue/.test(w) ? 'bluetooth' : /air|flight/.test(w) ? 'airplane' : 'wifi');
        const verb = lower.match(new RegExp(String.raw`^\s*(?:please\s+)?(${ON}|${OFF})\s+(?:the\s+|my\s+)?${RADIO}\s*[?.!]*$`));
        if (verb) {
          const kind = kindOf(verb[2]!);
          let state = new RegExp(`^${OFF}$`).test(verb[1]!) ? 'off' : 'on';
          // "airplane mode on" means the radios go off.
          if (kind === 'airplane') state = state === 'on' ? 'off' : 'on';
          return plan(step('system.radio', { kind, state }), 'radio');
        }
        const trailing = lower.match(new RegExp(String.raw`^\s*(?:please\s+)?(?:the\s+|my\s+)?${RADIO}\s+(on|off)\s*[?.!]*$`));
        if (trailing) {
          const kind = kindOf(trailing[1]!);
          let state = trailing[2]!;
          if (kind === 'airplane') state = state === 'on' ? 'off' : 'on';
          return plan(step('system.radio', { kind, state }), 'radio');
        }
        // Only Bluetooth is asked about here; "is wifi on" belongs to the Wi-Fi status skill.
        if (/^\s*(?:is|are)\s+(?:my\s+|the\s+)?bluetooth\s+(?:on|off|enabled|connected)\s*\??\s*$/.test(lower)) {
          return plan(step('system.radio', { kind: 'bluetooth', state: 'status' }), 'radio');
        }
        return null;
      },
    },

    {
      name: 'mediaNowPlaying',
      order: -10.89,
      questionSafe: ['now-playing'],
      test(lower) {
        if (
          /^\s*(?:what(?:['’]?s|\s+is)\s+(?:currently\s+)?playing(?:\s+(?:right\s+)?now)?|what\s+(?:song|track|music)\s+is\s+(?:this|playing|on)(?:\s+(?:right\s+)?now)?|what(?:['’]?s|\s+is)\s+this\s+(?:song|track)|what\s+am\s+i\s+(?:listening|playing)\s+(?:to)?(?:\s+now)?|what\s+is\s+this\s+playing)\s*[?.!]*$/.test(
            lower,
          )
        ) {
          return plan(step('media.nowPlaying', {}), 'now-playing');
        }
        return null;
      },
    },

    {
      name: 'mediaShuffle',
      order: -10.88,
      test(lower) {
        if (new RegExp(String.raw`^\s*(?:please\s+)?${ON}\s+shuffle\s*[?.!]*$|^\s*shuffle\s+on\s*[?.!]*$|^\s*(?:please\s+)?shuffle\s+(?:the\s+|my\s+)?(?:music|songs?|playlist|queue|tracks?)\s*[?.!]*$`).test(lower)) {
          return plan(step('media.shuffle', { on: true }), 'shuffle');
        }
        if (new RegExp(String.raw`^\s*(?:please\s+)?${OFF}\s+shuffle\s*[?.!]*$|^\s*shuffle\s+off\s*[?.!]*$`).test(lower)) {
          return plan(step('media.shuffle', { on: false }), 'shuffle');
        }
        return null;
      },
    },
  ];
}
