/**
 * Everyday phrasings the coverage corpus (`test/coverage/corpus.ts`) showed the grammar missing or
 * misreading. Each rule here exists because a specific sentence failed in a measured run; none replaces an
 * earlier rule, they only claim sentences that either went unmatched (and would have cost a model call) or
 * were read as the wrong thing ("show my biggest files" as a folder called "biggest files").
 *
 * They route to skills that already exist, with the arguments those skills already take.
 */

import type { GrammarRule } from './grammar';
import { plan, step } from './grammar';

const END = String.raw`\s*[?.!]*$`;
const tidy = (s: string) => s.trim().replace(/\s+/g, ' ');

/** "D drive" / "my D: drive" / "drive D" → "D:". Anything else is passed through as the person said it. */
function placeFrom(spoken: string | undefined): string {
  const text = tidy(spoken ?? '').replace(/^(?:my|the)\s+/i, '');
  if (!text) return 'home';
  const drive = /^(?:drive\s+)?([a-z]):?(?:\s+drive)?$/i.exec(text);
  return drive ? `${drive[1]!.toUpperCase()}:` : text;
}

export function createPhrasingGrammar(): GrammarRule[] {
  return [
    {
      // "show my biggest files", "what are the largest files on my D drive", "list the heaviest files in downloads".
      name: 'biggestFiles',
      order: -6.86,
      pathSafe: true,
      questionSafe: ['largest-files'],
      test(_lower, raw) {
        const m = new RegExp(
          String.raw`^\s*(?:please\s+)?(?:show|list|find|get|what\s+are|which\s+are|what(?:['’]s|\s+is))(?:\s+me)?\s+(?:my\s+|the\s+)?(?:biggest|largest|heaviest)\s+files?(?:\s+(?:on|in|from)\s+(.+?))?${END}`,
          'i',
        ).exec(raw);
        return m ? plan(step('storage.largestFiles', { path: placeFrom(m[1]) }), 'largest-files') : null;
      },
    },
    {
      // "mute my computer": the computer is not an app.
      name: 'muteComputer',
      order: -5.3,
      test(lower) {
        const m = /^\s*(?:please\s+)?(un)?mute\s+(?:my\s+|the\s+)?(?:computer|pc|laptop|speakers?|everything|system)\s*[?.!]*$/.exec(lower);
        return m ? plan(step('system.mute', { state: m[1] ? 'unmute' : 'mute' }), 'mute') : null;
      },
    },
    {
      // "what is using the most memory", "what's taking up all my ram".
      name: 'memoryHog',
      order: -6.95,
      questionSafe: ['processes'],
      test(lower) {
        return /^\s*(?:what(?:['’]?s|\s+is)|which\s+(?:program|app|process)\s+is)\s+(?:using|eating|hogging|taking\s+up)\s+(?:up\s+)?(?:the\s+|all\s+(?:of\s+)?)?(?:most|all)?\s*(?:of\s+)?(?:my\s+)?(?:memory|ram|cpu)\s*[?.!]*$/.test(lower)
          ? plan(step('system.processes', {}), 'processes')
          : null;
      },
    },
    {
      // "screenshot my screen", "take a screen grab", "grab a screenshot of the desktop".
      name: 'screenshotPhrases',
      order: -6.65,
      test(lower) {
        return /^\s*(?:please\s+)?(?:take\s+|grab\s+|get\s+|make\s+)?(?:a\s+)?(?:screenshot|screen\s*shot|screen\s*grab|screen\s*cap(?:ture)?)(?:\s+of)?(?:\s+(?:my|the))?(?:\s+(?:whole\s+)?(?:screen|desktop|display|monitor))?\s*[?.!]*$/.test(lower) &&
          // the bare "take a screenshot" belongs to the earlier rule; this adds the longer ways of saying it
          lower.trim().replace(/[?.!]+$/, '') !== 'screenshot'
          ? plan(step('screen.capture', {}), 'screenshot')
          : null;
      },
    },
    {
      // "find lofi beats on youtube", "look up cat videos on youtube".
      name: 'findOnYoutube',
      order: -6.3,
      pathSafe: true,
      test(_lower, raw) {
        const m = new RegExp(String.raw`^\s*(?:please\s+)?(?:find|look\s+up|search\s+for|show\s+me|look\s+for)\s+(.+?)\s+on\s+youtube${END}`, 'i').exec(raw);
        return m?.[1] ? plan(step('web.searchYoutube', { query: tidy(m[1]) }), 'youtube-search') : null;
      },
    },
    {
      // "search wikipedia for nikola tesla", "find nikola tesla on wikipedia".
      name: 'wikipediaPhrases',
      order: -6.31,
      pathSafe: true,
      test(_lower, raw) {
        const m =
          new RegExp(String.raw`^\s*(?:please\s+)?(?:search|look\s+up|find)\s+wikipedia\s+for\s+(.+?)${END}`, 'i').exec(raw) ??
          new RegExp(String.raw`^\s*(?:please\s+)?(?:find|look\s+up|search\s+for)\s+(.+?)\s+on\s+wikipedia${END}`, 'i').exec(raw);
        return m?.[1] ? plan(step('web.searchWikipedia', { query: tidy(m[1]) }), 'wikipedia') : null;
      },
    },
    {
      // "find pizza on the map", "look up the eiffel tower on google maps".
      name: 'findOnMap',
      order: -6.32,
      pathSafe: true,
      test(_lower, raw) {
        const m = new RegExp(String.raw`^\s*(?:please\s+)?(?:find|look\s+up|search\s+for|show\s+me)\s+(.+?)\s+on\s+(?:the\s+|google\s+)?maps?${END}`, 'i').exec(raw);
        return m?.[1] ? plan(step('web.searchMaps', { place: tidy(m[1]) }), 'maps') : null;
      },
    },
  ];
}
