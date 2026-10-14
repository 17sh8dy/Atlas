/**
 * What to say when a cloud model will not answer because of money.
 *
 * The native side (`cloud_safety.rs`) recognises the situation and refuses; this turns its tagged
 * reasons into plain wording. It never decides anything: nothing here chooses another provider,
 * switches models, retries elsewhere or changes a setting. Spending money somewhere else is always
 * the person's decision, so the only thing this module can do is *tell them*.
 *
 * Tags (see `cloud_safety.rs`):
 *   limit-reached:provider                 — the provider says the account is out of money or quota
 *   limit-reached:atlas-requests:<cap>     — the monthly request cap the person set in Atlas
 *   limit-reached:atlas-tokens:<cap>       — the monthly token cap the person set in Atlas
 *   limit-reached:burst:<n>                — more than <n> requests in a minute: probably a loop
 *   rate-limited:<message>                 — too many requests for the moment; nothing is paused
 */

export type ProviderFailure =
  | { kind: 'provider-limit' }
  | { kind: 'atlas-requests'; cap: number }
  | { kind: 'atlas-tokens'; cap: number }
  | { kind: 'burst'; perMinute: number }
  | { kind: 'rate-limited' };

export function parseProviderFailure(reason: string): ProviderFailure | null {
  const r = reason.trim();
  if (r === 'limit-reached:provider') return { kind: 'provider-limit' };
  let m = /^limit-reached:atlas-requests:(\d+)$/.exec(r);
  if (m) return { kind: 'atlas-requests', cap: Number(m[1]) };
  m = /^limit-reached:atlas-tokens:(\d+)$/.exec(r);
  if (m) return { kind: 'atlas-tokens', cap: Number(m[1]) };
  m = /^limit-reached:burst:(\d+)$/.exec(r);
  if (m) return { kind: 'burst', perMinute: Number(m[1]) };
  if (r.startsWith('rate-limited:')) return { kind: 'rate-limited' };
  return null;
}

const COULD = 'You can switch to a local model or manage your limits through your provider.';

/** The words shown for a failure, or `null` when the reason is not one of these. */
export function describeProviderFailure(reason: string, providerLabel: string): string | null {
  const f = parseProviderFailure(reason);
  if (!f) return null;
  const name = providerLabel.trim() || 'cloud provider';
  switch (f.kind) {
    case 'provider-limit':
      return [
        '⚠️ Cloud AI Limit Reached',
        `Your ${name} account has reached its spending limit.`,
        'Atlas has paused requests to this provider.',
        COULD,
      ].join('\n');
    case 'atlas-requests':
      return [
        '⚠️ Cloud AI Limit Reached',
        `You set a limit of ${f.cap.toLocaleString('en-US')} requests a month for ${name}, and this month's are used.`,
        'Atlas has paused requests to this provider until next month, or until you change the limit in Settings → Intelligence.',
        'You can switch to a local model.',
      ].join('\n');
    case 'atlas-tokens':
      return [
        '⚠️ Cloud AI Limit Reached',
        `You set a limit of about ${f.cap.toLocaleString('en-US')} tokens a month for ${name}, and this month's are used.`,
        'Atlas has paused requests to this provider until next month, or until you change the limit in Settings → Intelligence.',
        'You can switch to a local model.',
      ].join('\n');
    case 'burst':
      return [
        '⚠️ Atlas Paused A Cloud Provider',
        `More than ${f.perMinute} requests went to ${name} in a minute, which looks like a loop rather than a conversation.`,
        'Atlas has stopped sending requests to it for a few minutes. Nothing was switched to another provider.',
      ].join('\n');
    case 'rate-limited':
      return `⏳ ${name} is rate limiting requests right now. Give it a moment and ask again. Atlas has not paused it.`;
  }
}
