/**
 * The composer's working ring. What can be checked without a browser: that it
 * is always mounted (so it can fade rather than pop), that `active` is what
 * switches it on, and that the layers the comet is built from are all present.
 * How it looks and moves is checked by watching it run.
 */
import { describe, expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkingRing } from '../src/components/WorkingRing';

const render = (active: boolean) => renderToStaticMarkup(createElement(WorkingRing, { active }));

describe('WorkingRing', () => {
  test('is mounted while idle, switched off — so turning on is a fade, not a pop', () => {
    const html = render(false);
    expect(html).toContain('data-active="false"');
    expect(html).toContain('atlas-ring');
  });

  test('active switches it on', () => {
    expect(render(true)).toContain('data-active="true"');
  });

  test('every layer of the comet is there, and each trailing one is measured as a lap', () => {
    const html = render(true);
    for (const layer of ['base', 'bloom', 'tail-far', 'tail-mid', 'tail-near', 'head']) {
      expect(html).toContain(`atlas-ring-${layer}`);
    }
    // pathLength=100 is what makes the animation constant-speed at any size.
    expect(html.match(/pathLength="100"/g)).toHaveLength(5);
  });

  test('is decorative: hidden from assistive tech and never catches the pointer', () => {
    const html = render(true);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('pointer-events-none');
  });
});
