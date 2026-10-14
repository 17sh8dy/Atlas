/**
 * Routing choices — which kinds of request a *cloud* model may be asked to handle.
 *
 * One today: `cloudPlanning`. Atlas's own planner handles what it understands; when it does not,
 * the connected model is asked to turn the instruction into a plan. For a local model that stays on
 * this PC. For a cloud model it is a request to a provider, carrying the person's words and the
 * names of the tools Atlas has. Some people want a cloud model for conversation and nothing else,
 * so it is theirs to switch off.
 *
 * Default on, which is exactly how Atlas behaved before this existed. Turning it off can only make
 * Atlas ask a model less: it never chooses a different provider and never widens what a plan may do.
 */

import type { Storage } from '@atlas/core';
import { MemoryStore } from './memory-store';

const CLOUD_PLANNING = 'routing.cloudPlanning';

export async function readCloudPlanning(storage: Storage): Promise<boolean> {
  const fact = await new MemoryStore(storage).fact('preference', CLOUD_PLANNING);
  return fact?.value !== 'false';
}

export async function writeCloudPlanning(storage: Storage, allowed: boolean): Promise<void> {
  await new MemoryStore(storage).remember('preference', CLOUD_PLANNING, allowed ? 'true' : 'false');
}
