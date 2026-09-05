/**
 * Which execution mode Atlas is in — see `@atlas/core`'s `execution-mode.ts`
 * for what the modes mean.
 *
 * Same `MemoryStore`-backed `Fact` pattern as `preferences.ts` and
 * `speech-preferences.ts`: one subject, one place settings live.
 *
 * Read defensively, like every preference in this package: a hand-edited or
 * stale value degrades to the default rather than reaching the executor with
 * something that isn't a real mode.
 */

import type { Storage } from '@atlas/core';
import { DEFAULT_EXECUTION_MODE, isExecutionMode, type ExecutionMode } from '@atlas/core';
import { MemoryStore } from './memory-store';

const MODE = 'execution.mode';

export async function readExecutionMode(storage: Storage): Promise<ExecutionMode> {
  const fact = await new MemoryStore(storage).fact('preference', MODE);
  return isExecutionMode(fact?.value) ? fact.value : DEFAULT_EXECUTION_MODE;
}

export async function writeExecutionMode(storage: Storage, mode: ExecutionMode): Promise<void> {
  await new MemoryStore(storage).remember('preference', MODE, mode);
}
