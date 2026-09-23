/**
 * `LatticeRow`'s non-timing behaviour: what it renders for a given
 * `ActivityRun`, before its `useEffect` clock has ever ticked.
 *
 * ── Two layers, always both in the DOM ──────────────────────────────────────
 * The crossfade (expanded header+steps <-> one settled line) is driven purely
 * by CSS classes keyed off `phase`, not a timer — see the component's own doc
 * comment. That means both layers are always present in the markup; which one
 * is *visible* is `aria-hidden`/opacity/blur. These tests split the two
 * `<div aria-hidden=…>` layers apart and check each one, rather than asking
 * "is X in the page at all" — the resolved layer's check icon and the active
 * layer's lattice cells are BOTH always in the HTML, by design.
 *
 * ── What this does not cover ────────────────────────────────────────────────
 * The animated crossfade itself, or the clock ticking. `renderToStaticMarkup`
 * (this repo's component-test convention — see `clarify-card.test.tsx`,
 * `update-bubble.test.tsx`) never runs effects or a browser compositor. What
 * *is* covered: that the right layer is marked visible for a given `run`, that
 * the step list is the real steps (via the same `StepRow` `ActivityPanel`
 * uses), and that a resolved run is correct on the very first render — no
 * animation to wait out before the right content shows up.
 */

import { describe, expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ActivityRun } from '@atlas/core';
import { LatticeRow } from '../src/components/LatticeRow';

const render = (run: ActivityRun | null) => renderToStaticMarkup(createElement(LatticeRow, { run }));

/** The two crossfade layers are the only `<div aria-hidden=…>` elements this component emits. */
function splitLayers(html: string): { expanded: string; settled: string } {
  const first = html.indexOf('<div aria-hidden=');
  const second = html.indexOf('<div aria-hidden=', first + 1);
  expect(first).toBeGreaterThan(-1);
  expect(second).toBeGreaterThan(first);
  return { expanded: html.slice(first, second), settled: html.slice(second) };
}

const RUNNING: ActivityRun = {
  id: 'r',
  request: 'search for tide times',
  startedAt: 0,
  state: 'running',
  steps: [{ id: 's0', label: 'Searching the web', state: 'running', startedAt: 0, skill: 'web.search' }],
};

const RESOLVED: ActivityRun = {
  id: 'r',
  request: 'open notepad',
  startedAt: 0,
  state: 'done',
  steps: [{ id: 's0', label: 'Opened Notepad', state: 'done', startedAt: 0, skill: 'app.open' }],
};

describe('LatticeRow — while a run is active', () => {
  test('no run at all: the expanded layer is visible and reads Thinking, at zero elapsed', () => {
    const { expanded, settled } = splitLayers(render(null));
    expect(expanded).toContain('aria-hidden="false"');
    expect(expanded).toContain('Thinking');
    expect(expanded).toContain('0.0s');
    expect(settled).toContain('aria-hidden="true"');
  });

  test('a running step: its own real label is in the expanded header AND in the step list beneath', () => {
    const { expanded, settled } = splitLayers(render(RUNNING));
    expect(expanded).toContain('aria-hidden="false"');
    // The header (LatticeLoader's `label`, both in its visible text and its
    // aria-label) and the step row (`StepRow`) all say the same real thing —
    // see the component's doc comment on why that duplication is the
    // reference pattern, not an oversight.
    expect((expanded.match(/Searching the web/g) ?? []).length).toBe(3);
    expect(expanded).toContain('atlas-lattice-cell');
    expect(expanded).toContain('border-l pl-3.5');
    // While still active, the hidden settled layer mirrors the same header
    // (nothing has resolved yet to summarise) but never gets a step list —
    // only the expanded layer ever renders one.
    expect(settled).toContain('aria-hidden="true"');
    expect(settled).not.toContain('border-l pl-3.5');
  });

  test('a run with no steps yet renders no step list at all', () => {
    const noSteps: ActivityRun = { ...RUNNING, steps: [] };
    const { expanded } = splitLayers(render(noSteps));
    expect(expanded).not.toContain('border-l pl-3.5');
  });
});

describe('LatticeRow — resolved, from the first render', () => {
  test('the settled layer is visible and shows the real summary, not the lattice', () => {
    const { settled } = splitLayers(render(RESOLVED));
    expect(settled).toContain('aria-hidden="false"');
    expect(settled).toContain('text-success');
    expect(settled).toContain('Ran 1 action');
    expect(settled).not.toContain('atlas-lattice-cell');
  });

  test('the expanded layer is hidden but still real — the crossfade has something to fade from', () => {
    const { expanded } = splitLayers(render(RESOLVED));
    expect(expanded).toContain('aria-hidden="true"');
    expect(expanded).toContain('atlas-lattice-cell');
    expect(expanded).toContain('Opened Notepad');
  });
});
