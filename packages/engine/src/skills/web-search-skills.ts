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
import { filterDestinations, isExplicitDestination, refusalFor } from '../safety/content-policy';

/** The bare host, for naming a source without printing a whole URL. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

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

        // Observable actions only — the query that went out, and what came
        // back. Nothing here reports what Atlas made of any of it.
        const searching = ctx.activity?.step('Searching the web', query);

        let results;
        try {
          results = await platform.searchWeb!(query);
        } catch (e) {
          const reason = e instanceof Error ? e.message : "I couldn't search the web.";
          searching?.failed(reason);
          return { ok: false, error: reason };
        }

        if (!results.length) {
          searching?.done('No results');
          return { ok: true, message: `No web results for "${query}".` };
        }
        searching?.done(`${results.length} result${results.length === 1 ? '' : 's'}`);

        // Requirement 6, accidental exposure: an ordinary query can return
        // something explicit. Dropped here, at the point the results enter
        // Atlas, so they reach neither the rows the user can click nor the
        // `data` a connected model is later asked to read — one filter rather
        // than one per consumer.
        const beforeFilter = results.length;
        results = filterDestinations(results);
        if (beforeFilter !== results.length) {
          ctx.activity?.note(
            'Filtered results',
            `${beforeFilter - results.length} not shown`,
          );
        }
        if (!results.length) {
          return { ok: true, message: `No results I can show you for "${query}".` };
        }

        // The sources actually being offered — the useful half of "what is it
        // doing", and all of it observable.
        const hosts = [...new Set(results.map((r) => hostOf(r.url)).filter(Boolean))];
        if (hosts.length) {
          ctx.activity?.note('Sources', hosts.slice(0, 6).join(', '));
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
        // The `url` argument was screened before this skill ran; what came
        // back may still be somewhere else, since a link can redirect. Checked
        // on the fetched page's own address and title rather than its body:
        // an article *about* a sexual subject is legitimate reading, and
        // scanning full page text would refuse exactly those.
        if (isExplicitDestination({ url: page.url, title: page.title })) {
          return { ok: false, error: refusalFor('explicit') };
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
