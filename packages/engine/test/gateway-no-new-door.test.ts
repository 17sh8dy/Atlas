/**
 * The gateway is a reader and a writer of requests, never a way to act.
 *
 * It gets a read-only view of the catalog (`GatewayCatalog`) and a provider, and returns validated
 * steps. It must not import the executor, run a skill, touch the platform, storage or the web
 * layer, or know about execution modes, risk or confirmation. Checked from the source, so a future
 * convenience import goes red instead of becoming a second path to the machine.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const DIR = fileURLToPath(new URL('../src/gateway/', import.meta.url));
const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ name: f, text: readFileSync(join(DIR, f), 'utf8') }));

function imports(text: string): string[] {
  return [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
}

describe('the model gateway has no way to act', () => {
  test('it exists and has files to check', () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  test('it imports only types from core, the router and the tool-call reader', () => {
    const allowed = [/^@atlas\/core$/, /^\.\/(route|tools|plan)$/, /^\.\.\/skills\/router$/, /^\.\.\/agent\/tool-call$/];
    for (const f of files) {
      for (const spec of imports(f.text)) {
        expect(allowed.some((r) => r.test(spec)), `${f.name} imports ${spec}`).toBe(true);
      }
    }
  });

  test('it never names the executor, the registry class, the platform, storage or the web layer', () => {
    for (const f of files) {
      const code = f.text
        .split('\n')
        .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
        .join('\n');
      expect(code, f.name).not.toMatch(/\bExecutor\b|\bSkillRegistry\b|\bplanner\/executor\b|@atlas\/platform|@atlas\/data|Storage\b|\.run\(|fetch\(|invoke\(/);
    }
  });

  test('it holds no execution state: mode, risk, policy and confirmation are not its business', () => {
    for (const f of files) {
      const code = f.text
        .split('\n')
        .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
        .join('\n');
      expect(code, f.name).not.toMatch(/executionMode|ExecutionMode|riskFor|\.risk\b|confirm\(|approvedStep|content ?policy/i);
    }
  });
});
