/**
 * "Does this question need the web?" — the routing decision.
 *
 * ── Why rules, and why they come first ─────────────────────────────────────
 * The first version of this was one regex of eight freshness words, and it
 * missed the most natural example there is: "What season of Fortnite is it?"
 * contains none of them. The fix is not a smarter regex, it is naming the
 * *kinds* of question whose answer changes over time — a season, a version, a
 * score, a price, an outage, who currently holds a role — and matching those
 * shapes.
 *
 * Deterministic on purpose. It runs before any model is involved, costs
 * nothing, works with no model connected, and can be tested with a table. A
 * trained classifier can later act as a second opinion for the ambiguous
 * middle; it must never be the only route, the same rule the rest of Atlas
 * follows for anything a documented phrasing depends on.
 *
 * ── Strong and weak signals ────────────────────────────────────────────────
 * A *strong* signal ("latest", "right now", "who won", "price of") is enough
 * alone. A *weak* one ("update", "new", "version") is common in questions that
 * are timeless — "how do I update a driver", "what's new in the language
 * spec" is arguable but "how do I write a new function" is not — so a weak
 * signal only counts when nothing marks the question as how-to or a request
 * to explain, define or compute.
 */

export type ResearchCategory =
  | 'explicit' // the user asked to search
  | 'recency' // latest / current / today / this week
  | 'news'
  | 'live' // scores, weather, outages, traffic
  | 'release' // seasons, versions, patches, release dates
  | 'price' // prices, stock, exchange rates
  | 'role' // who currently holds a position
  | 'dated'; // mentions a recent year

export interface RouteDecision {
  search: boolean;
  category: ResearchCategory | null;
  /** Shown in the activity panel, so it has to read like something a person would say. */
  reason: string;
  /** A hint for backends that distinguish news from general search. */
  topic: 'general' | 'news';
}

interface Rule {
  category: ResearchCategory;
  pattern: RegExp;
  strong: boolean;
  reason: string;
}

const RULES: Rule[] = [
  {
    category: 'explicit',
    // An imperative at the start. "how do I search for a substring in Python"
    // is a question about code, not a request to search the web.
    pattern:
      /^\s*(?:(?:please|hey|ok(?:ay)?)\s+)*(?:(?:can|could|would) you\s+)?(?:search|google|look\s*up|look\s+into|research)\b/i,
    strong: true,
    reason: 'you asked me to search',
  },
  {
    category: 'live',
    pattern:
      /\b(?:who won|who'?s winning|final score|the score|scores?\b.*\b(?:game|match)|weather|forecast|temperature (?:in|at)|is .{1,40} (?:down|offline|having (?:issues|problems)|experiencing)\b|(?:outage|status page)|traffic (?:in|on|near)|standings|league table|live (?:score|stream)s?)\b/i,
    strong: true,
    reason: 'it is live information',
  },
  {
    category: 'release',
    pattern:
      /\b(?:what|which) (?:season|chapter|version|patch|update|episode|build|release|generation|edition)\b|\b(?:season|chapter|version|patch|build) (?:is it|are we|are they)\b|\b(?:release date|come[s]? out|coming out|released yet|out yet|patch notes|changelog|roadmap)\b|\bwhen (?:is|does|will|did) .{1,60} (?:release|launch|come out|come|start|end|drop|air|premiere)\b|\bwhat(?:'s| is) the (?:newest|latest|current) /i,
    strong: true,
    reason: 'it is about a release or version',
  },
  {
    category: 'price',
    pattern:
      /\b(?:price of|prices? for|how much (?:is|does|are|do) .{1,50}(?:cost|now|worth)|stock (?:price|market)|exchange rate|worth right now|(?:btc|eth|bitcoin|ethereum) price|market cap|mortgage rates?|gas prices?)\b/i,
    strong: true,
    reason: 'prices change',
  },
  {
    category: 'role',
    pattern:
      /\bwho (?:is|'s|are) (?:the |our )?(?:current |new |present )?(?:president|prime minister|ceo|leader|mayor|governor|champion|coach|manager|owner|head|chairman|secretary|speaker|chancellor|king|queen)\b/i,
    strong: true,
    reason: 'who holds a role can change',
  },
  {
    category: 'news',
    pattern:
      /\b(?:breaking news|in the news|news (?:about|on|for)|headlines?|just (?:released|announced|happened|dropped))\b|\bnews\b/i,
    strong: true,
    reason: 'it is about recent events',
  },
  {
    category: 'recency',
    pattern:
      /\b(?:latest|newest|most recent|current(?:ly)?|right now|as of now|these days|nowadays|today|tonight|tomorrow|yesterday|this (?:week|weekend|month|year|season|morning|evening)|last (?:night|week))\b/i,
    strong: true,
    reason: 'the answer changes over time',
  },
  {
    category: 'dated',
    pattern:
      /\b(?:in|for|during|of|since|by)\s+20(?:2[5-9]|[3-9]\d)\b|\b20(?:2[5-9]|[3-9]\d)\s+(?:season|update|release|model|edition|results?|schedule|calendar)\b/i,
    strong: true,
    reason: 'it names a recent year',
  },
  // ---- weak: only count when the question is not how-to / definitional ----
  {
    category: 'release',
    pattern:
      /\b(?:updates?|patch(?:es)?|new (?:version|release|model|feature|season)|version\s*\d|v\d+(?:\.\d+)+|season\s*\d+|chapter\s*\d+)\b/i,
    strong: false,
    reason: 'it may be about a recent release',
  },
  {
    category: 'recency',
    pattern: /\b(?:new|newly|recent(?:ly)?|still|anymore|yet)\b/i,
    strong: false,
    reason: 'it may need up-to-date information',
  },
];

/**
 * Shapes that mark a question as answerable from general knowledge or a
 * calculation. They suppress *weak* signals only: "how do I update Windows"
 * stays offline, "how do I update Windows to the latest version" does not.
 */
const TIMELESS = new RegExp(
  String.raw`^\s*(?:how (?:do|can|could|should|would) (?:i|you|we)|how to|why (?:do|does|is|are|did)|explain|define|what does .{1,60} mean|what(?:'s| is) (?:the )?(?:difference|meaning|definition|purpose)|write|create|generate|make me|draw|translate|convert|calculate|solve|summari[sz]e|rewrite|fix|debug|tell me a (?:joke|story)|give me an? (?:example|explanation))\b`,
  'i',
);

/**
 * A programming question. "How do I get today's date in Python" carries a
 * recency word and has nothing to do with the present — so this suppresses
 * the *recency* and *dated* signals too, not just the weak ones. A release or
 * price question is never suppressed by it: "what's the newest feature in
 * Python" really is about now.
 */
const CODEY =
  /\b(?:in|using|with) (?:python|javascript|typescript|rust|c\+\+|c#|java|sql|bash|powershell|regex|css|html)\b|\b(?:algorithm|function|variable|syntax|for loop|stack ?trace|compile[rd]?|refactor)\b/i;

const NO: RouteDecision = { search: false, category: null, reason: '', topic: 'general' };

export function routeQuestion(text: string): RouteDecision {
  const t = text.trim();
  if (!t) return NO;

  const codey = CODEY.test(t);

  // Strong signals win outright, in rule order (the order is the priority).
  for (const rule of RULES) {
    if (codey && (rule.category === 'recency' || rule.category === 'dated')) continue;
    if (rule.strong && rule.pattern.test(t)) {
      return {
        search: true,
        category: rule.category,
        reason: rule.reason,
        topic: rule.category === 'news' || rule.category === 'live' ? 'news' : 'general',
      };
    }
  }

  if (TIMELESS.test(t) || codey) return NO;

  for (const rule of RULES) {
    if (!rule.strong && rule.pattern.test(t)) {
      return { search: true, category: rule.category, reason: rule.reason, topic: 'general' };
    }
  }
  return NO;
}

/** The old boolean entry point, kept so every existing call site and test keeps its meaning. */
export function needsWebSearch(text: string): boolean {
  return routeQuestion(text).search;
}
