/**
 * The pure parts of the knowledge-pack builder (docs/PLAN-2.0.3.md §B1, §N): page parsing and
 * validation, chunking, the safety scans, and the signed text. No file or network access here, so
 * every rule can be tested. `build-knowledge.mjs` does the reading, git checks and writing.
 */

import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign } from 'node:crypto';

export const SCHEMA = 1;
export const KEY_ID = 'atlas-knowledge-1';

/** Hard limits; the build fails rather than shipping something bigger. */
export const LIMITS = { chunkChars: 1800, packBytes: 3 * 1024 * 1024, pageChars: 60_000 };

export const STATUSES = ['Released', 'Planned', 'Unknown'];
export const REVIEWS = ['draft', 'approved'];
const PRODUCTS = ['nova', 'atlas', 'replay-gg', 'nova-cut', 'novaos', 'nova-help', 'nova-review', 'nova-legal'];

// ---- front matter ------------------------------------------------------------------------

/** A small YAML subset: `key: value`, and `key:` followed by `- item` lines. Anything else is an error. */
export function parsePage(source) {
  const text = source.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return { error: 'no front matter (the file must start with ---)' };
  const end = text.indexOf('\n---\n', 4);
  if (end < 0) return { error: 'front matter is not closed with ---' };
  const head = text.slice(4, end);
  const body = text.slice(end + 5).replace(/^\n+/, '');
  const meta = {};
  let listKey = null;
  for (const raw of head.split('\n')) {
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
    const item = /^\s+-\s+(.*)$/.exec(raw);
    if (item) {
      if (!listKey) return { error: `a list item with no key: ${raw.trim()}` };
      meta[listKey].push(item[1].trim());
      continue;
    }
    const kv = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(raw);
    if (!kv) return { error: `cannot read front matter line: ${raw.trim()}` };
    const [, key, value] = kv;
    if (value === '') {
      meta[key] = [];
      listKey = key;
    } else {
      meta[key] = unquote(value.replace(/\s+#.*$/, '').trim());
      listKey = null;
    }
  }
  return { meta, body };
}

function unquote(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
}

/** Everything wrong with a page, as plain sentences. Empty means valid. */
export function validatePage(meta, body, { today = new Date().toISOString().slice(0, 10), roadmapAllowed = false } = {}) {
  const errors = [];
  const need = (k) => meta[k] === undefined || meta[k] === '';
  for (const k of ['id', 'product', 'title', 'status', 'review', 'updated', 'sources']) {
    if (need(k)) errors.push(`missing "${k}"`);
  }
  if (!need('id') && !/^[a-z0-9][a-z0-9.-]*$/.test(meta.id)) errors.push('id must be lower-case letters, digits, dots and dashes');
  if (!need('product') && !PRODUCTS.includes(meta.product)) errors.push(`unknown product "${meta.product}"`);
  if (!need('status') && !STATUSES.includes(meta.status)) errors.push(`status must be one of ${STATUSES.join(', ')}`);
  if (!need('review') && !REVIEWS.includes(meta.review)) errors.push(`review must be one of ${REVIEWS.join(', ')}`);
  if (!need('updated')) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(meta.updated))) errors.push('updated must be YYYY-MM-DD');
    else if (String(meta.updated) > today) errors.push('updated is in the future');
  }
  if (Array.isArray(meta.sources)) {
    if (meta.sources.length === 0) errors.push('sources needs at least one address');
    for (const s of meta.sources) if (!/^https:\/\/[^\s]+$/.test(s)) errors.push(`source is not an https address: ${s}`);
  } else if (!need('sources')) errors.push('sources must be a list');
  // "Planned" may only come from the one page that is the approved public roadmap.
  if (meta.status === 'Planned' && !(meta.publicRoadmap === true && roadmapAllowed)) {
    errors.push('status Planned is only allowed on the approved public roadmap page');
  }
  if (meta.publicRoadmap === true && !roadmapAllowed) errors.push('publicRoadmap is set but this page is not the registered roadmap');
  if (body.trim().length === 0) errors.push('the page has no body');
  if (body.length > LIMITS.pageChars) errors.push(`the page is longer than ${LIMITS.pageChars} characters`);
  return errors;
}

// ---- safety scans ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  [/\bsk-[A-Za-z0-9_-]{16,}/, 'an API-style key'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, 'a GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\bAIza[0-9A-Za-z_-]{30,}/, 'a Google API key'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, 'a JWT'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\b(?:password|passwd|pwd|secret|api[-_ ]?key|access[-_ ]?token)\s*[=:]\s*["']?[A-Za-z0-9+/_-]{8,}/i, 'a credential assignment'],
];

const PERSONAL_PATTERNS = [
  [/[A-Za-z]:\\Users\\[^\\\s]+/i, 'a personal Windows path'],
  [/\/(?:Users|home)\/[a-z0-9._-]+\//i, 'a personal home path'],
  [/[A-Za-z0-9._%+-]+@(?:gmail|outlook|hotmail|yahoo|icloud)\.com/i, 'a personal email address'],
];

/** Hits that FAIL the build. `allowEmail` lists addresses a public page may carry on purpose. */
export function scanText(text, { allowEmail = [] } = {}) {
  const hits = [];
  for (const [re, what] of [...SECRET_PATTERNS, ...PERSONAL_PATTERNS]) {
    const m = re.exec(text);
    if (!m) continue;
    if (what === 'a personal email address' && allowEmail.includes(m[0].toLowerCase())) continue;
    hits.push(`${what} ("${m[0].slice(0, 24)}${m[0].length > 24 ? '…' : ''}")`);
  }
  return hits;
}

const INJECTION = [
  /ignore (?:all |your |the )?(?:previous|prior|above) (?:instructions|rules)/i,
  /disregard (?:all |your |the )?(?:previous|prior|above)/i,
  /you (?:must|should|are required to) (?:now |always )?(?:run|execute|open|delete|send|reveal)/i,
  /system prompt/i,
  /\b(?:powershell|cmd\.exe)\b.*\b(?:run|execute)\b/i,
  /reveal (?:your|the) (?:key|secret|password|instructions)/i,
];

/** Instruction-like text. NOT a failure: it is reported for review, and at runtime ALL chunks are data. */
export function injectionFlags(text) {
  return INJECTION.filter((re) => re.test(text)).map((re) => re.source);
}

// ---- chunking -------------------------------------------------------------------------------

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Splits a Markdown body into chunks by heading, never inside a code fence, and splits an over-long
 * section at paragraph boundaries. Deterministic: the same input always gives the same chunks.
 */
export function chunkMarkdown(body, pageTitle) {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const sections = [];
  let path = [pageTitle];
  let cur = { path: [...path], lines: [] };
  let fence = false;
  const flush = () => {
    const text = cur.lines.join('\n').trim();
    if (text) sections.push({ path: cur.path, text });
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) fence = !fence;
    const h = !fence && /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const level = h[1].length;
      // The first H1 is the page title itself.
      path = level === 1 ? [h[2].trim()] : [...path.slice(0, Math.max(1, level - 1)), h[2].trim()];
      cur = { path: [...path], lines: [] };
    } else {
      cur.lines.push(line);
    }
  }
  flush();

  const chunks = [];
  for (const s of sections) {
    if (s.text.length <= LIMITS.chunkChars) {
      chunks.push({ headingPath: s.path, text: s.text });
      continue;
    }
    let acc = '';
    for (const para of s.text.split(/\n{2,}/)) {
      if (acc && acc.length + para.length + 2 > LIMITS.chunkChars) {
        chunks.push({ headingPath: s.path, text: acc.trim() });
        acc = '';
      }
      acc += (acc ? '\n\n' : '') + para;
    }
    if (acc.trim()) chunks.push({ headingPath: s.path, text: acc.trim() });
  }
  return chunks.map((c, i) => ({ ...c, n: i, anchor: slug(c.headingPath.join(' ')) }));
}

// ---- verified answers (faq.md) ------------------------------------------------------------

/** Placeholders an answer may use; the engine fills them from live state (K4). */
export const KNOWN_FACTS = ['atlasVersion', 'packDate', 'autoRefresh', 'liveLookups', 'capabilityCount', 'modelName'];

/**
 * Reads knowledge/faq.md: entries start at a `## id` heading; `key: value` lines follow; everything after
 * the `answer:` line up to the next entry is the answer.
 */
export function parseFaqMarkdown(source) {
  const text = source.replace(/\r\n/g, '\n');
  const parts = text.split(/^## /m).slice(1);
  const entries = [];
  const errors = [];
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const id = part.slice(0, nl).trim();
    const lines = part.slice(nl + 1).split('\n');
    const e = { id, title: '', topic: '', aspects: [], match: [], since: '', review: '', sources: [], answer: '' };
    let i = 0;
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === 'answer:') {
        i++;
        break;
      }
      const m = /^([a-z]+):\s*(.*)$/.exec(line);
      if (!m) {
        if (line.trim()) errors.push(`${id}: cannot read line "${line.trim().slice(0, 40)}"`);
        continue;
      }
      const [, k, v] = m;
      if (k === 'aspects') e.aspects = v.split(',').map((x) => x.trim()).filter(Boolean);
      else if (k === 'match') e.match = v.split('|').map((x) => x.trim()).filter(Boolean);
      else if (k === 'sources') e.sources = v.split(/\s+/).filter(Boolean);
      else if (k in e) e[k] = v.trim();
      else errors.push(`${id}: unknown field "${k}"`);
    }
    e.answer = lines.slice(i).join('\n').trim();
    entries.push(e);
  }
  return { entries, errors };
}

/** Everything wrong with one verified answer. Empty means valid. */
export function validateFaq(e) {
  const errs = [];
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(e.id)) errs.push('id must be lower-case letters, digits, dots and dashes');
  for (const k of ['title', 'topic', 'since', 'review', 'answer']) if (!e[k]) errs.push(`missing "${k}"`);
  if (e.aspects.length === 0) errs.push('missing "aspects"');
  if (e.match.length === 0) errs.push('missing "match" phrases');
  if (e.review && !REVIEWS.includes(e.review)) errs.push(`review must be one of ${REVIEWS.join(', ')}`);
  if (e.since && !/^\d+\.\d+\.\d+$/.test(e.since)) errs.push('since must be a version like 2.0.3');
  if (e.sources.length === 0) errs.push('missing "sources"');
  for (const s of e.sources) if (!/^https:\/\/\S+$/.test(s)) errs.push(`source is not an https address: ${s}`);
  for (const m of e.answer.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)) {
    if (!KNOWN_FACTS.includes(m[1])) errs.push(`unknown placeholder {${m[1]}}`);
  }
  return errs;
}

/** Numbers an answer states that do not appear in any of its sources (placeholders are not numbers). */
export function numbersNotInSources(answer, sourceTexts) {
  const body = answer.replace(/\{[^}]*\}/g, ' ');
  const have = sourceTexts.join('\n');
  const out = [];
  for (const m of body.matchAll(/\b\d+(?:\.\d+)*\b/g)) if (!have.includes(m[0])) out.push(m[0]);
  return [...new Set(out)];
}

/** Match phrases two different entries share: an ambiguity to fix, since neither could then answer. */
export function ambiguousMatches(entries) {
  const seen = new Map();
  const out = [];
  for (const e of entries) {
    for (const p of e.match) {
      const key = p.toLowerCase().replace(/\s+/g, ' ');
      if (seen.has(key) && seen.get(key) !== e.id) out.push(`"${p}" is in both ${seen.get(key)} and ${e.id}`);
      else seen.set(key, e.id);
    }
  }
  return out;
}

// ---- the draft gate ---------------------------------------------------------------------------

/**
 * A second, independent check that nothing unreviewed is in a real pack: whatever the page filter
 * above did, a non-dev pack with even one chunk that is not \`approved\` is refused. Returns the ids.
 */
export function unapprovedChunks(chunks, dev) {
  return dev ? [] : chunks.filter((c) => c.review !== 'approved').map((c) => c.id);
}

// ---- the pack and its signature ---------------------------------------------------------------

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Exactly `knowledge_signature::canonical_payload`: what the signature covers. The pack file's
 * own bytes are hashed, so a change to any chunk changes the signed text.
 */
export function canonicalPayload({ keyId, seq, builtAt, sha256 }) {
  return ['atlas-knowledge-v1', `key=${keyId}`, `seq=${seq}`, `built=${builtAt}`, `sha256=${sha256}`].join('\n');
}

export function signPack(packBytes, { seq, builtAt }, privateKeyPem) {
  const sha256 = sha256Hex(packBytes);
  const key = createPrivateKey(privateKeyPem);
  const meta = { keyId: KEY_ID, seq, builtAt, sha256 };
  const value = cryptoSign(null, Buffer.from(canonicalPayload(meta), 'utf8'), key).toString('base64');
  return { algorithm: 'ed25519', ...meta, value };
}

export function publicKeyHex(privateKeyPem) {
  const pub = createPublicKey(createPrivateKey(privateKeyPem));
  return pub.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
}
