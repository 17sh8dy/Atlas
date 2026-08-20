/**
 * Well-known websites, so "open youtube" opens YouTube.
 *
 * ── Why this table exists at all ────────────────────────────────────────────
 * `app.open` used to end at the installed-app list. Ask for something that is
 * a site rather than a program and it had two answers, both wrong: a "did you
 * mean" list of unrelated installed apps, or `https://youtube` — a bare name
 * with no TLD, which resolves to nothing.
 *
 * ── Why it is short, and why that is fine ───────────────────────────────────
 * This is not a directory of the web and must never become one. It only needs
 * the handful of names people say *without* a domain — nobody types "open
 * youtube.com", they type "open youtube". Anything with a dot in it already
 * worked, through `looksLikeDomain`, and always will. So the table covers the
 * spoken shorthand and stops.
 *
 * Typos are handled by `rankMatches`, not by listing them: "youtub", "youtbe"
 * and "yotube" all reach YouTube on edit distance, and adding a site here
 * gives it that tolerance for free.
 *
 * ── Ordering against installed apps ─────────────────────────────────────────
 * The app list wins. "open discord" opens the Discord program when it is
 * installed and discord.com when it is not, which is what someone with the app
 * means and the only thing available to someone without it. That ordering
 * lives in `app.open`; this module only answers "is this a site I know?".
 */

import { rankMatches, confidentMatch, RANK } from './fuzzy';

export interface KnownSite {
  /** How Atlas says it back. */
  name: string;
  url: string;
  /** Other things people call it. Not misspellings — those are handled by distance. */
  aliases?: readonly string[];
}

export const KNOWN_SITES: readonly KnownSite[] = [
  { name: 'YouTube', url: 'https://www.youtube.com', aliases: ['yt', 'you tube'] },
  { name: 'Google', url: 'https://www.google.com' },
  { name: 'Gmail', url: 'https://mail.google.com', aliases: ['google mail'] },
  { name: 'Google Drive', url: 'https://drive.google.com', aliases: ['drive', 'gdrive'] },
  { name: 'Google Docs', url: 'https://docs.google.com', aliases: ['docs'] },
  { name: 'Google Maps', url: 'https://maps.google.com', aliases: ['maps'] },
  { name: 'GitHub', url: 'https://github.com' },
  { name: 'Wikipedia', url: 'https://www.wikipedia.org', aliases: ['wiki'] },
  { name: 'Reddit', url: 'https://www.reddit.com' },
  { name: 'X', url: 'https://x.com', aliases: ['twitter'] },
  { name: 'Facebook', url: 'https://www.facebook.com', aliases: ['fb'] },
  { name: 'Instagram', url: 'https://www.instagram.com', aliases: ['insta', 'ig'] },
  { name: 'TikTok', url: 'https://www.tiktok.com' },
  { name: 'Twitch', url: 'https://www.twitch.tv' },
  { name: 'Netflix', url: 'https://www.netflix.com' },
  { name: 'Spotify', url: 'https://open.spotify.com' },
  { name: 'Amazon', url: 'https://www.amazon.com' },
  { name: 'eBay', url: 'https://www.ebay.com' },
  { name: 'LinkedIn', url: 'https://www.linkedin.com' },
  { name: 'Stack Overflow', url: 'https://stackoverflow.com', aliases: ['stackoverflow', 'so'] },
  { name: 'ChatGPT', url: 'https://chatgpt.com' },
  { name: 'Claude', url: 'https://claude.ai' },
  { name: 'Outlook', url: 'https://outlook.com', aliases: ['hotmail'] },
  { name: 'Bing', url: 'https://www.bing.com' },
  { name: 'DuckDuckGo', url: 'https://duckduckgo.com', aliases: ['ddg'] },
  { name: 'IMDb', url: 'https://www.imdb.com' },
  { name: 'Steam', url: 'https://store.steampowered.com', aliases: ['steam store'] },
  { name: 'Epic Games', url: 'https://store.epicgames.com', aliases: ['epic'] },
  { name: 'Discord', url: 'https://discord.com' },
  { name: 'WhatsApp', url: 'https://web.whatsapp.com' },
  { name: 'Pinterest', url: 'https://www.pinterest.com' },
  { name: 'Yahoo', url: 'https://www.yahoo.com' },
  { name: 'Twitch Prime', url: 'https://gaming.amazon.com', aliases: ['prime gaming'] },
];

function namesOf(site: KnownSite): string[] {
  return [site.name, ...(site.aliases ?? [])];
}

/**
 * Resolve a spoken name to a known site, typos included.
 *
 * Returns null rather than guessing when several sites are equally close —
 * the caller can then ask, which is the right answer for a genuinely
 * ambiguous name.
 */
export function resolveSite(wanted: string): KnownSite | null {
  return confidentMatch(rankMatches(KNOWN_SITES, wanted, namesOf));
}

/**
 * True when the name matches a known site *exactly* — no typo tolerance.
 *
 * Used where a wrong answer would be silent rather than visible: deciding
 * whether an unqualified word should be treated as a site before the installed
 * applications have been consulted.
 */
export function isKnownSiteName(wanted: string): boolean {
  const matches = rankMatches(KNOWN_SITES, wanted, namesOf, { exactOnly: true });
  return matches.length > 0 && matches[0]!.rank < RANK.contains;
}
