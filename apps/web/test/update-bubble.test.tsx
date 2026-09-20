import { describe, expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UpdateManifest, UpdateState } from '@atlas/updater';
import { UpdateBubble, describeProgress, percent } from '../src/components/UpdateBubble';
import type { Updater } from '../src/update/useUpdater';

const manifest: UpdateManifest = {
  product: 'atlas',
  version: '0.86.0',
  downloadUrl: 'https://github.com/x/y/a.exe',
  sha256: 'a'.repeat(64),
  sizeBytes: 373_000_000,
  releaseNotes: ['Faster replies', 'Fixed a crash', 'A', 'B', 'Fifth note is left out'],
  mandatory: false,
  minimumVersion: null,
  publishedAt: null,
  signature: null,
};

const noop = () => {};

function render(state: UpdateState, over: Partial<Updater> = {}) {
  const updater: Updater = {
    state,
    supported: true,
    currentVersion: '0.85.0',
    autoCheck: true,
    setAutoCheck: noop,
    checkNow: async () => 'up-to-date',
    update: noop,
    later: noop,
    cancel: noop,
    retry: noop,
    acknowledge: noop,
    ...over,
  };
  return renderToStaticMarkup(createElement(UpdateBubble, { updater }));
}

describe('UpdateBubble', () => {
  test('hidden renders nothing', () => {
    expect(render({ status: 'hidden' })).toBe('');
  });

  test('available: version, the first few notes, Update and Later', () => {
    const html = render({ status: 'available', manifest });
    expect(html).toContain('Update available');
    expect(html).toContain('0.86');
    expect(html).toContain('you have 0.85');
    expect(html).toContain('Faster replies');
    expect(html).not.toContain('Fifth note is left out');
    expect(html).toContain('>Update<');
    expect(html).toContain('>Later<');
  });

  test('a mandatory update has no Later', () => {
    const html = render({ status: 'available', manifest: { ...manifest, mandatory: true } });
    expect(html).toContain('>Update<');
    expect(html).not.toContain('>Later<');
  });

  test('downloading shows the version and real progress', () => {
    const html = render({
      status: 'downloading',
      manifest,
      received: 186_500_000,
      total: 373_000_000,
    });
    expect(html).toContain('Downloading 0.86');
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain('50%');
    expect(html).toContain('>Cancel<');
  });

  test.each([
    ['verifying', 'Verifying the download'],
    ['installing', 'Getting ready to install'],
    ['restarting', 'Restarting Atlas'],
  ] as const)('%s has its own face', (status, text) => {
    expect(render({ status, manifest } as UpdateState)).toContain(text);
  });

  test('checking, complete and failed', () => {
    expect(render({ status: 'checking' })).toContain('Checking for updates');
    expect(render({ status: 'complete', version: '0.86.0' })).toContain('Updated to 0.86');

    const failed = render({
      status: 'failed',
      stage: 'download',
      error: 'connection reset',
      manifest,
      rolledBack: false,
    });
    expect(failed).toContain('connection reset');
    expect(failed).toContain('>Try again<');
    expect(failed).toContain('>Dismiss<');
  });

  test('a rollback says so and offers no retry', () => {
    const html = render({
      status: 'failed',
      stage: 'install',
      error: 'Atlas went back to version 0.85.0.',
      manifest: null,
      rolledBack: true,
    });
    expect(html).toContain('Update rolled back');
    expect(html).not.toContain('Try again');
  });

  test('it uses the app’s glass and is not a modal', () => {
    const html = render({ status: 'available', manifest });
    expect(html).toContain('atlas-glass');
    expect(html).not.toContain('aria-modal');
  });
});

describe('progress helpers', () => {
  test('describe and percent', () => {
    expect(describeProgress(52_428_800, 104_857_600)).toBe('50 MB of 100 MB');
    expect(describeProgress(52_428_800, null)).toBe('50 MB');
    expect(percent(50, 100)).toBe(50);
    expect(percent(5, null)).toBeNull();
    expect(percent(500, 100)).toBe(100);
  });
});
