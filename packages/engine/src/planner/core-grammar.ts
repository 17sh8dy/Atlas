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

export function createCoreGrammar(): GrammarRule[] {
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
        return plan(step(/reveal/i.test(raw) ? 'files.reveal' : 'files.open', { path: target }), 'open-path');
      },
    },

    // --- Open a URL ----------------------------------------------------------
    {
      name: 'openUrl',
      order: -8,
      test(_lower, raw) {
        const captured = raw.match(/^\s*(?:open|go to|visit|browse)\s+(https?:\/\/\S+|[\w-]+\.[a-z]{2,}(?:\/\S*)?)\s*$/i)?.[1];
        if (!captured) return null;
        const url = captured.startsWith('http') ? captured : `https://${captured}`;
        return plan(step('web.open', { url }), 'open-url');
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

    // --- List apps ------------------------------------------------------------
    {
      name: 'appList',
      order: -6,
      questionSafe: ['app-list'],
      test(lower) {
        if (
          /\b(what|which)\s+(apps?|applications?|programs?)\b.*\b(installed|do i have|are there)\b/.test(lower) ||
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
        if (/^\s*(?:hide|dismiss|close|go away|never ?mind)\s*(?:atlas|yourself|this)?\s*[?.!]*$/.test(lower)) {
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

    // --- Open an application ---------------------------------------------------
    // Last, because it's the greediest: anything still shaped like "open X"
    // after the specific rules have declined is treated as an app name.
    {
      name: 'appOpen',
      order: -1,
      pathSafe: false,
      test(_lower, raw) {
        const captured = raw.match(/^\s*(?:open|launch|start|run)\s+(.+?)\s*[?.!]*$/i)?.[1];
        if (!captured) return null;

        const target = clean(captured);
        if (!target) return null;
        // "open it" names something in working memory, not an application.
        if (REFERENTIAL.test(target)) return null;
        // File talk belongs to the file rules, which already had their turn.
        if (FILE_NOUN.test(target)) return null;

        // Slightly under the usual grammar confidence: the app might not exist,
        // and the skill will say so.
        return plan(step('app.open', { name: target }), 'open-app', 0.85);
      },
    },
  ];
}

function detectKind(text: string): string | null {
  if (/\b(pdf|document|documents|doc|docx|report|invoice|resume|cv|note|notes)\b/i.test(text)) return 'document';
  if (/\b(photo|photos|picture|pictures|image|images|screenshot|screenshots)\b/i.test(text)) return 'image';
  if (/\b(video|videos|movie|movies|clip|clips)\b/i.test(text)) return 'video';
  if (/\b(song|songs|music|audio|track|tracks)\b/i.test(text)) return 'audio';
  if (/\b(zip|archive|rar)\b/i.test(text)) return 'archive';
  if (/\b(folder|folders|directory|directories)\b/i.test(text)) return 'folder';
  return null;
}
