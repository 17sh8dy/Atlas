/**
 * Getting Nova Intelligence running, so that switching it on is enough.
 *
 * Nova Intelligence is a Python program with a trained model, in a folder of
 * its own — the Atlas installer does not carry it. This is the one place that
 * decides what to do about that: already answering, then nothing; findable on
 * this PC, then start it; otherwise say exactly which of the two things is
 * missing, because "not running" is a different problem from "not installed".
 *
 * It only ever acts for someone who switched Nova Intelligence on. Nothing here
 * runs for a person who never did.
 */

import {
  isNovaIntelligenceReachable,
  locateNovaIntelligence,
  startNovaIntelligence,
} from '@atlas/platform';
import type { NovaSettings } from '@atlas/data';

export type EnsureResult =
  /** Already answering; nothing to do. */
  | { kind: 'up' }
  /** Started just now. The model takes a while to load — watch for it answering. */
  | { kind: 'started'; folder: string }
  /** No Nova Intelligence folder on this PC (or the web build). */
  | { kind: 'not-found' }
  /** The folder is there but the trained model is not. */
  | { kind: 'no-model'; folder: string }
  | { kind: 'error'; message: string };

export async function ensureNovaIntelligence(
  nova: Pick<NovaSettings, 'folder' | 'baseUrl'>,
): Promise<EnsureResult> {
  if (await isNovaIntelligenceReachable(nova.baseUrl)) return { kind: 'up' };

  const found = await locateNovaIntelligence(nova.folder);
  if (!found) return { kind: 'not-found' };
  if (!found.hasModel) return { kind: 'no-model', folder: found.path };

  const started = await startNovaIntelligence(found.path, nova.baseUrl);
  if (!started.ok) return { kind: 'error', message: started.error };
  return started.already ? { kind: 'up' } : { kind: 'started', folder: found.path };
}

/** What to tell the person about a result that did not end with it running. */
export function explainEnsure(result: EnsureResult): string | null {
  switch (result.kind) {
    case 'up':
    case 'started':
      return null;
    case 'not-found':
      return 'Nova Intelligence isn’t on this PC yet. It isn’t part of the Atlas download — it is a separate folder with its own Python and trained model. Choose that folder below and Atlas will start it for you.';
    case 'no-model':
      return `Found Nova Intelligence at ${result.folder}, but its trained model is missing, so there is nothing to start.`;
    case 'error':
      return result.message;
  }
}
