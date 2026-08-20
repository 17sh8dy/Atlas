/**
 * Time-zone names, shared by every skill that has to turn a place into a zone.
 *
 * Kept in its own module rather than in the skill that first needed it: the
 * "what time is it in Tokyo" skill and the "time difference between London and
 * Tokyo" skill must agree about what a city is called, and two copies of a
 * lookup table are two chances to disagree.
 */

/**
 * City names people actually type, mapped to IANA zones. Anything not listed
 * still works if the user gives a real zone ("Asia/Kolkata") — the lookup
 * falls through to `Intl`, which is the actual authority here.
 */
export const ZONE_ALIASES: Record<string, string> = {
  utc: 'UTC',
  gmt: 'UTC',
  london: 'Europe/London',
  paris: 'Europe/Paris',
  berlin: 'Europe/Berlin',
  madrid: 'Europe/Madrid',
  rome: 'Europe/Rome',
  amsterdam: 'Europe/Amsterdam',
  moscow: 'Europe/Moscow',
  dublin: 'Europe/Dublin',
  lisbon: 'Europe/Lisbon',
  'new york': 'America/New_York',
  nyc: 'America/New_York',
  chicago: 'America/Chicago',
  denver: 'America/Denver',
  'los angeles': 'America/Los_Angeles',
  la: 'America/Los_Angeles',
  seattle: 'America/Los_Angeles',
  vancouver: 'America/Vancouver',
  toronto: 'America/Toronto',
  'mexico city': 'America/Mexico_City',
  'sao paulo': 'America/Sao_Paulo',
  tokyo: 'Asia/Tokyo',
  japan: 'Asia/Tokyo',
  seoul: 'Asia/Seoul',
  beijing: 'Asia/Shanghai',
  shanghai: 'Asia/Shanghai',
  'hong kong': 'Asia/Hong_Kong',
  singapore: 'Asia/Singapore',
  dubai: 'Asia/Dubai',
  mumbai: 'Asia/Kolkata',
  delhi: 'Asia/Kolkata',
  india: 'Asia/Kolkata',
  bangkok: 'Asia/Bangkok',
  sydney: 'Australia/Sydney',
  melbourne: 'Australia/Melbourne',
  auckland: 'Pacific/Auckland',
  honolulu: 'Pacific/Honolulu',
  cairo: 'Africa/Cairo',
  lagos: 'Africa/Lagos',
  johannesburg: 'Africa/Johannesburg',
};

export function resolveZone(place: string): string | null {
  const key = place.trim().toLowerCase().replace(/\s+/g, ' ');
  const zone = ZONE_ALIASES[key] ?? (key.includes('/') ? place.trim() : null);
  if (!zone) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}
