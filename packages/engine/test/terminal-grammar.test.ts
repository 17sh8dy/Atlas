/**
 * "open opencode", "open claude code in powershell", "type opencode in the PowerShell window":
 * understood with no model, routed to the fenced terminal skill, and never wider than that.
 */
import { describe, expect, test } from 'vitest';
import { Grammar } from '../src/planner/grammar';
import { createCoreGrammar } from '../src/planner/core-grammar';
import { createExtraGrammar } from '../src/planner/extra-grammar';
import { parseTerminalRequest, parseToolCheck } from '../src/planner/terminal-grammar';
import { WorkingMemory } from '../src/working-memory';
import { understand } from './helpers/chain';

const g = new Grammar();
g.addMany(createCoreGrammar(new WorkingMemory()));
g.addMany(createExtraGrammar());
const first = (t: string) => understand(g, t).plan?.steps[0];

describe('opening a terminal', () => {
  test('the assistants people actually ask for', () => {
    for (const t of ['open opencode', 'launch opencode', 'start claude code', 'open claude code in powershell', 'type opencode in the PowerShell window', 'can you open opencode for me?']) {
      const s = first(t);
      expect(s?.skill, t).toBe('terminal.open');
      expect(String(s?.args.script), t).toMatch(/^(opencode|claude)$/);
      expect(s?.args.watch, t).toBe(false);
    }
  });

  test('any command, when the person says where', () => {
    expect(first('run npm test in a terminal')?.args).toMatchObject({ script: 'npm test', watch: true });
    expect(first('open a terminal and run cargo build')?.args).toMatchObject({ script: 'cargo build' });
    expect(first('in powershell, run git status')?.args).toMatchObject({ script: 'git status' });
  });

  test('does not take over plain "open X"', () => {
    for (const t of ['open steam', 'open notepad', 'open claude', 'start the music', 'run the tests']) {
      expect(first(t)?.skill, t).not.toBe('terminal.open');
    }
  });

  test('claims nothing that is not a plain command line', () => {
    for (const t of ['run $(calc) in powershell', 'run npm test; calc in a terminal', 'run a | b in a terminal']) {
      expect(parseTerminalRequest(t), t).toBeNull();
    }
  });

  test('the existing run-powershell rule still wins for scripts', () => {
    expect(first('run powershell: Get-ChildItem D:/Dev')?.skill).toBe('powershell.run');
  });
});

describe('checking tools', () => {
  test('is X installed', () => {
    expect(first('is git installed')).toMatchObject({ skill: 'dev.tools', args: { names: 'git' } });
    expect(first('do I have node?')).toMatchObject({ skill: 'dev.tools', args: { names: 'node' } });
    expect(first('is opencode installed')).toMatchObject({ skill: 'dev.tools', args: { names: 'opencode' } });
    expect(first('which dev tools do I have')).toMatchObject({ skill: 'dev.tools' });
  });

  test('only names it knows', () => {
    expect(parseToolCheck('is sandwich installed')).toBeNull();
    expect(parseToolCheck('do I have a dog')).toBeNull();
  });

  test('unreal and friends still go to the engine list', () => {
    expect(first('is unreal installed')?.skill).toBe('engine.list');
  });
});

describe('reading a terminal', () => {
  test('phrasings', () => {
    expect(first('what did the terminal print')?.skill).toBe('terminal.read');
    expect(first('is the terminal still running')?.skill).toBe('terminal.read');
    expect(first('list my terminals')?.skill).toBe('terminal.list');
  });
});
