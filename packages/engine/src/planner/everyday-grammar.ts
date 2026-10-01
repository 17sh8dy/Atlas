/**
 * Email and calendar phrasings, the look-it-up questions (define, translate,
 * weather, news, stocks, sports, travel time) and "move X to my second monitor".
 *
 * The look-it-up ones are deliberately thin: they are web searches the person
 * asked for, handed to the existing `web.*` skills. Atlas does not poll weather
 * or news by itself (see "Deliberately not doing") — it opens a search when told to.
 */

import type { GrammarRule } from './grammar';
import { plan, step } from './grammar';
import { splitWhen } from '../text/when';

const EMAIL = String.raw`[^\s@,;<>()"']+@[^\s@,;<>()"']+\.[^\s@,;<>()"']{2,}`;

function tidy(s: string): string {
  return s
    .trim()
    .replace(/[?.!]+$/g, '')
    .replace(/^["'“‘]|["'”’]$/g, '')
    .trim();
}

const LANGUAGES: Record<string, string> = {
  spanish: 'es', french: 'fr', german: 'de', italian: 'it', portuguese: 'pt', dutch: 'nl', russian: 'ru',
  japanese: 'ja', korean: 'ko', chinese: 'zh-CN', mandarin: 'zh-CN', arabic: 'ar', hindi: 'hi', turkish: 'tr',
  polish: 'pl', swedish: 'sv', norwegian: 'no', danish: 'da', finnish: 'fi', greek: 'el', hebrew: 'iw',
  vietnamese: 'vi', thai: 'th', indonesian: 'id', ukrainian: 'uk', czech: 'cs', romanian: 'ro', hungarian: 'hu',
  english: 'en', latin: 'la', swahili: 'sw', filipino: 'tl', tagalog: 'tl',
};

const ORDINAL: Record<string, number> = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4 };

export function createEverydayGrammar(): GrammarRule[] {
  return [
    {
      name: 'mailCompose',
      order: -9.9,
      test(_lower, raw) {
        // "email bob@x.com about the meeting saying see you at 3"
        const direct = new RegExp(
          String.raw`^\s*(?:please\s+)?(?:send\s+(?:an?\s+)?)?(?:e-?mail|mail)\s+(${EMAIL}(?:\s*(?:,|and)\s*${EMAIL})*)(?:\s+(?:about|regarding|re:?|with\s+(?:the\s+)?subject)\s+(.+?))?(?:\s+(?:saying|that\s+says|with\s+(?:the\s+)?(?:message|body)|:)\s*(.+))?\s*[.!]*$`,
          'i',
        ).exec(raw);
        const asked = new RegExp(
          String.raw`^\s*(?:please\s+)?(?:send|write|compose|draft|start|create)\s+(?:an?\s+)?(?:new\s+)?e-?mail(?:\s+to\s+(${EMAIL}(?:\s*(?:,|and)\s*${EMAIL})*))?(?:\s+(?:about|regarding|with\s+(?:the\s+)?subject)\s+(.+?))?(?:\s+(?:saying|that\s+says|with\s+(?:the\s+)?(?:message|body))\s+(.+))?\s*[.!]*$`,
          'i',
        ).exec(raw);
        const m = direct ?? asked;
        if (!m) return null;
        const args: Record<string, string> = {};
        if (m[1]) args.to = m[1].replace(/\s*(?:,|and)\s*/gi, ',');
        if (m[2]) args.subject = tidy(m[2]);
        if (m[3]) args.body = tidy(m[3]);
        return plan(step('mail.compose', args), 'mail-compose');
      },
    },

    {
      name: 'calendarAdd',
      order: -9.89,
      test(_lower, raw) {
        const m =
          raw.match(/^\s*(?:please\s+)?(?:add|put|schedule|set\s+up|create|book)\s+(?:an?\s+)?(?:new\s+)?(?:calendar\s+)?(?:event|meeting|appointment|reminder)?\s*(?:called\s+|named\s+|for\s+)?(.+?)\s+(?:to|on|in)\s+(?:my\s+)?calendar(?:\s+(.+))?\s*[?.!]*$/i) ??
          raw.match(/^\s*(?:please\s+)?(?:schedule|book|set\s+up)\s+(?:an?\s+)?(?:new\s+)?(?:calendar\s+)?(?:event|meeting|appointment)?\s*(?:called\s+|named\s+)?(.+?)\s*[?.!]*$/i) ??
          raw.match(/^\s*(?:please\s+)?(?:create|make|add)\s+(?:an?\s+)?(?:new\s+)?calendar\s+event\s+(?:called\s+|named\s+|for\s+)?(.+?)\s*[?.!]*$/i);
        if (!m) return null;
        // The time is either a trailing phrase after "calendar", or the end of the title.
        let title = tidy(m[1]!);
        let whenText = m[2] ? tidy(m[2]) : '';
        if (!whenText) {
          const split = splitWhen(title);
          if (!split) return null; // no time named: not enough to make an event
          title = split.what;
          whenText = split.when.matched;
        } else if (!/^(?:in|at|on|tomorrow|tonight|today|this|next|every|(?:mon|tues|wednes|thurs|fri|satur|sun)day)\b/i.test(whenText)) {
          whenText = `at ${whenText}`;
        }
        if (!title) return null;
        return plan(step('calendar.add', { title, when: whenText }), 'calendar-add');
      },
    },

    {
      name: 'lookupDefine',
      order: -9.4,
      questionSafe: ['define'],
      test(_lower, raw) {
        const m =
          raw.match(/^\s*(?:please\s+)?define\s+(.+?)\s*[?.!]*$/i) ??
          raw.match(/^\s*what\s+does\s+(.+?)\s+mean\s*[?.!]*$/i) ??
          raw.match(/^\s*(?:what(?:['’]?s|\s+is)\s+the\s+)?meaning\s+of\s+(.+?)\s*[?.!]*$/i);
        if (!m) return null;
        const word = tidy(m[1]!);
        if (!word || word.split(/\s+/).length > 4) return null;
        return plan(step('web.search', { query: `define ${word}` }), 'define');
      },
    },

    {
      name: 'lookupTranslate',
      order: -9.39,
      questionSafe: ['translate'],
      test(_lower, raw) {
        const m =
          raw.match(/^\s*(?:please\s+)?translate\s+(.+?)\s+(?:in)?to\s+([a-z]+)\s*[?.!]*$/i) ??
          raw.match(/^\s*how\s+(?:do\s+you|would\s+you|do\s+i|to)\s+say\s+(.+?)\s+in\s+([a-z]+)\s*[?.!]*$/i) ??
          raw.match(/^\s*what(?:['’]?s|\s+is)\s+(.+?)\s+in\s+([a-z]+)\s*[?.!]*$/i);
        if (!m) return null;
        const lang = LANGUAGES[m[2]!.toLowerCase()];
        if (!lang) return null;
        const text = tidy(m[1]!);
        if (!text) return null;
        return plan(
          step('web.open', { url: `https://translate.google.com/?sl=auto&tl=${lang}&text=${encodeURIComponent(text)}&op=translate` }),
          'translate',
        );
      },
    },

    {
      name: 'lookupWeather',
      order: -9.38,
      questionSafe: ['weather'],
      test(_lower, raw) {
        const m =
          raw.match(/^\s*(?:what(?:['’]?s|\s+is)\s+the\s+|how(?:['’]?s|\s+is)\s+the\s+|show\s+(?:me\s+)?the\s+)?weather(?:\s+(?:like\s+)?(?:in|for|at)\s+(.+?))?(?:\s+(?:today|tomorrow|this\s+week|right\s+now|now))?\s*[?.!]*$/i) ??
          raw.match(/^\s*(?:will\s+it|is\s+it\s+going\s+to)\s+(?:rain|snow)(?:\s+(?:today|tomorrow|tonight))?(?:\s+in\s+(.+?))?\s*[?.!]*$/i);
        if (!m) return null;
        const place = m[1] ? tidy(m[1]) : '';
        return plan(step('web.search', { query: place ? `weather ${place}` : 'weather' }), 'weather');
      },
    },

    {
      name: 'lookupNewsStocksSports',
      order: -9.37,
      questionSafe: ['news', 'stocks', 'sports'],
      test(_lower, raw) {
        const news = raw.match(/^\s*(?:show\s+(?:me\s+)?|what(?:['’]?s|\s+is)\s+)?(?:the\s+)?(?:latest\s+|top\s+|today['’]?s\s+)?(?:news|headlines)(?:\s+(?:about|on|for)\s+(.+?))?\s*[?.!]*$/i);
        if (news && /news|headlines/i.test(raw)) {
          return plan(step('web.search', { query: news[1] ? `${tidy(news[1])} news` : 'latest news' }), 'news');
        }
        const stock = raw.match(/^\s*(?:what(?:['’]?s|\s+is)\s+)?(?:the\s+)?(?:(?:stock\s+)?price\s+of|stock\s+price\s+(?:for|of))\s+(.+?)\s*[?.!]*$/i) ?? raw.match(/^\s*how(?:['’]?s|\s+is)\s+(.+?)\s+(?:stock\s+)?(?:doing|trading)\s*[?.!]*$/i);
        if (stock && /stock|price|trading/i.test(raw)) {
          return plan(step('web.search', { query: `${tidy(stock[1]!)} stock price` }), 'stocks');
        }
        const sport = raw.match(/^\s*(?:what(?:['’]?s|\s+is)\s+the\s+score\s+(?:of|in|for)\s+(?:the\s+)?(.+?)|who\s+(?:won|is\s+winning)\s+(?:the\s+)?(.+?))\s*[?.!]*$/i);
        if (sport) return plan(step('web.search', { query: `${tidy(sport[1] ?? sport[2]!)} score` }), 'sports');
        return null;
      },
    },

    {
      name: 'lookupTravelTime',
      order: -9.36,
      questionSafe: ['travel-time'],
      test(_lower, raw) {
        const m =
          raw.match(/^\s*how\s+long\s+(?:does\s+it\s+take\s+)?(?:to\s+)?(?:drive|get|walk|travel|go|bike|cycle)\s+(?:to|from\s+here\s+to)\s+(.+?)\s*[?.!]*$/i) ??
          raw.match(/^\s*(?:what(?:['’]?s|\s+is)\s+)?(?:the\s+)?(?:travel|drive|driving|commute)\s+time\s+to\s+(.+?)\s*[?.!]*$/i);
        if (!m) return null;
        return plan(step('web.searchMaps', { query: tidy(m[1]!), directions: true }), 'travel-time');
      },
    },

    {
      name: 'windowToMonitor',
      order: -11.41,
      test(_lower, raw) {
        const m =
          raw.match(/^\s*(?:please\s+)?(?:move|send|put|drag|throw)\s+(.+?)\s+(?:over\s+)?(?:to|onto|on)\s+(?:the\s+|my\s+)?(first|second|third|fourth|1st|2nd|3rd|4th)\s+(?:monitor|screen|display)\s*[.!]*$/i) ??
          raw.match(/^\s*(?:please\s+)?(?:move|send|put)\s+(.+?)\s+(?:to|onto|on)\s+(?:monitor|screen|display)\s+(\d)\s*[.!]*$/i);
        if (!m) return null;
        const display = ORDINAL[m[2]!.toLowerCase()] ?? Number(m[2]);
        const name = tidy(m[1]!).replace(/^(?:the|my)\s+/i, '').replace(/\s+window$/i, '');
        if (!name || !display) return null;
        return plan(step('window.place', { name, position: 'center', display }), 'window-to-monitor');
      },
    },
  ];
}
