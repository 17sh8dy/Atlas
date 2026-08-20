/**
 * Content policy — the one place that decides whether Atlas may act on a
 * request, a destination, or a piece of returned content.
 *
 * ── Why this module exists at all ───────────────────────────────────────────
 * Atlas can search the web, open links, launch a browser, and open files. That
 * makes "don't go looking for pornography" a property of the *action layer*,
 * not of any one skill. Written as a check inside `web.search`, it would be
 * missing from `web.searchImages` the day someone adds it, and missing from
 * every capability added after that. So it lives here, and the layers that
 * turn intent into machine actions consult it.
 *
 * ── Where it is consulted (four seams, each a different question) ───────────
 *   1. `Engine.ask`          — "is this request one I should act on at all?"
 *                              Runs before grammar, before the AI planner, so
 *                              a refused request never becomes a plan and
 *                              nothing is ever typed into a browser first.
 *   2. `Executor.run`        — "does this plan's arguments carry it?"
 *                              Screens the whole plan before the first step is
 *                              announced or a confirm card is shown. Catches
 *                              plans that never went through `ask` at all: a
 *                              clicked result row, and later a saved routine.
 *   3. `SkillRegistry.invoke`— the backstop, and the only one that is a
 *                              guarantee. `invoke()` is documented as the
 *                              single door every skill runs through; screening
 *                              here means a future caller that forgets seams 1
 *                              and 2 is still covered by construction.
 *   4. Returned web results  — "did a legitimate search bring something back
 *                              that we should stop touching?" (`isExplicitDestination`)
 *
 * Seams 1–3 look redundant and are not: they screen three different things
 * (raw text, planned arguments, an actual call) and have three different
 * entry points. Removing any one of them leaves a real hole.
 *
 * ── What this deliberately does NOT do ──────────────────────────────────────
 * It is not a maturity filter. Anatomy, sexual health, consent, relationships,
 * medicine, art history and the academic study of pornography are ordinary
 * subjects, and an assistant that flinches at the word "sex" is useless to
 * someone looking up a symptom. The educational signals below exist precisely
 * so those requests pass.
 *
 * It also does not filter the user's *own disk*. `files.find` still returns
 * whatever is on it. The rule is that Atlas must not go seeking explicit
 * material, not that Atlas hides a person's files from them.
 *
 * ── Refusals bypass personalization on purpose ──────────────────────────────
 * Every other line Atlas says comes from `phrasing.ts`, which is shaped by a
 * user-supplied `VoiceProfile`. These do not. A refusal that a settings screen
 * could soften, rewrite, or re-tone is not a policy. They are constants here.
 */

import type { SkillArgs } from '@atlas/core';

/** Why a request was refused. `minors` is a critical safety violation. */
export type BlockReason = 'explicit' | 'minors';

/**
 * A union rather than `{ allowed: boolean; reason?: BlockReason }` so that
 * narrowing on `allowed` gives call sites the reason without a non-null
 * assertion — under `strict`, the optional-field shape forces every consumer
 * to either assert or re-check, and asserting is how a refusal eventually
 * reaches a `say()` as the string "undefined".
 */
export type PolicyVerdict = { allowed: true } | { allowed: false; reason: BlockReason };

const ALLOWED: PolicyVerdict = { allowed: true };

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Fold the cheap evasions before matching: case, digit-for-letter
 * substitutions, and punctuation used as a separator.
 *
 * This is deliberately shallow. A determined person can defeat any string
 * matcher, and chasing that is a losing game that costs false positives on
 * ordinary text. The job here is to stop Atlas from *knowingly* fetching
 * explicit material, not to win an obfuscation arms race.
 */
function normalise(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[0@]/g, 'o')
    .replace(/[1!|]/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/[5$]/g, 's')
    .replace(/7/g, 't')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** True when any of `terms` appears as a whole word (or phrase) in `text`. */
function hasAny(text: string, terms: readonly string[]): boolean {
  const padded = ` ${text} `;
  return terms.some((t) => padded.includes(` ${t} `));
}

// ---------------------------------------------------------------------------
// The vocabularies
// ---------------------------------------------------------------------------

/**
 * Destinations and media that have no non-explicit reading. A request naming
 * one of these is asking for pornography whatever else the sentence says, so
 * educational context does not rescue them — "for a paper" does not change
 * what opening a tube site does.
 */
const EXPLICIT_DESTINATIONS: readonly string[] = [
  'pornhub',
  'xvideos',
  'xhamster',
  'xnxx',
  'redtube',
  'youporn',
  'spankbang',
  'brazzers',
  'onlyfans',
  'chaturbate',
  'stripchat',
  'rule34',
  'e621',
  'hentai',
  'doujinshi',
  'camgirl',
  'cam girl',
  'camsite',
  'porn site',
  'porn sites',
  'porn video',
  'porn videos',
  'porno',
  'sex video',
  'sex videos',
  'sex tape',
  'sextape',
  'xxx video',
  'xxx videos',
  'adult video',
  'adult videos',
  'adult movie',
  'adult movies',
  'blowjob',
  'creampie',
  'gangbang',
  'hardcore sex',
  'anal sex',
];

/**
 * The subject itself. Blocked when someone is trying to *get* it, allowed when
 * someone is reading or asking about it — "pornography addiction statistics"
 * is a research question and must stay one.
 */
const EXPLICIT_TOPICS: readonly string[] = [
  'porn',
  'pornography',
  'pornographic',
  'nsfw',
  'xxx',
  'erotica',
  'smut',
];

/**
 * Ambiguous on their own. These only matter next to an acquisition verb and
 * away from an educational signal — which is the intent test, and the reason
 * this policy is not a domain blacklist: "show me naked women" names no site
 * and no banned word, and is still plainly a request for pornography.
 */
const SEXUAL_TOKENS: readonly string[] = [
  'nude',
  'nudes',
  'nudity',
  'naked',
  'topless',
  'undressed',
  'stripping',
  'strip tease',
  'striptease',
  'erotic',
  'sexy',
  'sexual',
  'sex',
  'masturbation',
  'masturbating',
  'orgasm',
  'genitals',
  'boobs',
  'tits',
  'cleavage',
];

/** Wanting it fetched, opened, or played — as opposed to discussed. */
const ACQUISITION_VERBS: readonly string[] = [
  'search',
  'search for',
  'find',
  'find me',
  'look up',
  'look for',
  'get',
  'get me',
  'show',
  'show me',
  'open',
  'go to',
  'navigate',
  'navigate to',
  'browse',
  'visit',
  'download',
  'save',
  'watch',
  'stream',
  'play',
  'put on',
  'pull up',
  'bring up',
];

/**
 * Signals that the subject is being studied, treated, or discussed rather than
 * consumed. Requirement 5 lives here: this list is what keeps a symptom
 * search, a biology question, or a piece of art history out of the filter.
 */
const EDUCATIONAL_TOKENS: readonly string[] = [
  'health',
  'healthy',
  'healthcare',
  'medical',
  'medicine',
  'medically',
  'clinical',
  'clinic',
  'doctor',
  'nurse',
  'symptom',
  'symptoms',
  'diagnosis',
  'treatment',
  'disease',
  'infection',
  'sti',
  'stis',
  'std',
  'stds',
  'hiv',
  'contraception',
  'contraceptive',
  'condom',
  'condoms',
  'pregnancy',
  'pregnant',
  'fertility',
  'puberty',
  'menopause',
  'anatomy',
  'anatomical',
  'biology',
  'biological',
  'physiology',
  'science',
  'scientific',
  'research',
  'study',
  'studies',
  'statistics',
  'data',
  'paper',
  'journal',
  'textbook',
  'encyclopedia',
  'wikipedia',
  'definition',
  'define',
  'meaning',
  'etymology',
  'history',
  'historical',
  'art history',
  'renaissance',
  'sculpture',
  'painting',
  'museum',
  'law',
  'legal',
  'legislation',
  'policy',
  'regulation',
  'addiction',
  'therapy',
  'therapist',
  'counselling',
  'counseling',
  'consent',
  'relationship',
  'relationships',
  'marriage',
  'education',
  'educational',
  'safeguarding',
  'abuse',
  'harassment',
  'trafficking',
  'report',
  'reporting',
];

/**
 * Age signals. Next to anything sexual these produce the critical verdict, and
 * unlike everything else in this file, no context rescues that combination —
 * not "research", not "reporting", not "for a paper". Atlas declines and does
 * not negotiate about it.
 *
 * Terms of endearment ("baby") and interjections ("yo") are deliberately absent
 * despite being age words in other contexts. They would misfire on ordinary
 * adult phrasing, and this is the one verdict where a false positive accuses
 * the user of something serious — the request still gets refused by the rules
 * below, just without that accusation attached.
 */
const MINOR_TOKENS: readonly string[] = [
  'child',
  'children',
  'kid',
  'kids',
  'minor',
  'minors',
  'underage',
  'under age',
  'infant',
  'toddler',
  'preteen',
  'pre teen',
  'teen',
  'teens',
  'teenage',
  'teenager',
  'teenagers',
  'schoolgirl',
  'schoolboy',
  'school girl',
  'school boy',
  'loli',
  'lolita',
  'shota',
  'jailbait',
];

/**
 * Terms whose only use is to seek sexual material involving minors.
 *
 * The multi-word entries are here because the combination rule below misses
 * them: "abuse" is an educational signal (safeguarding, reporting, news), so
 * "child abuse images" would otherwise read as a legitimate research request.
 * Naming the *material* is what makes these unambiguous — "child abuse" on its
 * own stays allowed, because reading about it is ordinary and necessary.
 */
const CRITICAL_TERMS: readonly string[] = [
  'cp',
  'csam',
  'csem',
  'child porn',
  'child pornography',
  'child sexual abuse',
  'child abuse material',
  'child abuse imagery',
  'child abuse images',
  'child abuse photos',
  'child abuse videos',
  'pedo',
];

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

interface ClassifyOptions {
  /**
   * The text is about to become a machine action — a search query, a URL to
   * open. The request is then a request to *fetch*, so the acquisition verb is
   * implied rather than required. Left false for something the user merely
   * said, where an explicit verb has to be present, so talking about a subject
   * is never mistaken for wanting it fetched.
   */
  seeking?: boolean;
  /**
   * The caller already knows the context is a reference one — an encyclopedia
   * lookup, a medical source. Counts as an educational signal even when the
   * text itself carries none, which is what lets "look up pornography on
   * Wikipedia" work while "search images for pornography" does not.
   */
  educational?: boolean;
}

/** Classify a piece of text. */
function classify(text: string, opts: ClassifyOptions = {}): PolicyVerdict {
  const seeking = opts.seeking ?? false;
  const t = normalise(text);
  if (!t) return ALLOWED;

  // 1. Minors. Checked first and answered first: the combination outranks
  //    every allowance below it, including the educational one.
  if (hasAny(t, CRITICAL_TERMS)) return { allowed: false, reason: 'minors' };
  const sexualPresent =
    hasAny(t, EXPLICIT_DESTINATIONS) || hasAny(t, EXPLICIT_TOPICS) || hasAny(t, SEXUAL_TOKENS);
  if (sexualPresent && hasAny(t, MINOR_TOKENS)) return { allowed: false, reason: 'minors' };

  // 2. Destinations and media with no innocent reading.
  if (hasAny(t, EXPLICIT_DESTINATIONS)) return { allowed: false, reason: 'explicit' };

  const educational = (opts.educational ?? false) || hasAny(t, EDUCATIONAL_TOKENS);

  // 3. The subject itself — blocked when it is being sought, not when it is
  //    being studied.
  if (hasAny(t, EXPLICIT_TOPICS)) {
    if (educational) return ALLOWED;
    if (seeking || hasAny(t, ACQUISITION_VERBS)) return { allowed: false, reason: 'explicit' };
    return ALLOWED;
  }

  // 4. Intent: ambiguous words plus a want-it-fetched verb.
  if (!educational && hasAny(t, SEXUAL_TOKENS) && (seeking || hasAny(t, ACQUISITION_VERBS))) {
    return { allowed: false, reason: 'explicit' };
  }

  return ALLOWED;
}

// ---------------------------------------------------------------------------
// Seam 1 — the raw request
// ---------------------------------------------------------------------------

/**
 * Screen what the user typed, before any planning happens.
 *
 * `actionable` is the caller's judgement (the grammar matched, or
 * `looksActionable` said yes) about whether this is an instruction. Only
 * instructions are screened for explicit material, because a *question* about
 * a sexual subject is conversation, and conversation is not a computer action.
 * The minors rule ignores that distinction entirely — it applies to any
 * phrasing, question or command.
 */
export function screenRequest(text: string, actionable: boolean): PolicyVerdict {
  const verdict = classify(text);
  if (verdict.allowed) return ALLOWED;
  if (verdict.reason === 'minors') return verdict;
  return actionable ? verdict : ALLOWED;
}

// ---------------------------------------------------------------------------
// Seams 2 and 3 — planned and invoked actions
// ---------------------------------------------------------------------------

/**
 * Which skills carry a request out to the world.
 *
 * Screening every argument of every skill would be wrong, not merely noisy: it
 * would refuse to write a note, transform clipboard text, or count words in a
 * passage because of what that text is about. Those are the user's own words
 * being handled, not a destination being fetched. So the screen applies to the
 * domains that reach outward — plus, so a future one is covered on the day it
 * is written rather than the day someone remembers this file, anything
 * declaring the `network` capability.
 */
const OUTWARD_DOMAINS: ReadonlySet<string> = new Set(['web', 'research', 'files', 'apps', 'media']);

export interface ScreenableSkill {
  id: string;
  domain: string;
  needs?: readonly string[];
}

function reachesOutward(skill: ScreenableSkill): boolean {
  return OUTWARD_DOMAINS.has(skill.domain) || (skill.needs?.includes('network') ?? false);
}

/**
 * Argument names that carry a destination or a query, as opposed to content.
 *
 * The distinction matters: `files.append`'s `path` says where Atlas is going,
 * while its `content` is just text the user wrote. Screening the first is the
 * policy; screening the second would be censoring someone's own writing.
 */
const DESTINATION_ARGS: ReadonlySet<string> = new Set([
  'query',
  'q',
  'search',
  'term',
  'terms',
  'subject',
  'topic',
  'url',
  'link',
  'address',
  'site',
  'host',
  'domain',
  'path',
  'file',
  'folder',
  'destination',
  'name',
  'app',
  'title',
]);

/**
 * Skills whose destination is a reference work, where the subject can be
 * looked up without explicit material being what comes back. An encyclopedia
 * article about pornography is an encyclopedia article.
 */
const REFERENCE_SKILLS: ReadonlySet<string> = new Set(['web.searchWikipedia']);

/** Screen one about-to-run call. Non-outward skills pass untouched. */
export function screenSkillCall(skill: ScreenableSkill, args: SkillArgs): PolicyVerdict {
  if (!reachesOutward(skill)) return ALLOWED;

  const opts: ClassifyOptions = {
    // `seeking` is true here by definition: these strings are about to be
    // typed into a search box or handed to the OS as a place to go.
    seeking: true,
    educational: REFERENCE_SKILLS.has(skill.id),
  };

  for (const [key, value] of Object.entries(args ?? {})) {
    if (typeof value !== 'string') continue;
    if (!DESTINATION_ARGS.has(key.toLowerCase())) continue;
    const verdict = classify(value, opts);
    if (!verdict.allowed) return verdict;
  }
  return ALLOWED;
}

/**
 * Screen a whole plan before its first step is announced.
 *
 * A plan is refused as a unit rather than step by step, matching how the
 * executor already treats a declined step: the remainder does not run. Half a
 * refused plan is worse than none of it.
 */
export function screenPlan(
  steps: ReadonlyArray<{ skill: string; args: SkillArgs }>,
  lookup: (id: string) => ScreenableSkill | null,
): PolicyVerdict {
  for (const step of steps) {
    const skill = lookup(step.skill);
    if (!skill) continue; // unknown skills fail later, on their own terms
    const verdict = screenSkillCall(skill, step.args);
    if (!verdict.allowed) return verdict;
  }
  return ALLOWED;
}

// ---------------------------------------------------------------------------
// Seam 4 — what came back
// ---------------------------------------------------------------------------

/**
 * Hosts that serve pornography and nothing else.
 *
 * A supporting signal, never the mechanism — explicit material lives on
 * general-purpose hosts too, which is exactly why `classify` reads the title
 * and snippet as well. Judging destinations by hostname alone would be the
 * blacklist this policy is written not to be.
 */
const EXPLICIT_HOSTS: readonly string[] = [
  'pornhub.com',
  'xvideos.com',
  'xhamster.com',
  'xnxx.com',
  'redtube.com',
  'youporn.com',
  'spankbang.com',
  'brazzers.com',
  'onlyfans.com',
  'chaturbate.com',
  'stripchat.com',
  'rule34.xxx',
  'e621.net',
];

/** Sources where a sexual subject is being documented rather than served. */
const REFERENCE_HOSTS: readonly string[] = [
  'wikipedia.org',
  'wikimedia.org',
  'britannica.com',
  'who.int',
  'nih.gov',
  'ncbi.nlm.nih.gov',
  'cdc.gov',
  'nhs.uk',
  'mayoclinic.org',
  'plannedparenthood.org',
];

function hostOf(url: string): string {
  const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(String(url ?? '').trim());
  return (m?.[1] ?? '').toLowerCase().replace(/^www\./, '');
}

/**
 * Requirement 6, accidental exposure: a legitimate search can return something
 * explicit. Anything this flags is dropped before it is rendered as a row the
 * user can click, and before it is handed to a model as reference material —
 * so Atlas stops touching it rather than carrying on through it.
 */
export function isExplicitDestination(item: {
  url?: string;
  title?: string;
  snippet?: string;
}): boolean {
  const host = hostOf(item.url ?? '');
  if (host && matchesHost(host, EXPLICIT_HOSTS)) return true;

  const text = [item.url ?? '', item.title ?? '', item.snippet ?? ''].join(' ');
  // A reference source discussing the subject is not the subject. Without
  // this, a legitimate search that surfaces the encyclopedia article loses the
  // one result that actually answered the question.
  const educational = host ? matchesHost(host, REFERENCE_HOSTS) : false;
  return !classify(text, { seeking: true, educational }).allowed;
}

function matchesHost(host: string, list: readonly string[]): boolean {
  return list.some((h) => host === h || host.endsWith(`.${h}`));
}

/** Drop the flagged entries from a set of search results. */
export function filterDestinations<T extends { url?: string; title?: string; snippet?: string }>(
  items: readonly T[],
): T[] {
  return items.filter((i) => !isExplicitDestination(i));
}

// ---------------------------------------------------------------------------
// What Atlas says
// ---------------------------------------------------------------------------

/**
 * Refusals, stated once and offering nothing.
 *
 * Requirement 8 is a property of this text: no alternative phrasing, no other
 * site, no browser setting, no "if you meant X". A refusal that ends with a
 * hint is a lookup with extra steps.
 */
export function refusalFor(reason: BlockReason): string {
  if (reason === 'minors') {
    return (
      "No — I won't search for, open, or help with anything sexual involving " +
      'children, in any form or for any stated reason.'
    );
  }
  return "I don't search for, open, or play pornography, so I've stopped there.";
}
