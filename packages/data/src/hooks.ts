import { useEffect, useRef, useState } from 'react';
import type { FeedSection, SearchFilters } from '@atlas/core';
import { useCatalog } from './repository-context';

export interface AsyncState<T> {
  data?: T;
  loading: boolean;
  error?: Error;
}

/**
 * Minimal async data hook for Phase 1. Phase 2 replaces this with TanStack Query
 * (caching, background refetch, infinite scroll) — the repository interface stays
 * identical, so only these hooks change.
 */
function useAsync<T>(run: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ loading: true });
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    let active = true;
    setState((prev) => ({ data: prev.data, loading: true }));
    runRef
      .current()
      .then((data) => {
        if (active) setState({ data, loading: false });
      })
      .catch((error: unknown) => {
        if (active) {
          setState({
            loading: false,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}

export function useFeatured() {
  const repo = useCatalog();
  return useAsync(() => repo.getFeatured(), []);
}

export function useFeed(section: FeedSection, limit?: number) {
  const repo = useCatalog();
  return useAsync(() => repo.getFeed(section, { limit }), [section, limit]);
}

export function useCategories() {
  const repo = useCatalog();
  return useAsync(() => repo.getCategories(), []);
}

export function useCollections() {
  const repo = useCatalog();
  return useAsync(() => repo.getCollections(), []);
}

export function useWallpaper(id: string) {
  const repo = useCatalog();
  return useAsync(() => repo.getWallpaper(id), [id]);
}

export function useRelated(id: string, limit?: number) {
  const repo = useCatalog();
  return useAsync(() => repo.getRelated(id, { limit }), [id, limit]);
}

export function useCategoryWallpapers(slug: string) {
  const repo = useCatalog();
  return useAsync(() => repo.listByCategory(slug), [slug]);
}

export function useSearch(filters: SearchFilters) {
  const repo = useCatalog();
  const key = JSON.stringify(filters);
  return useAsync(() => repo.search(filters), [key]);
}
