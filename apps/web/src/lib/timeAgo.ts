/**
 * "3m ago" — the only unit of time Recent Activity and the Activity settings
 * tab show, because both are read at a glance rather than audited. Coarser
 * than a real duration library on purpose: nobody needs to know an episode
 * was 47 minutes old rather than 45, and a library pulled in for that
 * precision would be pure cost for a screen that shows six rows.
 */
export function timeAgo(at: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
