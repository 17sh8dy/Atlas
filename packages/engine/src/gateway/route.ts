/**
 * Which way to ask a model for a plan.
 *
 * Deterministic and cheap, decided from what is *known* about the model (`ModelCapabilities`) and
 * nothing else. Three routes, best first:
 *
 *   tools  — the model is offered a short list of tools and proposes calls (provider-native).
 *   schema — the model is held to a JSON Schema for a whole plan (server-enforced where offered).
 *   text   — the plain path every model can follow: a catalog in the prompt, JSON out.
 *
 * Unknown is not "yes" (see `provider-capabilities.ts`): a feature is used only when it is
 * positively known to be there, and a model nobody has described gets `text`. The route changes
 * how a plan is asked for and read, never what it may contain: every route ends in the same
 * validation, the same executor and the same confirmation cards. The person's privacy choices are
 * not an input here because none of the routes sends anything the text route would not (the same
 * request and the same skill descriptions, never memory, files or system details).
 */

import type { ModelCapabilities } from '@atlas/core';
import { supports } from '@atlas/core';

export type Route = 'tools' | 'schema' | 'text';

export function chooseRoute(caps: ModelCapabilities | null | undefined): Route {
  if (supports(caps, 'toolCalling')) return 'tools';
  if (supports(caps, 'structuredOutput')) return 'schema';
  return 'text';
}

/** One step down, after a model or server refused the constraint. `null` when there is no lower. */
export function downgrade(route: Route): Route | null {
  if (route === 'tools') return 'schema';
  if (route === 'schema') return 'text';
  return null;
}
