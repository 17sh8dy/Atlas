/**
 * Skills from the tool-catalog pass (docs/TOOL-CATALOG.md) that needed nothing
 * new from the operating system: search a particular site, and ask Atlas which of
 * its own skills cover something.
 *
 * Nothing here duplicates an existing skill — `web.search` is Google, the
 * `web.search*` family is one site each; this is the table-driven rest of them.
 */

import type { Platform, Skill } from '@atlas/core';
import type { SkillRegistry } from './registry';

/** Sites with a search page of their own. Key is what a person says. */
export const SEARCH_SITES: Record<string, { name: string; url: (q: string) => string }> = {
  github: { name: 'GitHub', url: (q) => `https://github.com/search?q=${q}` },
  reddit: { name: 'Reddit', url: (q) => `https://www.reddit.com/search/?q=${q}` },
  stackoverflow: { name: 'Stack Overflow', url: (q) => `https://stackoverflow.com/search?q=${q}` },
  npm: { name: 'npm', url: (q) => `https://www.npmjs.com/search?q=${q}` },
  crates: { name: 'crates.io', url: (q) => `https://crates.io/search?q=${q}` },
  pypi: { name: 'PyPI', url: (q) => `https://pypi.org/search/?q=${q}` },
  mdn: { name: 'MDN', url: (q) => `https://developer.mozilla.org/en-US/search?q=${q}` },
  amazon: { name: 'Amazon', url: (q) => `https://www.amazon.com/s?k=${q}` },
  ebay: { name: 'eBay', url: (q) => `https://www.ebay.com/sch/i.html?_nkw=${q}` },
  imdb: { name: 'IMDb', url: (q) => `https://www.imdb.com/find/?q=${q}` },
  steam: { name: 'Steam', url: (q) => `https://store.steampowered.com/search/?term=${q}` },
};

/** What a person calls a site → its key in `SEARCH_SITES`. */
export function siteKey(said: string): string | null {
  const s = said.toLowerCase().replace(/^the\s+/, '').replace(/\.(?:com|org|io)$/, '').replace(/[\s.-]+/g, '');
  const aliases: Record<string, string> = { so: 'stackoverflow', stackexchange: 'stackoverflow', cratesio: 'crates', pythonpackages: 'pypi', mozilla: 'mdn', mdnwebdocs: 'mdn' };
  const key = aliases[s] ?? s;
  return key in SEARCH_SITES ? key : null;
}

export function createCatalogSkills(platform: Platform, registry?: SkillRegistry): Skill[] {
  const skills: Skill[] = [];

  skills.push({
    id: 'web.searchSite',
    label: 'Search a site',
    icon: '🔎',
    domain: 'web',
    description: 'Search GitHub, Reddit, Stack Overflow, npm, crates.io, PyPI, MDN, Amazon, eBay, IMDb or Steam directly, or any other site through a web search limited to it.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['search github for tauri', 'search reddit for best mechanical keyboard'],
    params: {
      site: { type: 'string', required: true, description: 'the site: github, reddit, stackoverflow, npm, … or a domain like example.com' },
      query: { type: 'string', required: true, description: 'what to search for' },
    },
    async run(args) {
      const query = String(args.query ?? '').trim();
      const said = String(args.site ?? '').trim();
      if (!query) return { ok: false, error: 'Search for what?' };
      if (!said) return { ok: false, error: 'Search which site?' };
      const key = siteKey(said);
      let url: string;
      let name: string;
      if (key) {
        url = SEARCH_SITES[key]!.url(encodeURIComponent(query));
        name = SEARCH_SITES[key]!.name;
      } else if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(said)) {
        // Any other domain: a web search limited to it.
        url = `https://www.google.com/search?q=${encodeURIComponent(`site:${said.toLowerCase()} ${query}`)}`;
        name = said.toLowerCase();
      } else {
        return { ok: false, error: `I don’t have a search page for “${said}”. Try a domain, like example.com.` };
      }
      const ok = await platform.openUrl?.(url);
      return ok ? { ok: true, message: `🔎 Searching ${name} for ${query}.` } : { ok: false, error: "I couldn't open a search." };
    },
  });

  if (registry) {
    skills.push({
      id: 'engine.searchSkills',
      label: 'Do I have a skill for…',
      icon: '🧭',
      domain: 'core',
      description: 'Look through everything Atlas can do for what matches a word or phrase.',
      risk: 'safe',
      examples: ['can you do anything with zip files', 'what can you do with git'],
      params: { query: { type: 'string', required: true, description: 'a word or topic' } },
      run(args, ctx) {
        const q = String(args.query ?? '').trim().toLowerCase();
        if (!q) return { ok: false, error: 'About what?' };
        const words = q.split(/\s+/).filter((w) => w.length > 1);
        const scored = registry
          .available()
          .map((s) => {
            const hay = `${s.id} ${s.label} ${s.description} ${(s.examples ?? []).join(' ')}`.toLowerCase();
            const score = words.reduce((n, w) => n + (hay.includes(w) ? (s.label.toLowerCase().includes(w) ? 3 : 1) : 0), 0);
            return { s, score };
          })
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 12);
        if (!scored.length) return { ok: true, message: `Nothing I can do matches “${q}”. If it’s something you’d like, say what you were hoping for.` };
        ctx.showResults?.(
          scored.map(({ s }) => ({ title: s.label, subtitle: s.examples?.[0] ? `Try: “${s.examples[0]}”` : s.description, icon: s.icon ?? '✨', group: s.domain })),
          { title: `What I can do about “${q}”`, subtitle: `${scored.length} match${scored.length === 1 ? '' : 'es'}` },
        );
        return { ok: true, spoken: true, message: '' };
      },
    });
  }

  return skills;
}
