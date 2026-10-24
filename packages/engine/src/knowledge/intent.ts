/**
 * What a question is about, worked out by plain rules: no model, no network.
 *
 * Its first job is a gate. The knowledge tier answers questions *about Atlas and Nova*, so it must not
 * stand in the way of anything else: "what is the capital of Peru?" is not for it, and neither is an
 * instruction. A message is a knowledge question only when it is question-shaped AND it names a Nova
 * product, a topic Atlas has documentation on, or speaks to Atlas itself ("you", "your").
 *
 * Its second job is to say what kind of answer is wanted: a fact (what/how/where/which), something
 * current ("what's new"), or something that needs reasoning (why/should/compare), because those are
 * answered differently (see `decide.ts`).
 */

export type Aspect = 'how' | 'what' | 'where' | 'which' | 'can' | 'why' | 'version' | 'list' | 'other';

export interface Intent {
  /** The question with slang expanded and manners removed. */
  text: string;
  topic: string | null;
  /** A Nova product the question names, if one: `atlas`, `replay-gg`, `nova-cut`, ... */
  product: string | null;
  aspect: Aspect;
  /** Speaks to Atlas itself: "you", "your", "atlas". */
  selfRef: boolean;
  /** Answering well takes judgement, not just a fact. */
  needsReasoning: boolean;
  /** About something that changes: latest, new, current. These prefer a live page over the pack. */
  current: boolean;
  /** The gate: is this a question the knowledge tier should even try? */
  isKnowledgeQuestion: boolean;
}

const SLANG: Array<[RegExp, string]> = [
  [/\bu\b/g, 'you'],
  [/\bur\b/g, 'your'],
  [/\bpls\b|\bplz\b/g, 'please'],
  [/\bwat\b|\bwhat's\b|\bwhats\b/g, 'what is'],
  [/\bhw\b/g, 'how'],
  [/\bdoesnt\b/g, 'does not'],
  [/\bdont\b/g, 'do not'],
  [/\bcant\b/g, 'can not'],
  [/\bcuz\b|\bcos\b/g, 'because'],
  [/\bthx\b/g, 'thanks'],
];

/** Greetings and manners that are not part of the question. */
const MANNERS = /^(?:hey|hi|hello|yo|ok|okay|so|um|uh|well)[\s,!.]+(?:atlas[\s,!.]+)?|^(?:atlas)[\s,!.]+|^(?:please|can you tell me|could you tell me|i was wondering|quick question)[\s,:]+/i;

export function cleanQuestion(raw: string): string {
  let t = ` ${raw.toLowerCase().trim()} `.replace(/\s+/g, ' ').trim();
  for (const [re, to] of SLANG) t = t.replace(re, to);
  for (let i = 0; i < 3; i++) t = t.replace(MANNERS, '');
  return t.replace(/\s+/g, ' ').trim();
}

/** Topics Atlas has documentation on, each with the words that point at it. */
const TOPICS: Array<[string, RegExp]> = [
  ['tokens', /\b(?:tokens?|token usage|token count(?:ing)?|monthly limit|usage cap|spend(?:ing)?|cost)\b/],
  ['privacy', /\b(?:privacy|private|my data|what (?:do|does|data)[^?]{0,20}send|sends?|offline|local(?:ly)?|cloud|telemetry|tracking)\b/],
  ['accounts', /\b(?:accounts?|sign(?:ing)? in|log ?in|nova account|password|sign ?up)\b/],
  ['updates', /\b(?:updates?|updating|version|release|releases|changelog|upgrade)\b/],
  ['models', /\b(?:models?|ollama|providers?|openai|anthropic|claude|gemini|llm|language model|intelligence|local ai)\b/],
  ['capabilities', /\b(?:capabilit(?:y|ies)|skills?|abilit(?:y|ies)|tools?|what can you do|features?)\b/],
  ['safety', /\b(?:safe|safety|secure|security|permission|confirm(?:ation)?|approve|halt|emergency stop|allowed folders?)\b/],
  ['install', /\b(?:install(?:ing|ation)?|download|uninstall|requirements?|system requirements|windows 1[01])\b/],
  ['voice', /\b(?:voice|speak|speech|microphone|listen(?:ing)?|wake word)\b/],
  ['pricing', /\b(?:price|pricing|free|paid|subscription|cost of|licen[cs]e|open source)\b/],
  ['knowledge', /\b(?:knowledge|documentation|docs|nova knowledge|knowledge pack)\b/],
];

const PRODUCTS: Array<[string, RegExp]> = [
  ['replay-gg', /\breplay(?:\.|\s|-)?gg\b|\breplay\b/],
  ['nova-cut', /\bnova ?cut\b/],
  ['novaos', /\bnova ?os\b/],
  ['nova-help', /\bnova(?:\.|\s)?help\b/],
  ['nova-review', /\bnova(?:\.|\s)?review\b/],
  ['nova-legal', /\bnova ?legal\b/],
  ['atlas', /\batlas\b/],
  ['nova', /\bnova\b/],
];

const SELF_REF = /\b(?:you|your|yours|yourself|atlas)\b/;

const CURRENT = /\b(?:latest|newest|current(?:ly)?|what is new|new in|what changed|recent(?:ly)?|just released|this (?:week|month)|release notes|changelog)\b/;

const REASONING = /\b(?:why|should i|better than|best|recommend|compare|versus|vs\.?|difference between|pros and cons|write|draft|summari[sz]e|explain (?:it )?(?:like|simply|to me)|help me (?:decide|choose))\b/;

const QUESTION_START = /^(?:what|whats|how|where|which|who|when|why|can|could|does|do|is|are|will|would|should|did|tell me|explain|describe|show me|list)\b/;

function aspectOf(t: string): Aspect {
  if (/^(?:what is new|what are the latest)|\b(?:version|latest|newest)\b/.test(t)) return 'version';
  if (/^(?:list|show me)\b|\bwhat (?:can|are|all)\b/.test(t)) return 'list';
  if (/^why\b/.test(t)) return 'why';
  if (/^how\b/.test(t)) return 'how';
  if (/^where\b/.test(t)) return 'where';
  if (/^which\b/.test(t)) return 'which';
  if (/^(?:can|could|does|do|is|are|will)\b/.test(t)) return 'can';
  if (/^(?:what|who|tell me|explain|describe)\b/.test(t)) return 'what';
  return 'other';
}

export function classifyIntent(raw: string): Intent {
  const text = cleanQuestion(raw);
  const topic = TOPICS.find(([, re]) => re.test(text))?.[0] ?? null;
  const product = PRODUCTS.find(([, re]) => re.test(text))?.[0] ?? null;
  const selfRef = SELF_REF.test(text);
  const questionShaped = raw.trim().endsWith('?') || QUESTION_START.test(text);
  return {
    text,
    topic,
    product,
    aspect: aspectOf(text),
    selfRef,
    needsReasoning: REASONING.test(text),
    current: CURRENT.test(text),
    // Question-shaped AND about Nova/Atlas: a named product, or a documented topic put to Atlas ("you").
    isKnowledgeQuestion: questionShaped && (product !== null || (topic !== null && selfRef)),
  };
}
