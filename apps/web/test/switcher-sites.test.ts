import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../src/components/NovaSwitcher.tsx', import.meta.url)), 'utf8');

describe('the Nova product switcher lists the Replay.GG website', () => {
  test('as a real website with a real address', () => {
    expect(source).toContain("id: 'replay-gg-site'");
    expect(source).toContain("label: 'Replay.GG Website'");
    expect(source).toContain("url: 'https://replay-gg-site.shadylabs.workers.dev/'");
  });

  test('once, and still lists the Atlas website and Nova.Review', () => {
    expect(source.match(/id: 'replay-gg-site'/g)).toHaveLength(1);
    expect(source).toContain("id: 'atlas-site'");
    expect(source).toContain("id: 'nova-review'");
  });
});
