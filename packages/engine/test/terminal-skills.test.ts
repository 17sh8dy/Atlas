/**
 * terminal.open / terminal.read / terminal.list / dev.tools: fenced exactly like powershell.run, and
 * "it opened" is only ever reported after the launcher's own marker was read back.
 */
import { describe, expect, test } from 'vitest';
import type { Platform, SkillContext } from '@atlas/core';
import { createTerminalSkills } from '../src/skills/terminal-skills';

const ctx = (approvedPreview?: string) => ({ approvedPreview }) as unknown as SkillContext;
const byId = (p: Partial<Platform>, id: string) => createTerminalSkills(p as Platform).find((s) => s.id === id)!;

function fake(started: boolean) {
  const opened: { script: string; opts: unknown }[] = [];
  const platform = {
    openTerminal: async (script: string, opts: unknown) => {
      opened.push({ script, opts });
      return { id: 'term-1-0001', title: 'Atlas: test' };
    },
    readTerminal: async (id: string) => ({ id, started, running: started, exitCode: null, text: '', truncated: false }),
  } as Partial<Platform>;
  return { platform, opened };
}

describe('terminal.open', () => {
  test('shows the whole script and fingerprints it', async () => {
    const skill = byId({}, 'terminal.open');
    const p = await skill.preview!({ script: 'npm run dev', cwd: 'D:/Dev/App' }, ctx());
    expect(p).toMatchObject({ kind: 'ask' });
    expect((p as { detail: string }).detail).toContain('npm run dev');
    expect((p as { detail: string }).detail).toContain('D:/Dev/App');
  });

  test('refuses what powershell.run refuses, before a card is drawn', async () => {
    const skill = byId({}, 'terminal.open');
    for (const bad of ['Remove-Item D:/x -Recurse', 'iex (iwr http://x)', 'Start-Process cmd', 'reg add HKLM/x']) {
      expect(await skill.preview!({ script: bad }, ctx()), bad).toMatchObject({ kind: 'refuse' });
      expect(skill.guard!({ script: bad } as never, ctx()), bad).toBeTruthy();
      const { platform, opened } = fake(true);
      const r = await byId(platform, 'terminal.open').run({ script: bad }, ctx());
      expect(r.ok, bad).toBe(false);
      expect(opened, bad).toEqual([]);
    }
  });

  test('runs only the script that was approved', async () => {
    const { platform, opened } = fake(true);
    const skill = byId(platform, 'terminal.open');
    const card = (await skill.preview!({ script: 'npm test' }, ctx())) as { fingerprint: string };
    const swapped = await skill.run({ script: 'npm run build' }, ctx(card.fingerprint));
    expect(swapped.ok).toBe(false);
    expect(opened).toEqual([]);
    const same = await skill.run({ script: 'npm test' }, ctx(card.fingerprint));
    expect(same.ok).toBe(true);
    expect(opened).toHaveLength(1);
  });

  test('watch is part of what was approved', async () => {
    const { platform } = fake(true);
    const skill = byId(platform, 'terminal.open');
    const card = (await skill.preview!({ script: 'opencode', watch: false }, ctx())) as { fingerprint: string };
    expect((await skill.run({ script: 'opencode' }, ctx(card.fingerprint))).ok).toBe(false);
  });

  test('says it opened only after the launcher marker is read back', async () => {
    const { platform } = fake(true);
    expect((await byId(platform, 'terminal.open').run({ script: 'git status' }, ctx())).ok).toBe(true);
  });

  test('does not claim success when the launcher never reports', async () => {
    const { platform } = fake(false);
    const r = await byId(platform, 'terminal.open').run({ script: 'git status' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/did not see it start/);
  }, 15_000);

  test('degrades honestly with no native side', async () => {
    const r = await byId({}, 'terminal.open').run({ script: 'git status' }, ctx());
    expect(r).toMatchObject({ ok: false });
  });
});

describe('terminal.read / list / dev.tools', () => {
  test('read reports running, finished and not-started in words', async () => {
    const mk = (t: object) => ({
      listTerminals: async () => [{ id: 'term-1-0001', at: 1, started: true, running: true, exitCode: null }],
      readTerminal: async (id: string) => ({ id, started: true, running: true, exitCode: null, text: 'hello', truncated: false, ...t }),
    }) as Partial<Platform>;
    expect((await byId(mk({}), 'terminal.read').run({}, ctx())).message).toMatch(/still running[\s\S]*hello/);
    expect((await byId(mk({ running: false, exitCode: 2 }), 'terminal.read').run({}, ctx())).message).toMatch(/exit code 2/);
    expect((await byId(mk({ started: false, running: false }), 'terminal.read').run({}, ctx())).message).toMatch(/hasn't started/);
  });

  test('read with no terminals says so rather than inventing output', async () => {
    const r = await byId({ listTerminals: async () => [], readTerminal: async () => ({}) as never }, 'terminal.read').run({}, ctx());
    expect(r.ok).toBe(false);
  });

  test('dev.tools lists what was found and what was not', async () => {
    const platform = {
      probeDevTools: async () => [
        { name: 'git', found: true, version: 'git version 2.45', path: 'C:/git.exe' },
        { name: 'opencode', found: false, version: null, path: null },
      ],
    } as Partial<Platform>;
    const r = await byId(platform, 'dev.tools').run({ names: 'git, opencode' }, ctx());
    expect(r.message).toContain('✓ git — git version 2.45');
    expect(r.message).toContain('✗ opencode — not found');
  });
});

import { createProjectServerSkill, serverCommandFor } from '../src/skills/project-server-skill';

describe('project.startServer', () => {
  const info = (systems: string[], npmScripts: string[] = []) => ({ systems, npmScripts }) as never;

  test('picks the command from the project itself, in a fixed order', () => {
    expect(serverCommandFor(info(['pnpm'], ['build', 'dev', 'start']))?.command).toBe('pnpm run dev');
    expect(serverCommandFor(info(['npm'], ['start']))?.command).toBe('npm start');
    expect(serverCommandFor(info(['npm'], ['serve', 'preview']))?.command).toBe('npm run serve');
    expect(serverCommandFor(info(['cargo']))?.command).toBe('cargo run');
    expect(serverCommandFor(info(['dotnet']))?.command).toBe('dotnet run');
  });

  test('says so, and starts nothing, when the project does not say how', () => {
    expect(serverCommandFor(info(['npm'], ['build', 'lint']))).toBeNull();
    expect(serverCommandFor(info([]))).toBeNull();
  });

  test('shows the command, runs only what was approved, and opens it in a terminal', async () => {
    const opened: string[] = [];
    const platform = {
      detectProject: async () => info(['pnpm'], ['dev']),
      openTerminal: async (script: string) => { opened.push(script); return { id: 'term-1-0001', title: 'dev' }; },
    } as unknown as Platform;
    const skill = createProjectServerSkill(platform, async () => 'D:/Dev/App');
    const card = (await skill.preview!({}, ctx())) as { kind: string; detail: string; fingerprint: string };
    expect(card.kind).toBe('ask');
    expect(card.detail).toContain('pnpm run dev');
    expect((await skill.run({}, ctx('term:1:wrong'))).ok).toBe(false);
    expect(opened).toEqual([]);
    expect((await skill.run({}, ctx(card.fingerprint))).ok).toBe(true);
    expect(opened).toEqual(['pnpm run dev']);
  });

  test('asks which project when none is set', async () => {
    const skill = createProjectServerSkill({ detectProject: async () => info(['npm']) } as unknown as Platform, async () => null);
    expect(await skill.preview!({}, ctx())).toMatchObject({ kind: 'refuse' });
  });
});
