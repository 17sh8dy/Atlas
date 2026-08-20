/**
 * Web search — kept in its own module so the underlying search method can be
 * replaced (a different engine, a self-hosted instance, a paid API) without
 * touching anything that calls these skills. Neither skill executes anything
 * found on a page; both only ever return text for Atlas — and, when a model
 * is connected, the model — to read.
 *
 * `research.open`'s `url` argument is untrusted in a way `research.search`'s
 * `query` isn't: it can come from a search result Atlas didn't choose, so the
 * real access control lives in `fetch_page` (`is_safe_fetch_target`, Rust
 * side) — this file only re-validates the scheme, matching how `web.open`
 * re-checks what the platform already checks.
 */

import type { Platform, ResultRow, Skill } from '@atlas/core';

export function createWebSearchSkills(platform: Platform): Skill[] {
  return [
    {
      id: 'research.search',
      label: 'Search the web',
      icon: '🌍',
      domain: 'research',
      description: 'Search the web for current information and return titles, links, and snippets.',
      needs: ['network'],
      risk: 'safe',
      examples: [
        'search the internet for the latest Fortnite update',
        'research the best current options for a budget laptop',
      ],
      params: { query: { type: 'string', required: true, description: 'what to search for' } },
      async run(args, ctx) {
        const query = String(args.query).trim();
        if (!query) return { ok: false, error: 'Give me something to search for.' };

        let results;
        try {
          results = await platform.searchWeb!(query);
        } catch (e) {
          return {
            ok: false,
            error: e instanceof Error ? e.message : "I couldn't search the web.",
          };
        }

        if (!results.length) {
          return { ok: true, message: `No web results for "${query}".` };
        }

        const rows: ResultRow[] = results.map((r) => ({
          title: r.title,
          subtitle: r.snippet || r.url,
          icon: '🌐',
          payload: r,
          actions: [
            { label: 'Open', skill: 'web.open', args: { url: r.url } },
            { label: 'Read', skill: 'research.open', args: { url: r.url } },
          ],
        }));
        ctx.showResults?.(rows, {
          title: `Web results for "${query}"`,
          subtitle: `${results.length} found`,
        });
        return { ok: true, spoken: true, message: '', data: results };
      },
    },

    {
      id: 'research.open',
      label: 'Read a web page',
      icon: '📰',
      domain: 'research',
      description:
        "Fetch a web page's readable text, for summarizing or answering questions about it.",
      needs: ['network'],
      risk: 'safe',
      examples: ['read that article', 'open the first result and summarize it'],
      params: { url: { type: 'string', required: true, description: 'the page address' } },
      async run(args) {
        const url = String(args.url).trim();
        if (!/^https?:\/\//i.test(url)) {
          return { ok: false, error: 'I only fetch http and https links.' };
        }

        let page;
        try {
          page = await platform.fetchPage!(url);
        } catch (e) {
          return {
            ok: false,
            error: e instanceof Error ? e.message : "I couldn't fetch that page.",
          };
        }

        if (!page.text.trim()) {
          return { ok: false, error: "That page didn't have any readable text." };
        }
        return {
          ok: true,
          message: `📰 ${page.title || url}\n\n${page.text}`,
          data: page,
        };
      },
    },
  ];
}
