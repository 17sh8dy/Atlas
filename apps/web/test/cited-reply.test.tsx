import { describe, expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CitedReply } from '../src/components/CitedReply';

const FOOTER = [
  '',
  '',
  'Sources (2026-09-20, via Tavily) — 2 independent sites agree:',
  '[1] Fortnite.GG — https://fortnite.gg/season',
  '[2] IGN — https://www.ign.com/articles/season-4',
  '· season 4 — 2 of 2 sources',
].join('\n');

const render = (text: string, streaming = false) =>
  renderToStaticMarkup(createElement(CitedReply, { text, streaming, onOpen: () => {} }));

describe('CitedReply', () => {
  test('a marker with a source becomes a numbered button carrying the source name', () => {
    const html = render(`It is Season 4 [2].${FOOTER}`);
    expect(html).toMatch(/<button[^>]*aria-label="Source 2: IGN, ign\.com"[^>]*>2<\/button>/);
    expect(html).toContain('title="IGN — ign.com"');
  });

  test('the words around the marker are kept, in order', () => {
    const html = render(`Before [1] middle [2] after.${FOOTER}`);
    const text = html.replace(/<[^>]+>/g, '');
    expect(text.indexOf('Before')).toBeLessThan(text.indexOf('middle'));
    expect(text.indexOf('middle')).toBeLessThan(text.indexOf('after.'));
  });

  test('a marker with NO matching source is plain, never a link to nowhere', () => {
    const html = render(`Season 4 [7].${FOOTER}`);
    expect(html).not.toMatch(/aria-label="Source 7/);
    expect(html).toMatch(/<span[^>]*>7<\/span>/);
  });

  test('a URL the model wrote in its own prose is never made clickable', () => {
    const html = render(`See https://evil.example/login for details [1].${FOOTER}`);
    expect(html).toContain('https://evil.example/login'); // still shown, as text
    expect(html).not.toMatch(/<a\b/);
    // and it is not the target of any button: buttons only carry footer addresses
    expect(html).not.toMatch(/<button[^>]*evil\.example/);
  });

  test('the footer becomes a compact list: site, title, and the source check', () => {
    const html = render(`Answer [1].${FOOTER}`);
    expect(html).toContain('fortnite.gg');
    expect(html).toContain('Fortnite.GG');
    expect(html).toContain('via Tavily');
    expect(html).toContain('2 independent sites agree');
    expect(html).toContain('season 4 — 2 of 2 sources');
  });

  test('the raw footer text is not shown twice', () => {
    const html = render(`Answer [1].${FOOTER}`);
    expect(html.match(/https:\/\/fortnite\.gg\/season/g) ?? []).toHaveLength(1); // only in the button title
  });

  test('a streaming reply shows a caret and no footer yet', () => {
    const html = render('It is Season 4 [1] and', true);
    expect(html).toContain('animate-pulse');
    expect(html).not.toContain('Sources');
  });

  test('a finished reply has no caret', () => {
    expect(render(`Done [1].${FOOTER}`, false)).not.toContain('animate-pulse');
  });

  test('plain text with nothing to cite renders as itself', () => {
    const html = render('Just an ordinary answer.');
    expect(html.replace(/<[^>]+>/g, '')).toBe('Just an ordinary answer.');
    expect(html).not.toContain('<button');
  });

  test('markup in the answer cannot become markup on the page', () => {
    const html = render('<img src=x onerror=alert(1)> [1]' + FOOTER);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});
