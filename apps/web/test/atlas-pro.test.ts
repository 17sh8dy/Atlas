import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AtlasPro, PRO_FEATURES } from '../src/pages/settings/AtlasPro';
import { SECTIONS } from '../src/pages/Settings';

const raw = readFileSync(fileURLToPath(new URL('../src/pages/settings/AtlasPro.tsx', import.meta.url)), 'utf8');
// The file's own explanation names the things it must never do; only the code counts.
const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('Atlas Pro preview', () => {
  test('lists exactly the seven planned features, each marked as planned', () => {
    expect(PRO_FEATURES.map((f) => f.title)).toEqual([
      'Atlas Mobile',
      'Atlas Connect',
      'Advanced Long-Term Memory',
      'Persistent Chat History',
      'Extended Conversation Memory',
      'Cross-Device Sync',
      'Advanced Remote Automation',
    ]);
    const html = renderToStaticMarkup(createElement(AtlasPro));
    expect(html.match(/>Planned</g)?.length).toBe(PRO_FEATURES.length);
  });

  test('says plainly that nothing is available, and that today stays free', () => {
    const html = renderToStaticMarkup(createElement(AtlasPro));
    expect(html).toContain('Coming soon');
    expect(html).toContain('None of it exists yet');
    expect(html).toContain('nothing is for sale');
    expect(html).toContain('Everything Atlas does today stays free');
  });

  test('the button is a disabled label, not an action', () => {
    const html = renderToStaticMarkup(createElement(AtlasPro));
    const button = /<button[^>]*>Coming Soon<\/button>/.exec(html)?.[0] ?? '';
    expect(button).toContain('disabled');
    expect(button).toContain('aria-disabled="true"');
    expect(source).not.toMatch(/onClick|openUrl|invoke\(|fetch\(|href=/);
  });

  test('never promises what nobody can know', () => {
    const everything = `${source}\n${PRO_FEATURES.map((f) => f.plan).join('\n')}`.toLowerCase();
    for (const banned of ['unlimited', 'guarantee', 'infinite', 'never forget', 'any phone']) {
      expect(everything).not.toContain(banned);
    }
  });

  test('has no payment or subscription machinery', () => {
    for (const word of ['stripe', 'checkout', 'paypal', 'subscribe now', 'buy now']) {
      expect(source.toLowerCase()).not.toContain(word);
    }
  });

  test('sits in Settings, above Account and About', () => {
    const ids = SECTIONS.map((s) => s.id);
    expect(ids).toContain('atlas-pro');
    expect(ids.indexOf('atlas-pro')).toBeLessThan(ids.indexOf('account'));
  });
});
