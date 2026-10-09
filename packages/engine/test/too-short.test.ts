import { assert, describe, expect, test } from 'vitest';
import { classifyNoise, noiseReply } from '../src/noise';
import { createCoverageGrammar } from '../src/planner/coverage-grammar';

const noise = (t: string) => classifyNoise(t)?.kind ?? null;

describe('messages nobody could act on get quoted back with a question', () => {
  test('every lone letter and digit, not just g', () => {
    for (const c of 'abcdefghijlmopqrstuvwxz') expect(noise(c), c).toBe('noise');
    for (const c of 'ABCDEFGHIJLMOPQRSTUVWXZ') expect(noise(c), c).toBe('noise');
    for (const c of '0123456789') expect(noise(c), c).toBe('noise');
    expect(noiseReply(classifyNoise('g')!)).toBe('You just said “g” — what did you mean to type, or what do you need?');
  });

  test('keyboard mash, with or without vowels', () => {
    for (const t of ['asdf', 'asdfgh', 'asdfghjkl', 'qwerty', 'qwert', 'hjkl', 'zxcv', 'xcvbn', 'poiuy', 'lkjhg', 'fdsa', 'bnm', 'jfkd', 'dfgh', 'ghjkvb', 'wrtpsdf'])
      expect(noise(t), t).toBe('noise');
  });

  test('repeated characters and runs of consonants', () => {
    for (const t of ['aaaa', 'gggg', 'lllll', 'xxx', 'ooooo', 'bcdfgh', 'sdfgjk', 'kjhgfd']) expect(noise(t), t).toBe('noise');
  });

  test('only punctuation or symbols', () => {
    for (const t of ['?', '??', '???', '...', '!!!', '@#$%', '---', '/', '\\', '*', ';;']) expect(noise(t), t).toBe('noise');
  });

  test('several noise pieces together', () => {
    for (const t of ['g h j', 'asdf jkl', 'q w e r', 'x w z', 'a b', 'sdf, dfg']) expect(noise(t), t).toBe('noise');
  });

  test('thinking sounds are not gibberish, and get a different answer', () => {
    for (const t of ['uh', 'um', 'hmm', 'hmmm', 'mhm', 'er', 'Huh?', 'uh um']) expect(noise(t), t).toBe('filler');
    expect(noiseReply(classifyNoise('hmm')!)).toMatch(/I’m here/);
  });
});

describe('and real messages are left alone', () => {
  test('words, short words, answers, numbers, smileys, emoji', () => {
    for (const t of [
      'hi', 'ok', 'no', 'up', 'yo', 'y', 'n', 'k', 'yes', 'weather', 'chicken', 'strengths', 'rhythm', 'gym', 'sky', 'my', 'try', 'why',
      '42', '2024', '3.14', 'mp3', '4k', '1080p', 'x7', 'tv', 'pc', 'cd',
      ':)', ':(', ';)', ':D', '<3', '^_^', '😀', '👍', 'hello there', 'what is a lagoon', 'open notepad', 'how do you pronounce chicken',
      'qwerty keyboard layout and why it exists', 'asdf is a test string I use sometimes',
    ])
      expect(noise(t), t).toBeNull();
  });
  test('empty, huge, and pasted text are not classified', () => {
    expect(noise('')).toBeNull();
    expect(noise('   ')).toBeNull();
    expect(noise('a '.repeat(30))).toBeNull();
    expect(noise('g h j k l m n')).toBeNull(); // seven pieces: somebody pasting, not typing
  });
});

test('pronounce and spell questions plan offline skills', () => {
  const rule = createCoverageGrammar().find((r) => r.name === 'tinyUtilities')!;
  const first = (t: string) => {
    const p = rule.test(t.toLowerCase(), t, {} as never) as { steps: Array<{ skill: string; args: { text: string } }> } | null;
    return p ? `${p.steps[0]!.skill}:${p.steps[0]!.args.text}` : null;
  };
  assert.equal(first('how do you pronounce chicken'), 'text.pronounce:chicken');
  assert.equal(first('How do you say quinoa?'), 'text.pronounce:quinoa');
  assert.equal(first('how is "choir" pronounced'), 'text.pronounce:choir');
  assert.equal(first('pronounce chicken'), 'text.pronounce:chicken');
  assert.equal(first('how do you spell necessary'), 'text.spell:necessary');
  assert.equal(first('how is necessary spelled?'), 'text.spell:necessary');
});
