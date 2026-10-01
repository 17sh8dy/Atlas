/**
 * "maximize spotify", "close notepad", "bring discord to the front", "show
 * desktop", "keep notepad on top" — the window skills, reached by the way
 * people actually say it, without the word "window" on the end.
 *
 * `windowControl` (in extra-grammar) already handles "… the notepad window".
 * These rules exist for the bare form, and so must be careful about what a bare
 * verb is *not*: "close" on its own is Atlas dismissing itself, "restore my
 * backup" is not about a window, "focus mode" is not an app. A name that is one
 * of those is declined and left to whichever rule does mean it.
 */

import type { GrammarRule } from './grammar';
import { plan, step } from './grammar';

/** Things a bare verb plainly is not addressing a window about. */
const NOT_A_WINDOW =
  /^(?:atlas|yourself|this|that|it|them|those|these|everything|all|all\s+windows|windows?|tabs?|apps?|chat|me|up|down|mode|timer|on|off)$|\b(?:mode|backup|backups|recycle|deleted|default|defaults|settings|purchases|previous|session|system|files?|folders?|password|volume|sound|brightness)\b/i;

function name(s: string): string {
  return s
    .trim()
    .replace(/[?.!]+$/g, '')
    .replace(/^(?:the|my)\s+/i, '')
    .replace(/\s+(?:app|application|program)$/i, '')
    .trim();
}

export function createWindowGrammar(): GrammarRule[] {
  return [
    {
      name: 'windowControlBare',
      order: -6.685,
      test(lower) {
        const m = lower.match(/^\s*(?:please\s+)?(minimize|maximize|restore|close|focus)\s+(?:on\s+)?(.+?)\s*[?.!]*$/);
        if (!m) return null;
        const target = name(m[2]!);
        if (!target || NOT_A_WINDOW.test(target)) return null;
        // "close notepad++ window" etc. belongs to windowControl; here the word "window" is absent.
        if (/\bwindow$/.test(target)) return null;
        const verb = m[1]!;
        const skill = `window.${verb === 'close' ? 'close' : verb}`;
        return plan(step(skill, { name: target }), `window-${verb}`, 0.85);
      },
    },

    {
      name: 'windowToFront',
      order: -6.684,
      test(lower) {
        const m =
          lower.match(/^\s*(?:please\s+)?bring\s+(?:up\s+)?(.+?)\s+(?:to\s+the\s+)?(?:front|forward|top)\s*[?.!]*$/) ??
          lower.match(/^\s*(?:please\s+)?bring\s+(?:the\s+|my\s+)?(.+?)\s+(?:window\s+)?to\s+(?:the\s+)?(?:front|foreground)\s*[?.!]*$/);
        if (!m) return null;
        const target = name(m[1]!.replace(/\s+window$/, ''));
        if (!target || NOT_A_WINDOW.test(target)) return null;
        return plan(step('window.focus', { name: target }), 'window-focus', 0.85);
      },
    },

    {
      name: 'showDesktop',
      order: -6.683,
      test(lower) {
        if (
          /^\s*(?:please\s+)?(?:show|go\s+to|peek\s+at|reveal)\s+(?:the\s+|my\s+)?desktop\s*[?.!]*$/.test(lower) ||
          /^\s*(?:please\s+)?minimi[sz]e\s+(?:everything|all(?:\s+(?:the\s+)?windows)?|all\s+apps)\s*[?.!]*$/.test(lower) ||
          /^\s*(?:please\s+)?(?:clear|hide)\s+(?:all\s+)?(?:my\s+)?windows\s*[?.!]*$/.test(lower)
        ) {
          // Win+D: the same toggle the taskbar's right-hand corner gives.
          return plan(step('input.hotkey', { combo: 'win+d' }), 'show-desktop');
        }
        return null;
      },
    },

    {
      name: 'windowOnTop',
      order: -6.682,
      test(lower) {
        const pin =
          lower.match(/^\s*(?:please\s+)?(?:keep|pin|put|make)\s+(?:the\s+|my\s+)?(.+?)\s+(?:window\s+)?(?:always\s+)?on\s+top(?:\s+of\s+(?:everything|all|other\s+windows))?\s*[?.!]*$/) ??
          lower.match(/^\s*(?:please\s+)?(?:keep|pin|put|make)\s+(?:the\s+|my\s+)?(.+?)\s+(?:window\s+)?(?:so\s+it\s+)?(?:stays?\s+)?always\s+on\s+top\s*[?.!]*$/);
        if (pin) {
          const target = name(pin[1]!.replace(/\s+window$/, ''));
          if (target && !NOT_A_WINDOW.test(target)) return plan(step('window.pin', { name: target }), 'window-pin', 0.85);
        }
        const unpin =
          lower.match(/^\s*(?:please\s+)?(?:unpin|stop\s+keeping)\s+(?:the\s+|my\s+)?(.+?)(?:\s+window)?(?:\s+(?:from\s+)?(?:being\s+)?on\s+top)?\s*[?.!]*$/) ??
          lower.match(/^\s*(?:please\s+)?(?:take|remove)\s+(?:the\s+|my\s+)?(.+?)\s+(?:window\s+)?off\s+(?:of\s+)?(?:always\s+)?(?:on\s+)?top\s*[?.!]*$/);
        if (unpin) {
          const target = name(unpin[1]!.replace(/\s+window$/, ''));
          if (target && !NOT_A_WINDOW.test(target)) return plan(step('window.unpin', { name: target }), 'window-unpin', 0.85);
        }
        return null;
      },
    },
  ];
}
