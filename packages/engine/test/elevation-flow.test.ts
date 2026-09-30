/**
 * Administrator approval, as the person meets it.
 *
 * The native ledger (single use, expiry, replay, modified requests, the stop) is
 * tested where it lives, in `elevation.rs`. What is tested here is everything on
 * this side of the boundary: that Atlas asks *before* Windows does, says exactly
 * what will run, asks in every execution mode, never runs after a No or a stop,
 * and hands the native side only the token and the command line it showed.
 */

import { assert, test } from 'vitest';
import {
  HaltController,
  NEEDS_ELEVATION,
  type ExecutionMode,
  type ElevationOperation,
  type ElevationRequest,
  type Plan,
  type Platform,
  type ServiceEntry,
  type SkillContext,
} from '@atlas/core';
import { Executor } from '../src/planner/executor';
import { SkillRegistry } from '../src/skills/registry';
import { createServiceSkills } from '../src/skills/service-skills';
import { createEnvironmentSkills } from '../src/skills/environment-skills';
import { elevationCard } from '../src/skills/elevation-flow';

const SPOOLER: ServiceEntry = {
  name: 'Spooler',
  display: 'Print Spooler',
  state: 'RUNNING',
  running: true,
  protected: false,
};

interface Machine {
  platform: Platform;
  prepared: ElevationOperation[];
  ran: Array<{ token: string; commandLine: string }>;
  cancelled: string[];
  controlCalls: string[];
  state: { running: boolean; envValue?: string };
}

function machine(
  opts: { exitCode?: number; timedOut?: boolean; prepareError?: string } = {},
): Machine {
  const m: Machine = {
    platform: undefined as unknown as Platform,
    prepared: [],
    ran: [],
    cancelled: [],
    controlCalls: [],
    state: { running: true },
  };
  let n = 0;
  m.platform = {
    capabilities: async () => ['services', 'environment'],
    listServices: async () => [
      { ...SPOOLER, running: m.state.running, state: m.state.running ? 'RUNNING' : 'STOPPED' },
    ],
    serviceDetail: async () => ({
      ...SPOOLER,
      running: m.state.running,
      state: m.state.running ? 'RUNNING' : 'STOPPED',
    }),
    // Without administrator rights, changing a service is refused; once the
    // approved elevated run has happened, it is already done.
    serviceControl: async (_name: string, action: string) => {
      m.controlCalls.push(action);
      const stopped = m.prepared.some((p) => p.kind === 'serviceStop');
      const started = m.prepared.some((p) => p.kind === 'serviceStart');
      const isDone =
        action === 'restart' ? stopped && started : m.state.running === (action === 'start');
      if (isDone) {
        return {
          name: 'Spooler',
          display: 'Print Spooler',
          state: m.state.running ? 'RUNNING' : 'STOPPED',
          running: m.state.running,
          note: 'It was already that way.',
        };
      }
      throw NEEDS_ELEVATION;
    },
    listEnvironmentVariables: async () =>
      m.state.envValue === undefined
        ? []
        : [{ name: 'MY_TOOL_HOME', value: m.state.envValue, scope: 'system' }],
    setEnvironmentVariable: async () => {
      throw NEEDS_ELEVATION;
    },
    deleteEnvironmentVariable: async () => {
      throw NEEDS_ELEVATION;
    },
    elevationPrepare: async (op: ElevationOperation): Promise<ElevationRequest> => {
      if (opts.prepareError) throw opts.prepareError;
      m.prepared.push(op);
      n += 1;
      const isService = op.kind === 'serviceStart' || op.kind === 'serviceStop';
      return {
        token: `token-${n}`,
        operation:
          op.kind === 'serviceStop'
            ? 'Stop the Windows service “Print Spooler”'
            : op.kind === 'serviceStart'
              ? 'Start the Windows service “Print Spooler”'
              : op.kind === 'envSet'
                ? `Set the system environment variable ${op.name} to “${op.value}” for every account`
                : `Remove the system environment variable ${op.name} for every account`,
        program: isService ? 'sc.exe' : 'reg.exe',
        programPath: isService ? 'C:\\Windows\\System32\\sc.exe' : 'C:\\Windows\\System32\\reg.exe',
        commandLine:
          op.kind === 'serviceStop'
            ? 'stop "Spooler"'
            : op.kind === 'serviceStart'
              ? 'start "Spooler"'
              : op.kind === 'envSet'
                ? `add "HKLM\\...\\Environment" /v "${op.name}" /t REG_SZ /d "${op.value}" /f`
                : `delete "HKLM\\...\\Environment" /v "${op.name}" /f`,
        reason: isService
          ? 'Changing a Windows service needs administrator rights.'
          : 'System-wide settings need administrator rights to change.',
        ttlSecs: 60,
        programId: 'a1b2c3d4e5f6',
      };
    },
    elevationRun: async (token: string, commandLine: string) => {
      m.ran.push({ token, commandLine });
      const last = m.prepared[m.prepared.length - 1]!;
      if (last.kind === 'serviceStop') m.state.running = false;
      if (last.kind === 'serviceStart') m.state.running = true;
      if (last.kind === 'envSet') m.state.envValue = last.value;
      if (last.kind === 'envDelete') m.state.envValue = undefined;
      return { exitCode: opts.exitCode ?? 0, timedOut: opts.timedOut ?? false };
    },
    elevationCancel: async (token: string) => {
      m.cancelled.push(token);
      return true;
    },
  } as unknown as Platform;
  return m;
}

interface Card {
  q: string;
  d?: string;
  yes?: string;
  no?: string;
}

async function run(
  m: Machine,
  steps: Plan['steps'],
  opts: {
    mode?: ExecutionMode;
    answers?: boolean[];
    halt?: HaltController;
    onCard?: (card: Card, index: number) => void;
    isPreapproved?: () => Promise<boolean>;
  } = {},
) {
  const registry = new SkillRegistry({ capabilities: () => ['services', 'environment'] });
  registry.registerMany([
    ...createServiceSkills(m.platform),
    ...createEnvironmentSkills(m.platform),
  ]);
  const cards: Card[] = [];
  const ctx: SkillContext = {
    signal: opts.halt?.signal,
    say: () => {},
    showResults: () => {},
    confirm: async (q, d, options) => {
      cards.push({ q, d, yes: options?.yesLabel, no: options?.noLabel });
      opts.onCard?.(cards[cards.length - 1]!, cards.length - 1);
      const answers = opts.answers ?? [true];
      return answers[Math.min(cards.length - 1, answers.length - 1)]!;
    },
  };
  const plan: Plan = { source: 'grammar', intent: 't', confidence: 1, steps };
  const outcome = await new Executor(registry).run(plan, ctx, {
    mode: opts.mode ?? 'doIt',
    isPreapproved: opts.isPreapproved,
    signal: opts.halt?.signal,
  });
  return { outcome, cards };
}

const STOP: Plan['steps'] = [{ skill: 'service.stop', args: { name: 'spooler' } }];
const MODES: ExecutionMode[] = ['doIt', 'planFirst', 'confirmActions'];

// ---- the card ---------------------------------------------------------------------

test('the card names the operation, the fixed program, the exact arguments, the reason and the Windows prompt', async () => {
  const m = machine();
  const { cards } = await run(m, STOP);
  const card = cards.find((c) => /administrator/i.test(c.q))!;
  assert.ok(card, 'an administrator card was shown');
  const text = `${card.q}\n${card.d}`;
  assert.match(text, /Stop the Windows service “Print Spooler”/, 'the operation');
  assert.match(text, /sc\.exe/, 'the fixed program');
  assert.match(text, /C:\\Windows\\System32\\sc\.exe/, 'where it is');
  assert.match(text, /Runs exactly: sc\.exe stop "Spooler"/, 'the exact arguments');
  assert.match(text, /Why: Changing a Windows service needs administrator rights/, 'the reason');
  assert.match(
    text,
    /Windows will show its own permission prompt \(UAC\)/,
    'that Windows asks next',
  );
  assert.match(text, /can’t see, click or answer it/, 'that Atlas does not answer it');
  assert.match(text, /once, within 60 seconds/, 'the scope');
  assert.match(text, /does not give Atlas administrator rights/);
  assert.equal(card.yes, 'Allow');
  assert.equal(card.no, 'Deny');
});

test('the card is a pure function of the request — nothing on it is invented', () => {
  const request: ElevationRequest = {
    token: 'secret-token',
    operation: 'Do a thing',
    program: 'reg.exe',
    programPath: 'C:\\Windows\\System32\\reg.exe',
    commandLine: 'add "x"',
    reason: 'Because.',
    ttlSecs: 60,
    programId: 'ffee',
  };
  const card = elevationCard(request);
  assert.notInclude(`${card.question}${card.detail}`, 'secret-token', 'the token is never shown');
  assert.include(card.detail, 'reg.exe add "x"');
});

// ---- allow, deny -------------------------------------------------------------------

test('Allow: only the token and the exact command line that was shown are handed over', async () => {
  const m = machine();
  const { outcome } = await run(m, STOP);
  assert.deepEqual(m.prepared, [{ kind: 'serviceStop', name: 'Spooler' }]);
  assert.deepEqual(m.ran, [{ token: 'token-1', commandLine: 'stop "Spooler"' }]);
  assert.isTrue(outcome.ok);
  assert.match(outcome.outcomes[0]!.message ?? '', /Print Spooler is stopped/);
});

test('Deny: nothing runs, the approval is cancelled, and it reads as declined', async () => {
  const m = machine();
  // Yes to the ordinary confirmation, No to the administrator card.
  const { outcome } = await run(m, STOP, { answers: [true, false] });
  assert.deepEqual(m.ran, []);
  assert.deepEqual(m.cancelled, ['token-1']);
  assert.isFalse(outcome.ok);
  assert.equal(outcome.outcomes[0]!.error, 'Cancelled.');
  assert.isTrue(m.state.running, 'the service was left alone');
});

test('the person is asked before Windows is: the card comes first, and prepare never runs anything', async () => {
  const m = machine();
  await run(m, STOP, {
    onCard: (card) => {
      if (/administrator/i.test(card.q)) {
        assert.deepEqual(m.ran, [], 'nothing has run while the card is up');
        assert.equal(m.prepared.length, 1, 'but the approval exists');
      }
    },
  });
  assert.equal(m.ran.length, 1);
});

test('a request the native side refuses shows no card and runs nothing', async () => {
  const m = machine({ prepareError: 'I won’t change Path with administrator rights.' });
  const { outcome, cards } = await run(m, [
    { skill: 'environment.setSystem', args: { name: 'Path', value: 'x' } },
  ]);
  assert.isFalse(outcome.ok);
  assert.match(outcome.outcomes[0]!.error ?? '', /won’t change Path/);
  assert.deepEqual(m.ran, []);
  assert.isFalse(cards.some((c) => /administrator/i.test(c.q)));
});

test('a build with no elevation support says so and does nothing', async () => {
  const m = machine();
  delete (m.platform as { elevationPrepare?: unknown }).elevationPrepare;
  const { outcome } = await run(m, STOP);
  assert.isFalse(outcome.ok);
  assert.match(outcome.outcomes[0]!.error ?? '', /aren’t available in this build/);
});

test('an ordinary failure is not mistaken for a request for administrator rights', async () => {
  const m = machine();
  (m.platform as { serviceControl: unknown }).serviceControl = async () => {
    throw 'Windows refused: the service did not respond';
  };
  const { outcome, cards } = await run(m, STOP);
  assert.isFalse(outcome.ok);
  assert.deepEqual(m.prepared, []);
  assert.isFalse(cards.some((c) => /administrator/i.test(c.q)));
});

// ---- what happens after Windows ran it ---------------------------------------------------

test('a non-zero exit code is reported, not rounded up to success', async () => {
  const m = machine({ exitCode: 5 });
  const { outcome } = await run(m, STOP);
  assert.isFalse(outcome.ok);
  assert.match(outcome.outcomes[0]!.error ?? '', /reported an error \(code 5\)/);
});

test('a run that timed out says it cannot tell', async () => {
  const m = machine({ timedOut: true });
  const { outcome } = await run(m, STOP);
  assert.isFalse(outcome.ok);
  assert.match(outcome.outcomes[0]!.error ?? '', /can’t say whether it worked/);
});

test('setting a system variable is checked by reading it back', async () => {
  const m = machine();
  const { outcome } = await run(m, [
    { skill: 'environment.setSystem', args: { name: 'MY_TOOL_HOME', value: 'D:\\Tools' } },
  ]);
  assert.isTrue(outcome.ok);
  assert.match(outcome.outcomes[0]!.message ?? '', /verified: Windows now lists it/);
});

test('if Windows finished but the value is not what was set, it is not called done', async () => {
  const m = machine();
  const original = m.platform.elevationRun!;
  m.platform.elevationRun = async (t, c) => {
    const r = await original(t, c);
    m.state.envValue = 'something else';
    return r;
  };
  const { outcome } = await run(m, [
    { skill: 'environment.setSystem', args: { name: 'MY_TOOL_HOME', value: 'D:\\Tools' } },
  ]);
  assert.isFalse(outcome.ok);
  assert.match(outcome.outcomes[0]!.error ?? '', /reads “something else”/);
});

test('removing a system variable is checked by reading the list again', async () => {
  const m = machine();
  m.state.envValue = 'D:\\Tools';
  const { outcome } = await run(m, [
    { skill: 'environment.deleteSystem', args: { name: 'MY_TOOL_HOME' } },
  ]);
  assert.isTrue(outcome.ok);
  assert.match(outcome.outcomes[0]!.message ?? '', /verified: it is no longer listed/);
});

test('a restart of a running service is two separate approvals: stop, then start', async () => {
  const m = machine();
  const { cards, outcome } = await run(m, [
    { skill: 'service.restart', args: { name: 'spooler' } },
  ]);
  assert.deepEqual(
    m.prepared.map((p) => p.kind),
    ['serviceStop', 'serviceStart'],
  );
  assert.equal(cards.filter((c) => /administrator/i.test(c.q)).length, 2);
  assert.equal(m.ran.length, 2);
  assert.isTrue(outcome.ok);
});

// ---- every safety mode ------------------------------------------------------------------

test('the administrator card is asked in all three execution modes', async () => {
  for (const mode of MODES) {
    const m = machine();
    const { cards } = await run(m, STOP, { mode });
    assert.equal(cards.filter((c) => /administrator/i.test(c.q)).length, 1, mode);
    assert.equal(m.ran.length, 1, mode);
  }
});

test('Do It?: an Allowed-Folder style pre-approval does not stand in for it', async () => {
  const m = machine();
  const { cards } = await run(m, STOP, { mode: 'doIt', isPreapproved: async () => true });
  assert.equal(cards.filter((c) => /administrator/i.test(c.q)).length, 1);
});

test('Plan First: approving the plan is not approving administrator rights', async () => {
  const m = machine();
  const { cards } = await run(m, STOP, { mode: 'planFirst' });
  // One card for the plan, then the administrator card of its own.
  assert.equal(cards.length, 2);
  assert.match(cards[0]!.q, /.*/);
  assert.match(cards[1]!.q, /administrator/i);
});

test('Confirm Actions: the ordinary confirmation and the administrator card are separate questions', async () => {
  const m = machine();
  const { cards } = await run(m, STOP, { mode: 'confirmActions' });
  assert.equal(cards.length, 2);
  assert.notMatch(cards[0]!.q, /administrator/i);
  assert.match(cards[1]!.q, /administrator/i);
});

test('saying No in any mode leaves nothing running', async () => {
  for (const mode of MODES) {
    const m = machine();
    const answers = mode === 'planFirst' ? [true, false] : [true, false];
    await run(m, STOP, { mode, answers });
    assert.deepEqual(m.ran, [], mode);
    assert.isTrue(m.state.running, mode);
  }
});

// ---- the emergency stop -------------------------------------------------------------------

test('a stop pressed while the card is open: the approval is cancelled and nothing runs', async () => {
  const m = machine();
  const halt = new HaltController();
  const { outcome } = await run(m, STOP, {
    halt,
    onCard: (card) => {
      if (/administrator/i.test(card.q)) halt.abort(); // F8 while the card is showing
    },
  });
  assert.deepEqual(m.ran, [], 'elevationRun was never called');
  assert.isFalse(outcome.ok);
});

test('a stop before anything starts prevents even asking', async () => {
  const m = machine();
  const halt = new HaltController();
  halt.abort();
  const { cards } = await run(m, STOP, { halt });
  assert.deepEqual(cards, []);
  assert.deepEqual(m.prepared, []);
  assert.deepEqual(m.ran, []);
});

// ---- not from a watch --------------------------------------------------------------------------

test('administrator actions are barred from watch continuations', async () => {
  const src = (await import('node:fs')).readFileSync(
    new URL('../src/skills/watch-skills.ts', import.meta.url),
    'utf8',
  );
  for (const id of [
    'service.start',
    'service.stop',
    'service.restart',
    'environment.setSystem',
    'environment.deleteSystem',
  ]) {
    assert.include(src, `'${id}'`, id);
  }
});
