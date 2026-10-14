/**
 * Words for the SearXNG setting — kept out of the component so they can be tested.
 */

import type { SearxngReach, SearxngTestReport } from '@atlas/core';

/** The native side prefixes this when an address is on the local network and not yet confirmed. */
export const PRIVATE_PREFIX = 'private-network:';

export interface SetupError {
  message: string;
  /** Show the "this is my own server" confirmation. */
  needsPrivateConfirmation: boolean;
}

/** Turn whatever `searxngConfigure` rejected with into something to show. */
export function describeSetupError(error: unknown): SetupError {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const text = raw.trim();
  if (text.toLowerCase().startsWith(PRIVATE_PREFIX)) {
    return { message: text.slice(PRIVATE_PREFIX.length).trim(), needsPrivateConfirmation: true };
  }
  return {
    message: text || 'That address could not be saved.',
    needsPrivateConfirmation: false,
  };
}

export function describeReach(reach: SearxngReach | null): string {
  switch (reach) {
    case 'this-machine':
      return 'on this PC';
    case 'private-network':
      return 'on your own network';
    case 'internet':
      return 'on the internet, over https';
    default:
      return '';
  }
}

export type Tone = 'good' | 'bad' | 'neutral';

/** A test result as a tone and a sentence. The sentence already says what to do. */
export function describeTest(report: SearxngTestReport): { tone: Tone; message: string } {
  if (report.ok) return { tone: report.resultCount > 0 ? 'good' : 'neutral', message: report.message };
  switch (report.status) {
    case 'json-off-or-misconfigured':
    case 'invalid':
    case 'login-required':
    case 'blocked':
      return { tone: 'bad', message: report.message };
    default:
      // Unreachable, rate-limited, not set up: a state, not a mistake.
      return { tone: 'neutral', message: report.message };
  }
}
