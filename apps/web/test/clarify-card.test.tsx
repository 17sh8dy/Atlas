import { describe, expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ClarifyChoice } from '@atlas/core';
import { ClarifyCard } from '../src/components/ClarifyCard';

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

const render = (props: Partial<Parameters<typeof ClarifyCard>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(ClarifyCard, {
      question: 'What do you mean by “open a game”?',
      choices: CHOICES,
      onAnswer: () => {},
      ...props,
    }),
  );

describe('ClarifyCard — open', () => {
  test('shows the question and every option, numbered in order', () => {
    const html = render();
    expect(html).toContain('What do you mean by “open a game”?');
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const at = (s: string) => text.indexOf(s);
    expect(at('Tell me a specific game')).toBeGreaterThan(-1);
    expect(at('Tell me a specific game')).toBeLessThan(at('Tell me several games'));
    expect(at('Tell me several games')).toBeLessThan(at('Just open Steam'));
    expect(at('Just open Steam')).toBeLessThan(at('Something else'));
    for (const n of ['1', '2', '3', '4']) expect(html).toMatch(new RegExp(`>${n}</span>`));
  });

  test('each option is a real button', () => {
    expect((render().match(/<button/g) ?? []).length).toBe(4);
  });

  test('tells the person they can simply type', () => {
    expect(render()).toContain('Or just type your answer below.');
  });

  test('is drawn as a waiting card, not as a finished one', () => {
    const html = render();
    expect(html).toContain('border-primary/40');
    expect(html).not.toContain('opacity-70');
  });

  test('question text cannot become markup', () => {
    const html = render({ question: '<img src=x onerror=alert(1)>' });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('ClarifyCard — answered', () => {
  test('a choice stays in the record, dimmed, with what was chosen and no buttons left', () => {
    const html = render({ answered: 'yes', reply: 'Hades' });
    expect(html).toContain('You chose: Hades');
    expect(html).toContain('opacity-70');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('Or just type');
  });

  test('walking away is recorded as that', () => {
    expect(render({ answered: 'no' })).toContain('You left it.');
  });

  test('a stop that landed first is recorded as that', () => {
    expect(render({ answered: 'halted' })).toContain('Halted before this was answered.');
  });

  test('answered with nothing to quote still says so', () => {
    expect(render({ answered: 'yes' })).toContain('You answered.');
  });
});
