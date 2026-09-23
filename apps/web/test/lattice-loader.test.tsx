import { describe, expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LatticeLoader, type LatticeLoaderProps } from '@atlas/ui';

const render = (props: Partial<LatticeLoaderProps> = {}) =>
  renderToStaticMarkup(createElement(LatticeLoader, { phase: 'active', verb: 'Thinking', ...props }));

describe('LatticeLoader — active', () => {
  test('draws a 4x4 lattice by default', () => {
    const html = render();
    expect((html.match(/atlas-lattice-cell/g) ?? []).length).toBe(16);
  });

  test('a 3x3 lattice has nine cells', () => {
    const html = render({ size: 3 });
    expect((html.match(/atlas-lattice-cell/g) ?? []).length).toBe(9);
  });

  test('shows the verb and, once there is one, the step label', () => {
    const noLabel = render({ verb: 'Thinking' });
    expect(noLabel).toContain('Thinking');
    expect(noLabel).not.toContain('—');

    const withLabel = render({ verb: 'Working', label: 'Searching the web' });
    expect(withLabel).toContain('Working');
    expect(withLabel).toContain('Searching the web');
  });

  test('shows the elapsed time as a separate, non-live timer', () => {
    const html = render({ elapsed: '4.2s' });
    expect(html).toContain('4.2s');
    expect(html).toMatch(/role="timer"/);
    expect(html).toMatch(/aria-label="Time spent so far"/);
  });

  test('no glyph is drawn while active', () => {
    const html = render();
    expect(html).not.toContain('lucide-check');
    expect(html).not.toContain('lucide-x');
  });
});

describe('LatticeLoader — resolved', () => {
  test('success draws a check, not the lattice', () => {
    const html = render({ phase: 'success', verb: 'Done', label: 'Ran 3 actions' });
    expect(html).not.toContain('atlas-lattice-cell');
    expect(html).toContain('text-success');
    expect(html).toContain('Ran 3 actions');
  });

  test('error and halted both draw a cross, coloured as an error', () => {
    for (const phase of ['error', 'halted'] as const) {
      const html = render({ phase, verb: phase === 'error' ? 'Error' : 'Stopped' });
      expect(html).not.toContain('atlas-lattice-cell');
      expect(html).toContain('text-danger');
    }
  });
});

describe('LatticeLoader — the status text is announced once, not once a tick', () => {
  test('the live region carries the verb and label, and only that region is aria-live', () => {
    const html = render({ verb: 'Working', label: 'Searching the web', elapsed: '1.2s' });
    // Exactly one aria-live region: the verb/label, never the ticking clock.
    expect((html.match(/aria-live="polite"/g) ?? []).length).toBe(1);
    expect(html).toMatch(/aria-live="polite"[^>]*aria-label="Working — Searching the web"/);
  });
});

describe('LatticeLoader — text cannot become markup', () => {
  test('a label is escaped, not injected', () => {
    const html = render({ label: '<img src=x onerror=alert(1)>' });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});
