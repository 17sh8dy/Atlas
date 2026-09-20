import { describe, expect, test } from 'vitest';
import type { ClarifyChoice } from '@atlas/core';
import { readClarifyReply } from '../src/atlas/clarify-reply';

const CHOICES: ClarifyChoice[] = [
  { id: 'specific', label: 'Tell me a specific game', input: { placeholder: 'Which game?' } },
  {
    id: 'several',
    label: 'Tell me several games',
    input: { placeholder: 'games, separated by commas', many: true },
  },
  { id: 'skip', label: 'Just open Steam' },
  { id: 'other', label: 'Something else' },
];

describe('readClarifyReply', () => {
  test('plain words are the answer', () => {
    expect(readClarifyReply('Hades', CHOICES)).toEqual({
      kind: 'answer',
      answer: { kind: 'text', text: 'Hades', many: false },
      label: 'Hades',
    });
  });

  test('surrounding space is ignored', () => {
    expect(readClarifyReply('   Hades  ', CHOICES)).toMatchObject({
      answer: { text: 'Hades' },
    });
  });

  test('commas, semicolons and lines mean several', () => {
    for (const typed of ['Hades, Celeste', 'Hades; Celeste', 'Hades\nCeleste']) {
      expect(readClarifyReply(typed, CHOICES)).toMatchObject({
        answer: { kind: 'text', many: true },
      });
    }
  });

  test('the word "and" does not mean several — names contain it', () => {
    expect(readClarifyReply('Ratchet and Clank', CHOICES)).toMatchObject({
      answer: { many: false },
    });
  });

  test('a number picks that option; one that is the whole answer resolves at once', () => {
    expect(readClarifyReply('3', CHOICES)).toEqual({
      kind: 'answer',
      answer: { kind: 'choice', id: 'skip' },
      label: 'Just open Steam',
    });
    expect(readClarifyReply('4.', CHOICES)).toMatchObject({
      answer: { kind: 'choice', id: 'other' },
    });
    expect(readClarifyReply('3)', CHOICES)).toMatchObject({ answer: { id: 'skip' } });
  });

  test('a number for an option that needs typing asks for the typing, and keeps waiting', () => {
    expect(readClarifyReply('1', CHOICES)).toEqual({ kind: 'needs-text', prompt: 'Which game?' });
    expect(readClarifyReply('2', CHOICES)).toEqual({
      kind: 'needs-text',
      prompt: 'games, separated by commas',
    });
  });

  test('a number with no such option is not treated as an answer', () => {
    expect(readClarifyReply('9', CHOICES).kind).toBe('needs-text');
  });

  test('a few plain words back out', () => {
    for (const w of ['cancel', 'Never mind', 'nevermind', 'forget it', 'stop', 'no']) {
      expect(readClarifyReply(w, CHOICES)).toMatchObject({ answer: { kind: 'cancelled' } });
    }
  });

  test('"skip" takes the skip option, when there is one', () => {
    expect(readClarifyReply('skip', CHOICES)).toMatchObject({
      answer: { kind: 'choice', id: 'skip' },
    });
    // with no skip option it is just a word
    expect(readClarifyReply('skip', [CHOICES[0]!])).toMatchObject({
      answer: { kind: 'text', text: 'skip' },
    });
  });

  test('a game whose name is a number is still reachable by typing more than the number', () => {
    expect(readClarifyReply('1942', CHOICES)).toMatchObject({
      answer: { kind: 'text', text: '1942' },
    });
  });

  test('what is typed is never treated as a new instruction', () => {
    expect(readClarifyReply('open notepad', CHOICES)).toMatchObject({
      answer: { kind: 'text', text: 'open notepad' },
    });
  });
});

describe('fixed-choice questions', () => {
  const VOLUME: ClarifyChoice[] = [
    { id: 'value:up', label: 'Up', value: 'up' },
    { id: 'value:down', label: 'Down', value: 'down' },
    { id: 'skip', label: 'Never mind' },
    { id: 'other', label: 'Something else' },
  ];

  test('a number picks that option outright — none of them needs typing', () => {
    expect(readClarifyReply('2', VOLUME)).toEqual({
      kind: 'answer',
      answer: { kind: 'choice', id: 'value:down' },
      label: 'Down',
    });
  });

  test('typing the word is an answer the engine can match to an option', () => {
    expect(readClarifyReply('up', VOLUME)).toMatchObject({
      answer: { kind: 'text', text: 'up' },
    });
  });
});
