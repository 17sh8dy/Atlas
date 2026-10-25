/**
 * Writing an answer from web evidence with no model: choose the sentences that answer the question, and
 * show where they came from.
 *
 * ── What this is, and what it is not ──────────────────────────────────────────────────────────────────
 * It is EXTRACTIVE. Every word of the answer is a sentence one of the sources wrote, picked by a score
 * that is computed here and can be read below. Nothing is paraphrased, so nothing can be made up: the
 * worst this can do is pick the wrong sentence, and the source line under it lets the person see that.
 * It does not reason, compare or summarise across sources — a question that needs that (`needsReasoning`)
 * is answered with the closest sentences and labelled as such, instead of pretending to be an analysis.
 *
 * ── The score ─────────────────────────────────────────────────────────────────────────────────────────
 *   subject coverage   the sentence must be ABOUT the subject (the words that name it), not merely share
 *                      a word with the question; below half, it is not a candidate at all
 *   definition shape   "X is a …" / "X refers to …" for a what-is question; a number for a how-many one
 *   position           the first sentences of an excerpt are the lead, and the lead is the definition
 *   trust              an encyclopedia or an official page over a forum post
 *   agreement          another, independent source says nearly the same thing
 * and a sentence that is chrome ("Sign in", "Read more", a cookie notice) never scores.
 */

import type { EvidencePacket, WebEvidence } from '../web/evidence';
import { registrableDomain } from '../web/evidence';
import type { QuestionShape } from './shape';

const STOP = new Set(
  (
    'a an the of in on at to for from by with about as into over under is are was were be been being am do does did done can could would should will shall may might must ' +
    'what whats which who whom whose when where why how this that these those it its and or but not no yes than then so such there here have has had having i you he she we they me my your our their ' +
    'tell know called named mean means meaning define explain describe thing things'
  ).split(' '),
);

function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9'’-]*/g) ?? [])
    .map((w) => w.replace(/['’]s$/, ''))
    .filter((w) => w.length > 1);
}

function content(text: string): string[] {
  return words(text).filter((w) => !STOP.has(w));
}

/** Light stemming so "reels"/"reel", "working"/"works" meet. */
const ROMAN: Record<string, string> = { ii: '2', iii: '3', iv: '4', vi: '6', vii: '7', viii: '8' };

function stem(w: string): string {
  if (ROMAN[w]) return ROMAN[w]!;
  return w.replace(/(?:ing|ed|es|s)$/, '').replace(/(.)\1$/, '$1') || w;
}

export function stems(text: string): Set<string> {
  return new Set(content(text).map(stem));
}

const CHROME =
  /\b(?:cookies?|sign[- ]?in|log[- ]?in|subscribe|newsletter|advertisement|sponsored|privacy policy|terms of (?:use|service)|all rights reserved|read more|click here|share this|follow us|skip to|javascript|enable js|loading|copyright|©|sign up|download the app|related (?:articles|posts)|you may also like|accept all|add us on google|preferred source|quick facts|image\s+\d+|ai overviews|discover feed|trust our content|share on (?:facebook|twitter|x)|follow (?:us|me) on)\b|\[(?:…|\.\.\.)\]/i;

/** "As we mentioned, Lima is the capital…" reads as an answer once the opener that points back at the page is gone. */
function dropDiscourseMarker(sentence: string): string {
  const stripped = sentence.replace(
    /^(?:as (?:we|i) (?:mentioned|said|noted|discussed)(?: (?:above|earlier|before))?|as mentioned(?: (?:above|earlier|before))?|also|moreover|however|additionally|furthermore|in addition|and|but|so|thus|therefore|meanwhile|overall)\b[,;:]?\s+/i,
    '',
  );
  return stripped === sentence || stripped.length < 25
    ? sentence
    : stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

/** Split text into sentences without breaking on "U.S.", "e.g.", "St." or decimals. */
export function sentencesOf(text: string, allowCut = false): string[] {
  // Paragraph breaks and wiki-style headings ("== History ==") end a sentence; they are never part of one.
  const paragraphs = text
    .replace(/\[\s*(?:\d+|citation needed|note \d+|[a-z])\s*\]/gi, '')
    .replace(/\s*\((?=[^)]*(?:[^\u0020-\u024F]|;|pronounced|\/[^/\s][^/]*\/))[^)]*\)/g, '')
    .replace(/\s*={2,}[^=\n]{1,80}?={2,}\s*/g, '\n')
    .split(/\n+/)
    .map((para) => para.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const protectedText = paragraphs
    .map((para) =>
      para.replace(
        /\b(?:e\.g|i\.e|etc|vs|Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|Inc|Ltd|Co|U\.S|U\.K|No|approx|c|ca)\./g,
        (m) => m.replace(/\./g, '\uE000'),
      ),
    )
    .join('\n');
  return protectedText
    .split(/(?<=[.!?])["”’)]?\s+(?=["“‘(]?[A-Z0-9])|\n/)
    .map((s) => s.replace(/\uE000/g, '.').trim())
    .map(dropDiscourseMarker)
    .filter(
      (s) =>
        s.length >= 25 &&
        s.length <= 700 &&
        // A whole sentence: it starts like one and ends like one. A fragment (a cut-off snippet, text that
        // began mid-sentence) is never quoted as if it were an answer.
        /^["“‘(]?[A-Z0-9]/.test(s) &&
        (/[.!?]["”’)]?$/.test(s) || (allowCut && /(?:…|\.\.\.)$/.test(s))) &&
        !CHROME.test(s) &&
        /[a-z]{3}/.test(s) &&
        !/^[A-Z\s\d:|·•-]{20,}$/.test(s),
    );
}

const TRUSTED_HOST =
  /(?:^|\.)(?:wikipedia\.org|britannica\.com|nasa\.gov|nih\.gov|cdc\.gov|who\.int|noaa\.gov|loc\.gov|si\.edu|merriam-webster\.com|dictionary\.cambridge\.org|oxfordlearnersdictionaries\.com|khanacademy\.org|nationalgeographic\.com|mayoclinic\.org|fda\.gov|usgs\.gov|ed\.gov|data\.gov|europa\.eu|un\.org|worldbank\.org|cia\.gov|developer\.mozilla\.org|learn\.microsoft\.com|support\.microsoft\.com|support\.google\.com|support\.apple\.com|help\.instagram\.com|about\.instagram\.com)$|\.(?:gov|edu)$/i;
const WEAK_HOST =
  /(?:^|\.)(?:quora\.com|reddit\.com|answers\.com|yahoo\.com|ask\.com|pinterest\.com|facebook\.com|tiktok\.com|x\.com|twitter\.com|medium\.com|blogspot\.com|wordpress\.com|fandom\.com)$/i;

function trustOf(e: WebEvidence): number {
  if (e.provider === 'wikipedia' || TRUSTED_HOST.test(e.host)) return 0.7;
  if (WEAK_HOST.test(e.host)) return -0.4;
  return 0;
}

/**
 * Does the page's own title say it is about the subject? "Reels (Meta)" is the page about Reels; "List of
 * most-viewed Instagram reels" merely mentions them, and a definition should not be taken from it.
 */
export function titleFit(
  title: string,
  subject: Set<string>,
  question: Set<string> = subject,
): number {
  if (!subject.size) return 0;
  const head = title.replace(/\s*[-–—|:].*$/, '').replace(/\s*\([^)]*\)/g, '');
  let fit = 0;
  const have = stems(head);
  if (have.size && [...subject].every((w) => have.has(w))) {
    fit += 1.2;
    if (have.size === subject.size) fit += 1.3;
  } else if (have.size && [...have].every((w) => question.has(w))) {
    // The page is about part of what was asked ("Tomato" for "is a tomato a fruit").
    fit += 0.8;
  }
  // Words in the title that the question never used mean the page is about something more specific.
  const extra = [...have].filter((w) => !question.has(w)).length;
  fit -= Math.min(2, extra * 0.5);
  // A page with a qualifier in its title ("Sinking of the Titanic (Bryars)") is a narrower subject than the plain one.
  const qualifier = /\(([^)]*)\)/.exec(title);
  if (qualifier && ![...stems(qualifier[1]!)].some((w) => question.has(w))) fit -= 0.8;
  if (/^(?:list|lists|timeline|index|outline|comparison)\s+of\b/i.test(title)) fit -= 2;
  if (/^(?:talk|user|category|template|wikipedia|file|portal|draft):/i.test(title)) fit -= 3;
  return fit;
}

interface Candidate {
  text: string;
  evidence: WebEvidence;
  /** Position within its excerpt. */
  index: number;
  coverage: number;
  score: number;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const x of a) if (b.has(x)) both += 1;
  return both / (a.size + b.size - both);
}

const CAUSAL =
  /\b(?:because|due to|caused? by|causes?|result of|results? in|reason|since|so that|thus|therefore|as a result|scatter(?:s|ed|ing)?|due|owing to|leads? to|explained by)\b/i;

/** A sentence whose subject is a named person: "Emmanuel Macron (born …) is a French politician who has served …". */
const PERSON_SENTENCE =
  /^[A-Z][\p{L}'’.-]+(?:\s+(?:de|van|von|da|di|al|bin|el)\s+|\s+)[A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+){0,2}\s*(?:\([^)]*\)\s*)?(?:,\s[^,]{0,60},\s)?(?:is|was|has served|serves|became|has been)\b/u;

const DEFINES =
  /\b(?:is|are|was|were|refers? to|means?|describes?|denotes?|stands? for|known as|called|defined as|is a|is an|are a|consists? of|lets?|allows?|enables?)\b/i;

export interface ComposedAnswer {
  /** The sentences, already joined. */
  text: string;
  /** How sure the extract is that it answers the question. */
  confidence: 'high' | 'medium' | 'low';
  /** The sources the sentences came from (ids into the packet). */
  from: number[];
  /** Hosts of other independent sources that said much the same thing. */
  agreeing: string[];
  /** The winning sentence's score, to compare answers found by different searches. */
  score: number;
}

/**
 * Pick the answer out of the evidence. Null when nothing in it is about the subject — the caller then says
 * so plainly rather than quoting something beside the point.
 */
export function composeAnswer(packet: EvidencePacket, shape: QuestionShape): ComposedAnswer | null {
  const subjectStems = stems(`${shape.subject} ${shape.context ?? ''}`);
  const subjectOnly = stems(shape.subject);
  const contextStems = stems(shape.context ?? '');
  const entityStems = stems(shape.entity ?? '');
  const questionStems = stems(packet.question);
  const wanted = subjectStems.size ? subjectStems : questionStems;
  if (!wanted.size) return null;

  const candidates: Candidate[] = [];
  for (const e of packet.evidence) {
    // On the page about the thing itself, "Its height was measured..." is about the thing: a sentence there
    // does not have to repeat its name.
    const aboutThis =
      titleFit(e.title, entityStems.size ? entityStems : subjectOnly, questionStems) >= 2;
    const pageStems = contextStems.size
      ? stems(`${e.title} ${e.host} ${e.url} ${e.excerpt}`)
      : null;
    // A search snippet is often cut with an ellipsis; a page we read is not, so only the snippet may end that way.
    const sentences = sentencesOf(e.excerpt, !e.readPage);
    sentences.forEach((text, index) => {
      const have = stems(text);
      if (aboutThis) for (const w of entityStems.size ? entityStems : subjectOnly) have.add(w);
      let hit = 0;
      for (const w of wanted) if (have.has(w)) hit += 1;
      const coverage = hit / wanted.size;
      // The thing itself must be named: a sentence that shares only the context ("Instagram") is not about it.
      const names = subjectOnly.size ? [...subjectOnly].some((w) => have.has(w)) : true;
      // ...and it must be the thing in THAT context: a "Reel from Instagram" is not a fishing reel. The context
      // may be in the sentence or anywhere on the page it came from (an article about Reels opens with the
      // definition and only mentions Instagram a sentence later).
      const inContext =
        !contextStems.size || [...contextStems].some((w) => have.has(w) || pageStems!.has(w));
      if (coverage < 0.5 || !names || !inContext) return;

      let score = coverage * 3;
      const lead = text.slice(0, 160);
      if (
        (shape.kind === 'definition' || shape.kind === 'explain' || shape.kind === 'other') &&
        DEFINES.test(lead)
      )
        score += 1.5;
      if (shape.kind === 'quantity' && /\d/.test(text)) score += 1.5;
      if (
        shape.kind === 'quantity' &&
        /\d[\d,.]*\s?(?:m|km|cm|mm|ft|feet|mi|miles?|kg|g|lbs?|tons?|mph|km\/h|°[CF]|%|percent|million|billion|trillion|years?|metres|meters|kilometres|kilometers)\b/i.test(
          text,
        )
      )
        score += 1.5;
      // "Who is the president of France" is answered by a sentence about a PERSON ("Emmanuel Macron (born …) is …"),
      // not by the one that describes the office.
      if (shape.personRole && PERSON_SENTENCE.test(text)) score += 3;
      // A "why" is answered by a reason, not by a description of the thing.
      if (shape.kind === 'explain' && shape.needsReasoning) score += CAUSAL.test(text) ? 1.5 : -1.5;
      if (
        shape.kind === 'when' &&
        /\b(?:1\d{3}|20\d\d|january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(
          text,
        )
      )
        score += 1.5;
      if (
        shape.kind === 'howto' &&
        /\b(?:go to|open|select|click|tap|press|type|run|choose|settings|step)\b/i.test(text)
      )
        score += 1;
      // A sentence that begins with the subject is usually the definition.
      const firstWord = stem(content(text)[0] ?? '');
      if (subjectOnly.has(firstWord)) score += 0.5;
      score += 1.2 / (1 + index * 0.6);
      // (The page named after the office is the wrong page for "who holds it", so its title earns nothing then.)
      score +=
        trustOf(e) +
        (shape.personRole
          ? 0
          : 2 * titleFit(e.title, entityStems.size ? entityStems : subjectOnly, questionStems));
      if (e.readPage) score += 0.3;
      if (/\?\s*$/.test(text)) score -= 1.5;
      if (/^(?:i|we|my|our)\b/i.test(text)) score -= 1;
      if (/\b(?:click|tap here|you won't believe|top \d+|best \d+)\b/i.test(text)) score -= 1;
      candidates.push({ text, evidence: e, index, coverage, score });
    });
  }
  if (!candidates.length) return null;

  // Agreement: an independent source saying nearly the same thing is worth more than another sentence.
  for (const c of candidates) {
    const mine = stems(c.text);
    const sites = new Set<string>();
    for (const o of candidates) {
      if (registrableDomain(o.evidence.host) === registrableDomain(c.evidence.host)) continue;
      if (jaccard(mine, stems(o.text)) >= 0.3) sites.add(registrableDomain(o.evidence.host));
    }
    c.score += Math.min(sites.size, 2) * 0.5;
  }

  candidates.sort((a, b) => b.score - a.score || a.index - b.index);
  const top = candidates[0]!;

  // The answer: the best sentence, then the sentences that follow it in its own source (they continue the
  // thought), while they are still about the subject, not repeats, and the whole fits.
  const budget =
    shape.kind === 'definition' || shape.kind === 'explain'
      ? 520
      : shape.kind === 'howto'
        ? 640
        : 380;
  const chosen: Candidate[] = [top];
  const sameSource = candidates
    .filter((c) => c.evidence.id === top.evidence.id && c !== top)
    .sort((a, b) => a.index - b.index);
  let used = top.text.length;
  for (const c of sameSource) {
    if (chosen.length >= (shape.kind === 'howto' ? 4 : 3)) break;
    if (c.index < top.index) continue; // keep reading order; do not splice an earlier sentence after the lead
    if (c.index - chosen[chosen.length - 1]!.index > 2) break;
    if (used + c.text.length > budget) break;
    // A follow-on sentence must itself be a good answer, not just nearby; and a fact question gets its fact,
    // not the paragraph around it.
    if (c.score < top.score * 0.6) continue;
    if ((shape.kind === 'quantity' || shape.kind === 'when') && !/\d/.test(c.text)) continue;
    if (chosen.some((x) => jaccard(stems(x.text), stems(c.text)) > 0.6)) continue;
    chosen.push(c);
    used += c.text.length + 1;
  }
  chosen.sort((a, b) => a.index - b.index);

  const agreeSites = new Set<string>();
  const topStems = stems(top.text);
  for (const o of candidates) {
    if (o.evidence.id === top.evidence.id) continue;
    if (registrableDomain(o.evidence.host) === registrableDomain(top.evidence.host)) continue;
    if (jaccard(topStems, stems(o.text)) >= 0.3) agreeSites.add(o.evidence.host);
  }

  const confidence: ComposedAnswer['confidence'] =
    top.coverage >= 0.8 && top.score >= 4.4
      ? 'high'
      : top.coverage >= 0.5 && top.score >= 3.2
        ? 'medium'
        : 'low';

  return {
    text: chosen.map((c) => c.text).join(' '),
    confidence,
    from: [...new Set(chosen.map((c) => c.evidence.id))],
    agreeing: [...agreeSites].slice(0, 3),
    score: top.score,
  };
}

/** The line under an answer: who said it, and how far to trust it. */
export function sourceLine(packet: EvidencePacket, answer: ComposedAnswer): string {
  const main = packet.evidence.find((e) => e.id === answer.from[0]);
  if (!main) return '';
  const name = main.provider === 'wikipedia' ? 'Wikipedia' : main.host.replace(/^www\./, '');
  const also = answer.agreeing.length
    ? `; the same on ${answer.agreeing.map((h) => h.replace(/^www\./, '')).join(', ')}`
    : '';
  const alone =
    answer.agreeing.length === 0 && packet.verification.independentSources <= 1
      ? ' (one source, not cross-checked)'
      : '';
  return `Source: ${name} — ${main.url}${also}${alone}`;
}

/** Everything the person is shown for a composed answer. */
export function formatComposed(
  packet: EvidencePacket,
  shape: QuestionShape,
  answer: ComposedAnswer,
): string {
  const lead =
    answer.confidence === 'low'
      ? "I'm not sure this is the answer, but it is the closest thing I found:"
      : answer.confidence === 'medium' || shape.needsReasoning
        ? shape.needsReasoning
          ? shape.kind === 'explain' || shape.kind === 'yesno'
            ? "I can't work this out myself, but here is what the sources say:"
            : 'This one is a judgement call; here is what the sources say:'
          : "Here's what I found:"
        : '';
  const others = packet.evidence
    .filter((e) => !answer.from.includes(e.id))
    .slice(0, 2)
    .map((e) => `• ${e.title.replace(/\s+/g, ' ').trim()} — ${e.url}`);
  return [
    lead,
    answer.text,
    '',
    sourceLine(packet, answer),
    others.length ? `More:\n${others.join('\n')}` : '',
  ]
    .filter((x, i) => x || i === 2)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
