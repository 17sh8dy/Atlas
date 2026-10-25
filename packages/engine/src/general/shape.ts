/**
 * What kind of question is this, and what is it about? — for a question Atlas has to answer with no model.
 *
 * Deterministic and table-driven, like `web/router.ts`: it runs before anything is asked of anyone, costs
 * nothing, works offline and can be tested with a list. It never decides WHETHER to answer (the engine
 * does that, from what is connected); it reads the question once and returns the words worth searching for,
 * in the order worth trying them.
 *
 * ── Why it is not just "strip the question word" ──────────────────────────────────────────────────────
 * "What is a “Reel” from Instagram?" stripped naively is `a Reel from Instagram`: a poor query for an
 * encyclopedia (it requires every word to match) and a mediocre one for a web search. People put the
 * context AFTER the thing ("a Reel from Instagram", "a pawn in chess", "a buffer in Rust"); a search
 * wants it BEFORE ("Instagram Reel"). So the subject and its context are separated, and the queries are
 * generated from both: context-first, then the bare subject, then the question as it was typed.
 */

export type QuestionKind =
  /** what is / who is / what does X mean / define / tell me about */
  | 'definition'
  /** when / what year / what date */
  | 'when'
  /** where is / where do */
  | 'where'
  /** how many / how much / how tall / how old / what is the population of */
  | 'quantity'
  /** how does X work / why */
  | 'explain'
  /** how do I … */
  | 'howto'
  /** X vs Y / difference between / which is better */
  | 'compare'
  /** is / are / does / can … — a yes/no question */
  | 'yesno'
  | 'other';

export interface QuestionShape {
  kind: QuestionKind;
  /** The thing asked about, as a person would name it: "Reel", "capital of Peru". */
  subject: string;
  /** Where/what it belongs to, when the question gave one: "Instagram". */
  context?: string;
  /** For "the capital of Peru": the thing whose page holds the answer ("Peru"). */
  entity?: string;
  /** "who is the president of France": the answer is a person, not a description of the office. */
  personRole?: boolean;
  /** Queries to try, best first. Never empty. */
  queries: string[];
  /** Judgement is wanted (why, should, compare, better): an extract is a weak answer and says so. */
  needsReasoning: boolean;
}

/** Words that make a question about THIS person or THIS machine: the web cannot answer those. */
const PERSONAL =
  /\b(?:my|mine|me|myself|i|i'm|i've|i'd|we|our|ours)\b|\b(?:this|that)\s+(?:pc|computer|laptop|machine|folder|file|app|window|screen|project)\b|\b(?:on|in)\s+(?:my|this)\b/i;

/** "how do I …": personal in grammar, general in content. */
const HOWTO =
  /^\s*(?:how\s+(?:do|can|could|should|would|to)\b|how\s+do\s+(?:you|i|we)\b|what(?:'s| is) the (?:best|easiest|fastest|right|proper) way to\b)/i;

/** A path or a file name: that is a question about the machine. */
const LOOKS_LOCAL =
  /(?:^|[\s"'(])[a-z]:[\\/]|\\\\|(?:^|\s)~[\\/]|\.(?:exe|dll|txt|docx?|xlsx?|pdf|png|jpe?g|mp[34]|mkv|zip|json|ts|js|py|rs)\b(?!\w)/i;

const POLITE =
  /^\s*(?:(?:hey|hi|ok(?:ay)?|so|um|uh|please|atlas|nova)[\s,]+)*(?:(?:can|could|would|will)\s+you\s+)?(?:(?:please|just)\s+)?(?:(?:tell|let)\s+me(?:\s+know)?\s+(?!about\b)|i\s+(?:want|need|would like)\s+to\s+(?:know|understand)\s+|i'?m\s+(?:curious|wondering)\s+|do\s+you\s+know\s+|i\s+was\s+wondering\s+|explain\s+to\s+me\s+)?/i;

const WH =
  /^(?:what|whats|what's|who|whos|who's|whom|when|where|wheres|where's|which|why|how|is|are|was|were|does|do|did|can|could|has|have|had|will|would|should)\b/i;

/** Strip the quoting/dressing that only confuses a search. */
function tidy(s: string): string {
  return s
    .replace(/[“”"‘’`]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.:;-]+|[\s,.:;?!-]+$/g, '')
    .trim();
}

const ARTICLE = /^(?:an?|the|some|any)\s+/i;

/** Words that do not help a search find the subject. */
const FILLER_TAIL =
  /\s+(?:exactly|actually|really|in simple terms|in plain english|briefly|for me|please|anyway|again)$/i;

/** The context markers in "a Reel from Instagram", "a pawn in chess". */
const CONTEXT_SPLIT =
  /^(.{2,40}?)\s+(?:from|on|in|within|inside|for|of)\s+(?!the\s+(?:world|universe|us|u\.s\.)\b)([A-Za-z0-9][\w .&'+-]{1,40})$/i;

function split(text: string): { subject: string; context?: string } {
  const t = text.replace(ARTICLE, '');
  const m = CONTEXT_SPLIT.exec(t);
  if (!m) return { subject: t };
  const head = m[1]!.trim();
  const ctx = m[2]!.trim();
  // "capital of Peru", "population of Canada", "meaning of life": the "of" is part of the subject.
  if (
    /\bof$/i.test(text.slice(head.length).trim().split(/\s+/)[0] ?? '') ||
    /^(?:capital|population|president|prime minister|currency|language|flag|area|height|capital city|meaning|history|origin|founder|inventor|creator|author|director|leader|size|age|length|weight|speed|mass|temperature|boiling point|melting point|capital|anthem|religion|economy)$/i.test(
      head,
    )
  ) {
    return { subject: t };
  }
  // Only a short thing in a named context reads as "X from Y" (a Reel from Instagram); a long clause is a sentence.
  if (head.split(/\s+/).length > 3) return { subject: t };
  return { subject: head, context: ctx };
}

/** "how tall is Mount Everest" → "Mount Everest height": a search wants the noun, not the adjective. */
const MEASURE: Record<string, string> = {
  tall: 'height',
  high: 'height',
  long: 'length',
  old: 'age',
  big: 'size',
  large: 'size',
  far: 'distance',
  fast: 'speed',
  deep: 'depth',
  wide: 'width',
  heavy: 'weight',
  hot: 'temperature',
  cold: 'temperature',
  small: 'size',
  short: 'length',
};
function quantityQuery(asked: string): { query: string; entity?: string } {
  const m =
    /^how\s+(tall|high|long|old|big|large|far|fast|deep|wide|heavy|hot|cold|small|short)\s+(?:is|are|was|were|does|do|did|can)\s+(?:an?\s+|the\s+)?(.+)$/i.exec(
      asked,
    );
  if (m)
    return {
      query: `${m[2]} ${MEASURE[m[1]!.toLowerCase()]}`,
      entity: m[2]!.replace(/[?.!]+$/, '').trim(),
    };
  return { query: asked.replace(/^how\s+/i, 'how ') };
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of list.map((x) => x.trim()).filter((x) => x.length >= 2)) {
    const k = q.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(q);
    }
  }
  return out;
}

/**
 * Read a question. Returns null for anything that is not a general-knowledge question: an instruction, a
 * question about this person or this machine, a path, a greeting. Null is the safe answer — the rest of
 * Atlas then behaves exactly as it did.
 */
export function readQuestion(raw: string): QuestionShape | null {
  const original = raw.trim();
  if (original.length < 6 || original.length > 300) return null;
  if (LOOKS_LOCAL.test(original)) return null;

  const polite = original.replace(POLITE, '').trim();
  const asked = polite || original;
  if (
    !WH.test(asked) &&
    !/\?\s*$/.test(original) &&
    !/^(?:define|explain|tell me about|meaning of|definition of|describe|give me (?:a |an )?(?:summary|definition|overview) of)\b/i.test(
      asked,
    )
  )
    return null;

  const lower = asked.toLowerCase();
  // "tell me about X" / "give me a summary of X" address Atlas, not the person's own things.
  const personal = PERSONAL.test(
    asked.replace(/^(?:tell|give|show|let)\s+me\b/i, '').replace(/^explain\s+to\s+me\b/i, ''),
  );
  const howto = HOWTO.test(asked);
  // "how do I reset a router" is general; "what is my IP" / "how much RAM do I have" is not.
  if (personal && !howto) return null;
  // "can you open Spotify?" is a request, not a question for the web.
  if (
    /^(?:can|could|would|will)\s+you\b/i.test(asked) &&
    !/\b(?:tell|explain|describe|define)\b/i.test(asked) &&
    !POLITE.test(original)
  )
    return null;

  let kind: QuestionKind = 'other';
  let rest = asked;
  let needsReasoning = false;
  let measured: string | undefined;
  let m: RegExpExecArray | null;

  if ((m = /^(?:define|definition of|meaning of)\s+(.+)$/i.exec(asked))) {
    kind = 'definition';
    rest = m[1]!;
  } else if (
    (m = /^(?:what|whats|what's)\s+(?:does|do)\s+(.+?)\s+(?:mean|stand for|refer to)$/i.exec(asked))
  ) {
    kind = 'definition';
    rest = m[1]!;
  } else if (
    (m =
      /^(?:explain|describe|tell me about|give me (?:a |an )?(?:summary|definition|overview) of)\s+(.+)$/i.exec(
        asked,
      ))
  ) {
    kind = 'definition';
    rest = m[1]!;
  } else if (
    (m =
      /^(?:what|whats|what's)(?:\s+(?:is|are|was|were))?\s+(?:the\s+)?(?:difference|differences)\s+between\s+(.+)$/i.exec(
        asked,
      )) ||
    (m = /^(?:difference|differences)\s+between\s+(.+)$/i.exec(asked))
  ) {
    kind = 'compare';
    rest = `difference between ${m[1]}`;
    needsReasoning = true;
  } else if ((m = /^(.+?)\s+(?:vs\.?|versus)\s+(.+)$/i.exec(asked))) {
    kind = 'compare';
    rest = `${m[1]} vs ${m[2]}`;
    needsReasoning = true;
  } else if (
    (m =
      /^(?:who|whos|who's|whom)(?:\s+(?:is|are|was|were|invented|discovered|created|wrote|founded|painted|directed|discovered))?\s+(.+)$/i.exec(
        asked,
      ))
  ) {
    kind = 'definition';
    rest = /^(?:invented|discovered|created|wrote|founded|painted|directed)/i.test(
      asked.replace(/^who\s+/i, ''),
    )
      ? asked.replace(/^who\s+/i, '')
      : m[1]!;
  } else if (
    (m =
      /^(?:what|whats|what's)\s+(?:year|date|day|month|time)\s+(?:was|is|did|does)\s+(.+)$/i.exec(
        asked,
      )) ||
    (m = /^when\s+(?:was|were|is|are|did|does|do|will|has|have)\s+(.+)$/i.exec(asked))
  ) {
    kind = 'when';
    rest = m[1]!;
  } else if ((m = /^where\s+(?:is|are|was|were|do|does|did|can)\s+(.+)$/i.exec(asked))) {
    kind = 'where';
    rest = m[1]!;
  } else if (
    (m =
      /^how\s+(?:many|much|tall|high|long|old|big|large|far|fast|deep|wide|heavy|hot|cold|small|short|wealthy|rich|common|often|expensive)\b\s*(.*)$/i.exec(
        asked,
      ))
  ) {
    kind = 'quantity';
    const q = quantityQuery(asked);
    rest = q.query;
    measured = q.entity;
  } else if (howto) {
    kind = 'howto';
    rest = asked
      .replace(/^how\s+(?:do|can|could|should|would)\s+(?:i|you|we)\s+/i, 'how to ')
      .replace(/^how\s+to\s+/i, 'how to ');
  } else if (
    (m = /^(?:how)\s+(?:does|do|did|is|are|can)\s+(.+?)\s+work(?:s)?$/i.exec(asked)) ||
    (m = /^how\s+(?:does|do|did)\s+(.+)$/i.exec(asked))
  ) {
    kind = 'explain';
    rest = m[1]!.replace(/\s+work(?:s)?$/i, '');
  } else if (
    (m = /^why\s+(?:is|are|was|were|do|does|did|can|can't|cant|isn't|don't|doesn't)\s+(.+)$/i.exec(
      asked,
    ))
  ) {
    kind = 'explain';
    rest = asked.replace(/^why\s+/i, '');
    needsReasoning = true;
  } else if (
    (m =
      /^(?:what|whats|what's)\s+(?:is|are|was|were)\s+(?:the\s+)?(?:best|better|worst|right|ideal|recommended)\b/i.exec(
        asked,
      ))
  ) {
    kind = 'other';
    needsReasoning = true;
    rest = asked.replace(/^what(?:'s| is| are)?\s+/i, '');
  } else if (
    (m =
      /^(?:what|whats|what's)\s+(?:is|are|was|were)\s+(?:the\s+)?(population|capital|currency|height|length|weight|age|area|speed|distance|temperature|boiling point|melting point|president|prime minister|language|official language|flag|anthem|religion|gdp|size|mass)\s+of\s+(.+)$/i.exec(
        asked,
      ))
  ) {
    kind = 'quantity';
    rest = `${m[1]} of ${m[2]}`;
  } else if ((m = /^(?:what|whats|what's|which)\s+(?:is|are|was|were)?\s*(.+)$/i.exec(asked))) {
    kind = 'definition';
    rest = m[1]!;
  } else if (
    (m = /^(?:is|are|was|were|does|do|did|can|could|has|have|had|will|would|should)\s+(.+)$/i.exec(
      asked,
    ))
  ) {
    kind = 'yesno';
    rest = m[1]!;
    if (/^(?:should|would)\b/i.test(asked)) needsReasoning = true;
  } else if (/^(?:why|how|where|when|who|which)\b/i.test(asked)) {
    kind = 'other';
  } else {
    return null;
  }

  // A yes/no question is "is a tomato a fruit": search the claim itself.
  rest = tidy(rest).replace(FILLER_TAIL, '');
  if (!rest || rest.length < 2) return null;
  // One word that is not a noun phrase ("what is it", "who is he"): there is nothing to search for.
  if (
    /^(?:it|that|this|he|she|they|there|here|what|who|something|anything|everything)$/i.test(rest)
  )
    return null;

  const { subject, context } =
    kind === 'definition' || kind === 'explain' || kind === 'other'
      ? split(rest)
      : { subject: rest, context: undefined };
  const subj = tidy(subject);
  const ctx = context ? tidy(context) : undefined;

  // A definition is best searched by its subject; anything with a verb in it (why/how/when/is X Y) reads best
  // as the question itself.
  const ownWords = kind === 'definition' || kind === 'quantity';
  // "the capital of Peru", "population of Canada": the answer lives on the page about the thing, not on pages that
  // merely contain the attribute word, so that thing is searched for by itself too.
  const attribute = /^(?:the\s+)?(?:[a-z][a-z ]{1,24}?)\s+of\s+(?:the\s+)?(.{2,60})$/i.exec(rest);
  const entity =
    measured ??
    (kind === 'quantity' && attribute && !/^how\b/i.test(rest) ? tidy(attribute[1]!) : undefined);
  // A search engine does better on the noun than on the sentence: "refrigerator", "tomato fruit".
  const bare = tidy(subj.replace(/\b(?:a|an|the)\b/gi, ' '));
  const queries = dedupe([
    ownWords ? (ctx ? `${ctx} ${subj}` : kind === 'quantity' ? rest : subj) : tidy(asked),
    entity ?? '',
    ownWords ? '' : bare,
    ownWords && ctx ? subj : '',
    ownWords ? tidy(asked) : rest,
    lower === rest.toLowerCase() ? '' : tidy(original),
  ]);

  const personRole =
    /^who(?:'s|\s+is|\s+was)\s+(?:the\s+)?(?:current\s+|new\s+|present\s+)?[a-z][a-z .'-]{1,30}?\s+of\s+\S/i.test(
      asked,
    );
  return {
    kind,
    personRole,
    subject: subj,
    context: ctx,
    entity,
    queries: queries.length ? queries : [tidy(original)],
    needsReasoning,
  };
}
