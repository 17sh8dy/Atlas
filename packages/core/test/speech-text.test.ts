import { describe, expect, it } from 'vitest';
import { prepareForSpeech } from '../src/models/speech-text';

describe('prepareForSpeech', () => {
  it('returns nothing for empty or blank input', () => {
    expect(prepareForSpeech('')).toBe('');
    expect(prepareForSpeech('   \n  ')).toBe('');
  });

  it('leaves ordinary sentences untouched', () => {
    expect(prepareForSpeech('Everything is running normally.')).toBe(
      'Everything is running normally.',
    );
  });

  describe('emoji — the icon every skill message leads with', () => {
    // One per skill pack, taken straight from the real message templates, so
    // this fails the moment a future icon falls outside the property this
    // relies on rather than the day someone happens to hear it.
    const REAL_ICONS = [
      '🏦',
      '🖼️',
      '💾',
      '🔬',
      '➗',
      '🌐',
      '🎂',
      '📆',
      '🗓️',
      '⏱️',
      '🧮',
      '📐',
      '⏳',
      '📋',
      '⚠️',
      'ℹ️',
      '🔋',
      '💽',
      '📊',
      '🔗',
      '🔎',
      '🧭',
      '🤝',
      '🗺️',
      '🧠',
      '✈️',
      '🎯',
      '🛠️',
      '🔒',
      '📝',
      '✅',
      '☑️',
      '🪙',
      '🎲',
      '🔐',
      '🆔',
      '🧾',
      '🗑️',
      '#️⃣',
    ];

    it.each(REAL_ICONS)('strips %s from the front of a message', (icon) => {
      const result = prepareForSpeech(`${icon} Everything is running normally.`);
      expect(result).toBe('Everything is running normally.');
    });

    it('strips an emoji in the middle of a sentence without leaving a gap', () => {
      expect(prepareForSpeech('The disk 💾 has room to spare.')).toBe(
        'The disk has room to spare.',
      );
    });
  });

  describe('markdown, in case an LLM reply carries any', () => {
    it('unwraps bold and italic asterisks', () => {
      expect(prepareForSpeech('This is **important** and *urgent*.')).toBe(
        'This is important and urgent.',
      );
    });

    it('leaves a literal multiplication-shaped asterisk alone', () => {
      // Spaces on both sides of the mark are not what emphasis looks like.
      expect(prepareForSpeech('roughly 3 * 4 tiles')).toBe('roughly 3 * 4 tiles');
    });

    it('unwraps inline code and a fenced block, keeping the content', () => {
      expect(prepareForSpeech('Run `npm test` first.')).toBe('Run npm test first.');
      expect(prepareForSpeech('```\nconst x = 1;\n```')).toBe('const x = 1;');
    });

    it('speaks a markdown link as its label, not its destination', () => {
      expect(prepareForSpeech('See [the docs](https://example.com/docs) for more.')).toBe(
        'See the docs for more.',
      );
    });

    it('strips a heading marker, a blockquote marker, and a bullet marker', () => {
      expect(prepareForSpeech('# Status')).toBe('Status');
      expect(prepareForSpeech('> Everything is fine')).toBe('Everything is fine');
      expect(prepareForSpeech('- first item\n- second item')).toBe('first item\nsecond item');
    });

    it('does not touch an underscore in a real file name', () => {
      // Underscore emphasis is deliberately not handled — see the module doc.
      expect(prepareForSpeech('Opening my_file_name.txt.')).toBe('Opening my_file_name.txt.');
    });
  });

  describe('URLs', () => {
    it('drops the scheme and a leading www so the domain reads as one', () => {
      expect(prepareForSpeech('Opening https://www.example.com/search.')).toBe(
        'Opening example.com/search.',
      );
      expect(prepareForSpeech('Opening http://example.com.')).toBe('Opening example.com.');
    });
  });

  describe('Windows paths', () => {
    it('turns a drive and its segments into something a person would say', () => {
      expect(prepareForSpeech('Opening D:\\Dev\\Atlas.')).toBe('Opening D drive, Dev, Atlas.');
    });

    it('keeps trailing punctuation attached to the last segment', () => {
      expect(prepareForSpeech('D:\\Dev\\notes.txt, apparently.')).toBe(
        'D drive, Dev, notes.txt, apparently.',
      );
    });

    it('handles a bare drive with nothing after it', () => {
      expect(prepareForSpeech('Everything under D:\\ is untouched.')).toBe(
        'Everything under D drive is untouched.',
      );
    });

    it('does not mistake a time or a ratio for a path', () => {
      expect(prepareForSpeech('It is 4:30 now.')).toBe('It is 4:30 now.');
    });
  });

  describe('symbols with one unambiguous spoken word', () => {
    it('reads × as "times", spaced or not', () => {
      expect(prepareForSpeech('1920×1080 pixels.')).toBe('1920 times 1080 pixels.');
      expect(prepareForSpeech('12 is not prime — 2 × 2 × 3.')).toBe(
        '12 is not prime — 2 times 2 times 3.',
      );
    });

    it('reads → as "to"', () => {
      expect(prepareForSpeech('50 → 75 is a 50% increase.')).toBe('50 to 75 is a 50% increase.');
    });

    it('reads the middle-dot fact separator as a full stop', () => {
      expect(prepareForSpeech('41 GB free · 38% used · nothing pinned.')).toBe(
        '41 GB free. 38% used. nothing pinned.',
      );
    });
  });

  describe('whitespace', () => {
    it('collapses the gap an emoji or a stripped mark leaves behind', () => {
      expect(prepareForSpeech('🏦  Balance updated.')).toBe('Balance updated.');
    });

    it('preserves a paragraph break rather than joining it into one sentence', () => {
      expect(prepareForSpeech('First paragraph.\n\nSecond paragraph.')).toBe(
        'First paragraph.\n\nSecond paragraph.',
      );
    });

    it('trims leading and trailing whitespace from the whole reply', () => {
      expect(prepareForSpeech('  Hello there.  ')).toBe('Hello there.');
    });
  });

  describe('a realistic full message', () => {
    it('cleans a genuine skill message end to end', () => {
      const input = 'ℹ️ notes.txt — file · 2.5 KB · changed D:\\Dev\\Atlas.';
      expect(prepareForSpeech(input)).toBe(
        'notes.txt — file. 2.5 KB. changed D drive, Dev, Atlas.',
      );
    });

    it('preserves every real word — nothing here should ever delete meaning', () => {
      const input = '🔋 82%, and charging.';
      const result = prepareForSpeech(input);
      expect(result).toContain('82%');
      expect(result).toContain('charging');
    });
  });
});
