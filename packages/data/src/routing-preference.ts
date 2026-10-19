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

const UNIVERSAL_AGENT = 'agent.universal';

/**
 * The Universal Agent (experimental): Atlas working a multi-step goal out one step at a time with a model.
 *
 * OFF unless the person turned it on. The default is written down here and not inferred, because the two ways
 * of getting it wrong are not equal: an existing user upgrading has no saved value, and "no value" must mean
 * "off", never "on as it was before", because before 2.0.2 there was no such feature to be on. Only the exact
 * saved word 'true' enables it; anything else, including a corrupted value, is off.
 */
export async function readUniversalAgent(storage: Storage): Promise<boolean> {
  const fact = await new MemoryStore(storage).fact('preference', UNIVERSAL_AGENT);
  return fact?.value === 'true';
}

export async function writeUniversalAgent(storage: Storage, enabled: boolean): Promise<void> {
  await new MemoryStore(storage).remember('preference', UNIVERSAL_AGENT, enabled ? 'true' : 'false');
}

const UNIVERSAL_AGENT_WARNED = 'agent.universal.warned';

/**
 * Whether the person has already been shown the Experimental warning for the Universal Agent. It is shown once,
 * the first time they switch the agent on, and never again; only the exact saved word 'true' counts as seen, so
 * a missing or corrupted value shows the warning rather than skipping it.
 */
export async function readUniversalAgentWarned(storage: Storage): Promise<boolean> {
  const fact = await new MemoryStore(storage).fact('preference', UNIVERSAL_AGENT_WARNED);
  return fact?.value === 'true';
}

export async function writeUniversalAgentWarned(storage: Storage): Promise<void> {
  await new MemoryStore(storage).remember('preference', UNIVERSAL_AGENT_WARNED, 'true');
}
