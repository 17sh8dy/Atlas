/**
 * `LatticeRow`'s non-timing behaviour: what it renders for a given
 * `ActivityRun`, before its `useEffect` clock has ever ticked.
 *
 * ── What this does not cover ────────────────────────────────────────────────
 * The ticking itself. This repo's component tests render with
 * `renderToStaticMarkup` (see `clarify-card.test.tsx`, `update-bubble.test.tsx`)
 * rather than a DOM testing library, and `renderToStaticMarkup` never runs
 * effects — there is no browser event loop for `setInterval` to run on. Adding
 * jsdom and a DOM testing library to exercise that would be new test
 * infrastructure for this one component, which is out of scope here; see the
 * final report. What *is* covered here is real and load-bearing: that the row
 * reads `run` through the same `latticeStatusFor` the state-transition tests
 * already prove is real-data-only, and renders `0.0s` (not blank, not `NaN`)
 * before the clock has ticked at all.
 */

import { describe, expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ActivityRun } from '@atlas/core';
import { LatticeRow } from '../src/components/LatticeRow';

const render = (run: ActivityRun | null) => renderToStaticMarkup(createElement(LatticeRow, { run }));

describe('LatticeRow — before the clock has ticked', () => {
  test('no run at all: Thinking, at zero elapsed', () => {
    const html = render(null);
    expect(html).toContain('Thinking');
    expect(html).toContain('0.0s');
  });

  test('a run with a running step: the step’s own label, at zero elapsed', () => {
    const run: ActivityRun = {
      id: 'r',
      request: 'search for tide times',
      startedAt: 0,
      state: 'running',
      steps: [
        {
          id: 's0',
          label: 'Searching the web',
          state: 'running',
          startedAt: 0,
          skill: 'web.search',
        },
      ],
    };
    const html = render(run);
    expect(html).toContain('Working');
    expect(html).toContain('Searching the web');
    expect(html).toContain('0.0s');
  });

  test('a resolved run draws its check, not the lattice, even at the first render', () => {
    const run: ActivityRun = {
      id: 'r',
      request: 'open notepad',
      startedAt: 0,
      state: 'done',
      steps: [{ id: 's0', label: 'Opened Notepad', state: 'done', startedAt: 0, skill: 'app.open' }],
    };
    const html = render(run);
    expect(html).not.toContain('atlas-lattice-cell');
    expect(html).toContain('text-success');
  });
});
