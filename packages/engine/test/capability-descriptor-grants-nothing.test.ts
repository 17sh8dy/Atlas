/**
 * A provider's capability descriptor describes a model. It must never decide what Atlas may do.
 *
 * Read from the source, not from behaviour: a unit test of the executor would pass while a
 * branch on "this model supports tool calling" sat in the code waiting to loosen a check.
 */
import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..', 'src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** Every identifier a branch on a model's abilities would have to use. */
const DESCRIPTOR_USE =
  /\b(?:canConverse|capabilitiesFromOllama|refreshCapabilities|ModelCapabilities|UNKNOWN_CAPABILITIES|NOVA_INTELLIGENCE_CAPABILITIES|CLOUD_DECLARED_CAPABILITIES)\b|\bsupports\(\s*[\w.?!]+\s*,\s*['"]|\.toolCalling\b|\.structuredOutput\b|\.capabilities\?\.\(\)/;

/** The only places in the engine allowed to read a descriptor, and why. */
const ALLOWED: Record<string, string> = {
  'engine.ts': 'chooses who writes ordinary conversation; reads `canConverse` and nothing else',
};

describe('the capability descriptor grants nothing', () => {
  const files = sources(SRC).map((p) => ({ rel: relative(SRC, p).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') }));

  test('only the conversation router reads it, and only for conversation', () => {
    const users = files.filter((f) => DESCRIPTOR_USE.test(f.text)).map((f) => f.rel);
    expect(users).toEqual(Object.keys(ALLOWED));
  });

  test('the engine reads `canConverse` and no feature that would change what is asked or run', () => {
    const engine = files.find((f) => f.rel === 'engine.ts')!.text;
    expect(engine).toMatch(/canConverse\(/);
    expect(engine).not.toMatch(/supports\(/);
    expect(engine).not.toMatch(/toolCalling|structuredOutput/);
  });

  test('the executor, the registry, risk, policy and every skill are ignorant of it', () => {
    for (const f of files) {
      if (f.rel === 'engine.ts') continue;
      expect(f.text, f.rel).not.toMatch(DESCRIPTOR_USE);
    }
  });

  test('no provider module can reach the executor or the registry', () => {
    // The descriptor is built in packages/platform; engine code never imports it, and it never
    // imports the engine. Checked from this side: the engine has no platform provider import.
    for (const f of files) expect(f.text, f.rel).not.toMatch(/from ['"]@atlas\/platform['"]/);
  });
});
