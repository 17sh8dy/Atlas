import { describe, expect, test } from 'vitest';
import { formatLive, hasSources, parseAnswer, segmentCitations } from '../src/components/citations';

// Exactly the shape `formatEvidenceFooter` produces.
const ANSWER = [
  'It is **Chapter 7 Season 4** [2]. The season ends on October 31 [1][5].',
  '',
  'Sources (2026-09-20, via Tavily) — 4 independent sites agree:',
  '[1] Fortnite Update Schedule 2026 — https://accountshark.net/blog/schedule',
  '[2] Fortnite Next Season: Override — Ponly — https://ponly.com/fortnite-next-season',
  '[5] When Does Season 4 End? — https://timesaver.gg/blog/season-4',
  '· season 4 — 4 of 4 sources',
  '· Some sources also mention other seasons (1, 9) — likely past or upcoming ones.',
].join('\n');

describe('parseAnswer', () => {
  const p = parseAnswer(ANSWER);

  test('splits the words from the footer', () => {
    expect(p.body).toBe('It is **Chapter 7 Season 4** [2]. The season ends on October 31 [1][5].');
    expect(p.heading).toContain('via Tavily');
  });

  test('reads every source, with its number, title, address and site', () => {
    expect(p.sources.map((s) => s.n)).toEqual([1, 2, 5]);
    expect(p.sources[1]).toEqual({
      n: 2,
      title: 'Fortnite Next Season: Override — Ponly',
      url: 'https://ponly.com/fortnite-next-season',
      host: 'ponly.com',
    });
    expect(p.sources[0]!.host).toBe('accountshark.net');
  });

  test('a title that itself contains a dash is not cut short', () => {
    expect(p.sources[1]!.title).toContain('Override — Ponly');
  });

  test('keeps the source-check notes', () => {
    expect(p.notes).toHaveLength(2);
    expect(p.notes[0]).toBe('season 4 — 4 of 4 sources');
  });

  test('text with no footer is returned untouched', () => {
    const plain = 'Lima is the capital of Peru [1] if you believe the atlas.';
    expect(parseAnswer(plain)).toEqual({ body: plain, heading: '', sources: [], notes: [] });
  });

  test('a "Sources (" in ordinary prose with no source lines is not a footer', () => {
    const prose = 'Here is what I know.\n\nSources (as I remember them) are thin.';
    expect(parseAnswer(prose).sources).toEqual([]);
    expect(parseAnswer(prose).body).toBe(prose);
  });

  test('only http(s) addresses become sources — nothing executable', () => {
    const t =
      'x\n\nSources (d) — ok:\n[1] Bad — javascript:alert(1)\n[2] Also bad — file:///C:/secret.txt\n[3] Good — https://ok.example/';
    expect(parseAnswer(t).sources.map((s) => s.url)).toEqual(['https://ok.example/']);
  });

  test('works on the model-is-off write-up too', () => {
    const fallback =
      "The AI model isn't available right now, so I can't write this up.\n\nFrom the sources: season 2.\n\n[1] fortnite.gg: Season 2 is live.\n\nSources (2026-09-20, via Tavily) — 2 independent sites agree:\n[1] Fortnite.GG — https://fortnite.gg/season";
    expect(parseAnswer(fallback).sources).toHaveLength(1);
  });
});

describe('segmentCitations', () => {
  test('finds each marker, in order, keeping the words between', () => {
    expect(segmentCitations('A [1] b [2][3].')).toEqual([
      { type: 'text', text: 'A ' },
      { type: 'cite', n: 1 },
      { type: 'text', text: ' b ' },
      { type: 'cite', n: 2 },
      { type: 'cite', n: 3 },
      { type: 'text', text: '.' },
    ]);
  });

  test('text without markers is one segment; empty text is none', () => {
    expect(segmentCitations('plain')).toEqual([{ type: 'text', text: 'plain' }]);
    expect(segmentCitations('')).toEqual([]);
  });

  test('brackets that are not citations are left alone', () => {
    const segs = segmentCitations('array[i] and [note] and [123]');
    expect(segs.every((s) => s.type === 'text')).toBe(true);
    expect(segs.map((s) => (s.type === 'text' ? s.text : '')).join('')).toBe(
      'array[i] and [note] and [123]',
    );
  });

  test('putting the segments back together loses nothing', () => {
    const text = 'One [1], two [2]. Done [10].';
    const back = segmentCitations(text)
      .map((s) => (s.type === 'text' ? s.text : `[${s.n}]`))
      .join('');
    expect(back).toBe(text);
  });
});

describe('hasSources', () => {
  test('true only for a real footer', () => {
    expect(hasSources(ANSWER)).toBe(true);
    expect(hasSources('just words [1]')).toBe(false);
  });
});

describe('formatLive', () => {
  test.each([
    [0, '0.0s'],
    [400, '0.4s'],
    [4200, '4.2s'],
    [9949, '9.9s'],
    [10_000, '10s'],
    [59_999, '59s'],
    [60_000, '1:00'],
    [125_000, '2:05'],
    [-5, '0.0s'],
    [Number.NaN, '0.0s'],
  ])('%d ms -> %s', (ms, want) => {
    expect(formatLive(ms)).toBe(want);
  });
});
