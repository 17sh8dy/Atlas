import { describe, expect, it } from 'vitest';
import { segmentForSpeech } from '../src/models/segment';

/**
 * The invariant that matters most, checked on every case below: the pieces put
 * back together must contain the same words, in the same order, as the input.
 * A segmenter that occasionally eats a sentence produces audio that disagrees
 * with the transcript on screen, and nobody would think to look here for it.
 */
function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

function preservesWords(input: string, pieces: string[]): boolean {
  return words(pieces.join(' ')).join(' ') === words(input).join(' ');
}

describe('segmentForSpeech', () => {
  it('returns nothing for empty or blank input', () => {
    expect(segmentForSpeech('')).toEqual([]);
    expect(segmentForSpeech('   \n  ')).toEqual([]);
  });

  it('keeps a single sentence whole', () => {
    expect(segmentForSpeech('Good evening.')).toEqual(['Good evening.']);
  });

  it('ships the first sentence on its own, however short', () => {
    // The whole point of the exercise: "Yes." must not wait for the paragraph
    // behind it, so it is a piece by itself even though it is far under the
    // merge floor that applies to everything after it.
    const pieces = segmentForSpeech(
      'Yes. The disk has forty gigabytes free, which is comfortable for now.',
    );
    expect(pieces[0]).toBe('Yes.');
    expect(pieces.length).toBeGreaterThan(1);
  });

  it('merges short later sentences rather than sending each one', () => {
    const input =
      'Right, here is where things stand. One. Two. Three. Four. Five. Six. Seven. Eight.';
    const pieces = segmentForSpeech(input);
    expect(pieces[0]).toBe('Right, here is where things stand.');
    // Everything after the first is gathered up instead of becoming seven
    // separate round trips.
    expect(pieces.length).toBeLessThanOrEqual(3);
    expect(preservesWords(input, pieces)).toBe(true);
  });

  it('does not split a decimal', () => {
    const pieces = segmentForSpeech('You have 3.5 gigabytes free.');
    expect(pieces).toEqual(['You have 3.5 gigabytes free.']);
  });

  it('does not split a version number or a hostname', () => {
    expect(segmentForSpeech('Running version 1.2.3 now.')).toEqual(['Running version 1.2.3 now.']);
    expect(segmentForSpeech('Open example.com for me.')).toEqual(['Open example.com for me.']);
  });

  it('does not split on an abbreviation', () => {
    expect(segmentForSpeech('Dr. Chandra is offline.')).toEqual(['Dr. Chandra is offline.']);
    expect(segmentForSpeech('Files, folders, apps, etc. are all indexed.')).toEqual([
      'Files, folders, apps, etc. are all indexed.',
    ]);
  });

  it('does not split on initials', () => {
    expect(segmentForSpeech('J. R. R. Tolkien wrote it.')).toEqual([
      'J. R. R. Tolkien wrote it.',
    ]);
  });

  it('treats a run of terminators as one boundary', () => {
    const pieces = segmentForSpeech('Really?! I had no idea...');
    expect(pieces[0]).toBe('Really?!');
    expect(preservesWords('Really?! I had no idea...', pieces)).toBe(true);
  });

  it('breaks at a newline', () => {
    const pieces = segmentForSpeech('First line\nSecond line');
    expect(pieces[0]).toBe('First line');
    expect(preservesWords('First line\nSecond line', pieces)).toBe(true);
  });

  it('breaks an over-long sentence at a clause boundary, never mid-word', () => {
    // One sentence, no full stops until the end, comfortably over the ceiling.
    const input = `${'the quick brown fox jumps over the lazy dog, '.repeat(12)}and then stops.`;
    const pieces = segmentForSpeech(input);

    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(320);
      expect(piece.trim()).toBe(piece);
    }
    expect(preservesWords(input, pieces)).toBe(true);
  });

  it('cuts an unbroken token rather than exceeding the ceiling', () => {
    // Nothing to split on at all. The ceiling is a hard limit for the model
    // behind this, so it wins over keeping the token intact.
    const input = 'x'.repeat(900);
    const pieces = segmentForSpeech(input);
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(320);
    expect(pieces.join('')).toBe(input);
  });

  it('keeps every word of a realistic multi-paragraph reply', () => {
    const input = [
      'Good evening. Everything is running normally.',
      '',
      'The disk has 41.2 GB free, memory is at 38 per cent, and nothing is',
      'pinned at the top of the process list. Dr. Watson has not filed a',
      'crash report since Tuesday.',
      '',
      'Would you like the detail, or shall I leave it there?',
    ].join('\n');

    const pieces = segmentForSpeech(input);
    expect(pieces.length).toBeGreaterThan(1);
    expect(preservesWords(input, pieces)).toBe(true);
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(320);
      expect(piece).not.toBe('');
    }
  });
});
