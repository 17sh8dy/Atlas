/**
 * Personalization safety — what a person may call themselves, call Atlas, and
 * be greeted with.
 *
 * ── What this is for, and what it is emphatically not for ───────────────────
 * Personalization is a real feature: nicknames, gamer tags, in-jokes, titles,
 * fictional names, other alphabets, emoji. Someone setting "Fucking Shady" or
 * "Captain Chaos" or "计算机" is using the feature exactly as intended, and a
 * filter that rejects them has broken the feature to no benefit.
 *
 * So this is not a profanity filter. Profanity is not in the block lists at
 * all — not allow-listed and then overridden, simply absent, which is why
 * "Fucking Shady" passes: nothing matches it. What is blocked is a much
 * narrower and much more serious set:
 *
 *   * sexual content involving minors — zero tolerance, and the one category
 *     that is checked against evasion-resistant text as well as plain text;
 *   * pornographic and graphically sexual content;
 *   * hateful slurs;
 *   * threats and violent-extremist content.
 *
 * The distinction the whole module turns on: **mature is not the same as
 * inappropriate**. Edgy, crude, rude and unusual are all allowed. The four
 * categories above are not.
 *
 * ── Why not `includes('badword')` ───────────────────────────────────────────
 * Two failure modes, and a substring check has both. It misses anything
 * spaced, dotted or leetspoken — `f.u.c.k`, `1oli` — and it fires on innocent
 * text that happens to contain a short string, which is the Scunthorpe problem
 * and the reason a filter gets a reputation for being stupid.
 *
 * What happens instead: the input is normalised into two surfaces, and each
 * pattern is matched against the one that suits it.
 *
 *   * `spaced` — Unicode-normalised, lowercased, de-accented, leet-folded, and
 *     with every run of non-alphanumerics turned into a single space. Matched
 *     with word boundaries, so `ass` does not fire inside `assassin` and
 *     `Scunthorpe` survives.
 *   * `collapsed` — the same, with *all* separators removed. This defeats
 *     `l o l i` and `p-e-d-o`, but it also joins innocent neighbours into
 *     accidental words, so only the zero-tolerance category is matched against
 *     it, and only with patterns long enough that a collision is implausible.
 *
 * ── The reason is internal ──────────────────────────────────────────────────
 * `reason` exists so the app can log and test what happened. It is not for the
 * UI: telling somebody which phrase tripped the filter is telling them what to
 * edit, which is a worse outcome than a vague message. The UI shows one line
 * for every rejection.
 */

/** Which field is being checked. `atlasName` is held to a slightly higher bar. */
export type PersonalizationField = 'userName' | 'atlasName' | 'greeting';

/** Why something was refused. Internal — never rendered verbatim. */
export type PersonalizationRejection =
  | 'too-long'
  | 'unreadable'
  | 'sexual-minors'
  | 'sexual-explicit'
  | 'hate'
  | 'violence';

export type PersonalizationResult =
  | { ok: true; value: string }
  | { ok: false; reason: PersonalizationRejection };

/**
 * Length caps, in code points rather than UTF-16 units so an emoji counts as
 * one character and not two.
 *
 * A name is a name: 40 is generous for "The Right Honourable Lord Shady" and
 * short enough that it cannot push a chat line off screen. A greeting is a
 * sentence or two, so it gets tweet-ish room to have a personality in.
 */
export const PERSONALIZATION_LIMITS: Record<PersonalizationField, number> = {
  userName: 40,
  atlasName: 40,
  greeting: 280,
};

/**
 * Characters that exist to deceive rather than to say anything.
 *
 * Bidi overrides can make text render in an order it is not written in, and
 * zero-width characters can split a word so no filter — this one included —
 * sees it. Neither has a legitimate use in a display name, so both are simply
 * removed before matching.
 */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** Leet and homoglyph folding. Applied after case folding, before matching. */
const LEET: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  '@': 'a',
  $: 's',
  '!': 'i',
  '|': 'l',
  '+': 't',
};

interface Surfaces {
  /**
   * Word-boundary matching, with leet folded.
   *
   * ⚠️ Leet folding destroys digits — `1`→`i`, `3`→`e` — so anything matching
   * on a *number* must use `plain` instead. That is not hypothetical: `13yo`
   * folds to `ieyo`, and the age rule silently stopped working until a test
   * caught it.
   */
  spaced: string;
  /** Word-boundary matching with digits intact. Same normalisation otherwise. */
  plain: string;
  /** Evasion-resistant. Every separator removed. */
  collapsed: string;
}

/** True when any of the given surfaces matches. */
function hits(pattern: RegExp, ...against: string[]): boolean {
  return against.some((text) => pattern.test(text));
}

/**
 * Reduce input to the two forms the patterns are written against.
 *
 * NFKC first, so fullwidth and other compatibility forms fold onto plain
 * ASCII; then NFD with combining marks stripped, so accents do not hide a
 * word. Both are matching-only: the value that gets *saved* is the untouched
 * original, because "Zoë" must stay "Zoë" on screen.
 */
function surfaces(input: string): Surfaces {
  const base = input
    .normalize('NFKC')
    .toLowerCase()
    .replace(INVISIBLE, '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '');

  const folded = base.replace(/[013457 8@$!|+]/g, (c) => LEET[c] ?? c);

  return {
    spaced: folded.replace(/[^\p{L}\p{N}]+/gu, ' ').trim(),
    plain: base.replace(/[^\p{L}\p{N}]+/gu, ' ').trim(),
    collapsed: folded.replace(/[^\p{L}\p{N}]+/gu, ''),
  };
}

/** Terms that make a subject a minor. Innocent alone — see `SEXUAL_ACTS`. */
const MINOR_TERMS =
  /\b(child|children|kid|kids|minor|minors|toddler|infant|baby|babies|preteen|pre teen|teen|teens|teenage|teenager|underage|under age|schoolgirl|school girl|schoolboy|school boy|jailbait|(\d|1[0-7])\s*(yo|y o|year old|years old))\b/;

/** Sexual acts and states. Innocent alone in most cases — combined, they are not. */
const SEXUAL_ACTS =
  /\b(sex|sexual|sexy|porn|porno|pornographic|nude|nudes|naked|nsfw|xxx|erotic|erotica|fetish|hentai|rape|raping|rapist|molest|molested|molesting|incest|orgasm|cum|creampie|blowjob|handjob|deepthroat|anal|bdsm|bukkake|gangbang|masturbat\w*|horny|slut|whore)\b/;

/**
 * Terms that are sexual-with-minors on their own, with no second word needed.
 *
 * Matched against `collapsed` as well as `spaced`, which is the only place
 * that surface is used: these are the ones worth accepting a small false
 * positive risk to catch, and they are long enough that the risk is tiny.
 */
const MINORS_ALONE = /(lolicon|loli|shotacon|shota|pedophil|paedophil|pedophile|childporn|cp ?porn)/;

/** Unambiguously pornographic or graphically sexual. Not profanity. */
const SEXUAL_EXPLICIT =
  /\b(porn|porno|pornhub|pornographic|hentai|xxx|nsfw|creampie|blowjob|handjob|deepthroat|bukkake|gangbang|cumslut|cumdump|dickgirl|fleshlight|cocksucker|felching|rimjob|analsex|anal sex|oral sex|bestiality|zoophilia|necrophilia|rape|raping|rapist|molester|incest)\b/;

/**
 * Crude sexual anatomy and acts, blocked only where `strict` applies.
 *
 * These are the joke-adjacent ones. As a nickname somebody has chosen for
 * themselves they are crude and allowed; as the name the assistant answers to
 * and signs its messages with, they are not.
 */
const SEXUAL_CRUDE = /\b(cock|dildo|cunnilingus|fellatio|penis|vagina|testicle|scrotum|butthole|anus)\b/;

/**
 * Hateful slurs.
 *
 * Deliberately short. This catches the unambiguous cases rather than
 * attempting a complete lexicon — a list long enough to cover everything is
 * also long enough to start refusing ordinary words, and the goal here is to
 * stop the obvious, not to be exhaustive.
 */
const HATE =
  /\b(nigger|nigga|niggers|faggot|fag|fags|tranny|trannies|kike|kikes|spic|spics|chink|chinks|gook|gooks|wetback|wetbacks|coon|coons|raghead|towelhead|beaner|retard|retarded|paki)\b/;

/** Threats and violent-extremist signalling. */
const VIOLENCE =
  /\b(heil hitler|sieg heil|hitler did nothing|gas the \w+|kill all \w+|death to \w+|lynch \w+|genocide|holocaust denial|white power|white genocide|isis|al qaeda|school shoot\w*|mass shoot\w*|i will kill you|kill yourself|kys)\b/;

/**
 * Is this text mostly decoration rather than language?
 *
 * Catches "Zalgo" — a base letter buried under dozens of combining marks,
 * which renders as a smear across neighbouring lines and is a layout problem
 * rather than a safety one. A few marks are ordinary accents and fine.
 */
function isUnreadable(input: string): boolean {
  const marks = (input.match(/\p{M}/gu) ?? []).length;
  const base = [...input.normalize('NFD').replace(/\p{M}/gu, '')].length;
  if (base === 0) return input.trim().length > 0;
  return marks > base * 2;
}

/**
 * Check one personalization value.
 *
 * Empty is always fine and means "unset" — clearing the greeting is how you
 * ask for the generated one back.
 *
 * The value returned on success is the input with surrounding whitespace and
 * deceptive invisibles removed, and nothing else changed: this decides whether
 * a value is allowed, it does not rewrite what somebody chose.
 */
export function checkPersonalization(
  field: PersonalizationField,
  raw: string,
): PersonalizationResult {
  const value = raw.replace(INVISIBLE, '').trim();
  if (value.length === 0) return { ok: true, value: '' };

  // Legibility before length, because Zalgo is *made of* length: a smear of
  // combining marks trips the character cap first, and "keep it under 40
  // characters" is unhelpful advice for text whose problem is that it renders
  // across three lines. The more specific diagnosis wins.
  if (isUnreadable(value)) return { ok: false, reason: 'unreadable' };
  if ([...value].length > PERSONALIZATION_LIMITS[field]) {
    return { ok: false, reason: 'too-long' };
  }

  const { spaced, plain, collapsed } = surfaces(value);

  // Zero tolerance, and the only category matched against `collapsed`.
  if (hits(MINORS_ALONE, spaced, collapsed)) {
    return { ok: false, reason: 'sexual-minors' };
  }
  // `plain` as well as `spaced`, so the numeric age rule survives leet folding.
  if (hits(MINOR_TERMS, spaced, plain) && hits(SEXUAL_ACTS, spaced, plain)) {
    return { ok: false, reason: 'sexual-minors' };
  }

  if (hits(SEXUAL_EXPLICIT, spaced, plain)) return { ok: false, reason: 'sexual-explicit' };
  if (hits(HATE, spaced, plain)) return { ok: false, reason: 'hate' };
  if (hits(VIOLENCE, spaced, plain)) return { ok: false, reason: 'violence' };

  // Atlas's own name carries the extra rule; the other two fields do not.
  if (field === 'atlasName' && hits(SEXUAL_CRUDE, spaced, plain)) {
    return { ok: false, reason: 'sexual-explicit' };
  }

  return { ok: true, value };
}

/**
 * The one line the UI shows, whatever the reason.
 *
 * Length and legibility are the exceptions: they are mechanical, telling
 * somebody the limit is genuinely helpful, and neither is a rule anybody needs
 * to be prevented from working around.
 */
export function personalizationMessage(
  field: PersonalizationField,
  reason: PersonalizationRejection,
): string {
  if (reason === 'too-long') {
    return `That's a bit long — keep it under ${PERSONALIZATION_LIMITS[field]} characters.`;
  }
  if (reason === 'unreadable') {
    return "That won't render legibly. Try fewer combining marks.";
  }
  return "That personalization isn't allowed. Try a different name or greeting.";
}
