/**
 * Phrasings for sleep, a shutdown on a timer, the exact volume, the microphone
 * and dark mode.
 *
 * These sit *ahead of* `systemPower` (-5.19): that rule reads "shut down … pc"
 * anywhere in a sentence, so "shut down the pc in 30 minutes" would otherwise
 * shut it down now. A delay has to be noticed first.
 */

import type { GrammarRule } from './grammar';
import { plan, step } from './grammar';
import { durationMs } from '../text/when';

const PC = String.raw`(?:(?:the|my|this)\s+)?(?:pc|computer|laptop|machine|windows|system)`;

export function createSystemGrammar(): GrammarRule[] {
  return [
    {
      name: 'netPing',
      order: -5.35,
      questionSafe: ['ping'],
      test(_lower, raw) {
        const m = raw.match(
          /^\s*(?:please\s+)?(?:can\s+you\s+|could\s+you\s+)?ping\s+(?:(?:to|at)\s+)?(?:https?:\/\/)?([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?:\/\S*)?\s*[?.!]*$/i,
        );
        if (!m) return null;
        return plan(step('net.ping', { host: m[1]! }), 'ping');
      },
    },

    {
      name: 'systemSleep',
      order: -5.3,
      test(lower) {
        if (
          new RegExp(
            String.raw`^\s*(?:please\s+)?(?:put\s+${PC}\s+(?:to|into)\s+sleep|put\s+it\s+(?:to|into)\s+sleep|go\s+to\s+sleep|sleep(?:\s+${PC})?(?:\s+(?:mode|now))?|suspend(?:\s+${PC})?)\s*[?.!]*$`,
          ).test(lower)
        ) {
          return plan(step('system.sleep', { kind: 'sleep' }), 'sleep');
        }
        if (
          new RegExp(
            String.raw`^\s*(?:please\s+)?(?:hibernate(?:\s+${PC})?(?:\s+now)?|put\s+${PC}\s+(?:to|into)\s+hibernat(?:e|ion)|put\s+it\s+(?:to|into)\s+hibernat(?:e|ion)|go\s+(?:to|into)\s+hibernat(?:e|ion))\s*[?.!]*$`,
          ).test(lower)
        ) {
          return plan(step('system.sleep', { kind: 'hibernate' }), 'hibernate');
        }
        return null;
      },
    },

    {
      name: 'systemShutdownIn',
      order: -5.29,
      test(lower) {
        const m = lower.match(
          new RegExp(
            String.raw`^\s*(?:please\s+)?(shut\s?down|power\s+off|turn\s+off|restart|reboot)(?:\s+${PC})?\s+(?:in|after)\s+(.+?)\s*[?.!]*$`,
          ),
        );
        if (!m) return null;
        const ms = durationMs(m[2]!);
        if (!ms) return null;
        const action = /restart|reboot/.test(m[1]!) ? 'restart' : 'shutdown';
        return plan(step('system.shutdownIn', { action, seconds: Math.round(ms / 1000) }), 'shutdown-in');
      },
    },

    {
      name: 'systemShutdownCancel',
      order: -5.285,
      test(lower) {
        if (
          /^\s*(?:please\s+)?(?:cancel|abort|stop|undo)\s+(?:the\s+|my\s+)?(?:scheduled\s+|pending\s+)?(?:shut\s?down|restart|reboot)(?:\s+timer)?\s*[?.!]*$/.test(
            lower,
          )
        ) {
          return plan(step('system.shutdownCancel', {}), 'shutdown-cancel');
        }
        return null;
      },
    },

    {
      name: 'systemVolumeSet',
      order: -5.25,
      questionSafe: ['volume-get'],
      test(lower) {
        // "what is the volume" / "how loud is it"
        if (/^\s*(?:what(?:['’]?s|\s+is)\s+(?:the\s+|my\s+)?(?:current\s+)?(?:volume|sound level)|how\s+loud\s+is\s+it)\s*[?.!]*$/.test(lower)) {
          return plan(step('system.volumeSet', {}), 'volume-get');
        }
        // "set the volume to 30", "volume to 30%", "volume 30", "turn the sound to 50 percent"
        const n = lower.match(
          /^\s*(?:please\s+)?(?:(?:set|change|turn|put|make|bring)\s+)?(?:the\s+|my\s+)?(?:volume|sound)(?:\s+level)?\s*(?:to|at|=)?\s*(\d{1,3})\s*(?:%|percent)?\s*[?.!]*$/,
        );
        if (n) return plan(step('system.volumeSet', { level: Number(n[1]) }), 'volume-set');
        // "volume to half" / "max volume" / "full volume"
        if (/^\s*(?:(?:set|turn|put)\s+)?(?:the\s+)?volume\s+(?:to\s+)?half\s*[?.!]*$/.test(lower)) {
          return plan(step('system.volumeSet', { level: 50 }), 'volume-set');
        }
        if (
          /^\s*(?:(?:set|turn|put)\s+)?(?:the\s+)?(?:max(?:imum)?|full)\s+volume\s*[?.!]*$/.test(lower) ||
          /^\s*(?:(?:set|turn|put)\s+)?(?:the\s+)?volume\s+(?:to\s+)?(?:max(?:imum)?|full)\s*[?.!]*$/.test(lower)
        ) {
          return plan(step('system.volumeSet', { level: 100 }), 'volume-set');
        }
        return null;
      },
    },

    {
      name: 'systemMic',
      order: -5.24,
      questionSafe: ['mic-status'],
      test(lower) {
        const MIC = String.raw`(?:mic|microphone)`;
        const m = lower.match(
          new RegExp(String.raw`^\s*(?:please\s+)?(mute|unmute)\s+(?:(?:my|the)\s+)?${MIC}\s*[?.!]*$`),
        );
        if (m) return plan(step('system.micMute', { state: m[1]! }), 'mic-mute');
        const onOff = lower.match(
          new RegExp(String.raw`^\s*(?:please\s+)?turn\s+(on|off)\s+(?:(?:my|the)\s+)?${MIC}\s*[?.!]*$`),
        );
        if (onOff) {
          return plan(step('system.micMute', { state: onOff[1] === 'off' ? 'mute' : 'unmute' }), 'mic-mute');
        }
        if (new RegExp(String.raw`^\s*(?:is|are)\s+(?:my|the)\s+${MIC}\s+(?:muted|on|off)\s*[?.!]*$`).test(lower) ||
          /^\s*am\s+i\s+muted\s*[?.!]*$/.test(lower)) {
          return plan(step('system.micMute', { state: 'status' }), 'mic-status');
        }
        const level = lower.match(
          new RegExp(
            String.raw`^\s*(?:please\s+)?(?:set|change|turn|put|make)\s+(?:(?:my|the)\s+)?${MIC}(?:\s+(?:volume|level|input(?:\s+level)?))?\s*(?:to|at)\s*(\d{1,3})\s*(?:%|percent)?\s*[?.!]*$`,
          ),
        );
        if (level) return plan(step('system.micLevel', { level: Number(level[1]) }), 'mic-level');
        return null;
      },
    },

    {
      // Ahead of `switchToWindow` (-6.545): "switch to dark mode" is not a window.
      name: 'systemTheme',
      order: -6.6,
      test(lower) {
        const on = /^\s*(?:please\s+)?(?:turn\s+on|enable|switch\s+to|use|go|put\s+(?:windows|it)\s+in|activate)\s+dark\s+mode\s*[?.!]*$|^\s*dark\s+mode\s+on\s*[?.!]*$|^\s*(?:switch\s+to|go|use|turn\s+on|enable)\s+(?:the\s+)?dark\s+theme\s*[?.!]*$/;
        const off = /^\s*(?:please\s+)?(?:turn\s+off|disable)\s+dark\s+mode\s*[?.!]*$|^\s*dark\s+mode\s+off\s*[?.!]*$|^\s*(?:turn\s+on|enable|switch\s+to|use|go|put\s+(?:windows|it)\s+in|activate)\s+light\s+mode\s*[?.!]*$|^\s*(?:switch\s+to|use)\s+(?:the\s+)?light\s+theme\s*[?.!]*$/;
        if (on.test(lower)) return plan(step('system.theme', { mode: 'dark' }), 'theme');
        if (off.test(lower)) return plan(step('system.theme', { mode: 'light' }), 'theme');
        if (/^\s*(?:toggle|flip|switch)\s+(?:dark\s+mode|the\s+theme|dark\s+and\s+light(?:\s+mode)?)\s*[?.!]*$/.test(lower)) {
          return plan(step('system.theme', { mode: 'toggle' }), 'theme');
        }
        return null;
      },
    },
  ];
}
