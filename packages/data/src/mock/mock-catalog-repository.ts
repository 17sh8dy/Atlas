import type {
  CatalogRepository,
  FeedSection,
  SearchFilters,
  Wallpaper,
} from '@atlas/core';
import {
  categories,
  collections,
  featuredWallpaperIds,
  staffPickIds,
  wallpapers,
} from './fixtures';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function byIds(ids: string[]): Wallpaper[] {
  return ids
    .map((id) => wallpapers.find((w) => w.id === id))
    .filter((w): w is Wallpaper => Boolean(w));
}

/**
 * In-memory CatalogRepository for Phase 1. Simulates network latency so loading
 * states are exercised. Phase 2 replaces this with a Supabase-backed repo behind
 * the same interface — no UI changes required.
 */
export class MockCatalogRepository implements CatalogRepository {
  constructor(private readonly latencyMs = 220) {}

  private settle<T>(value: T): Promise<T> {
    return delay(this.latencyMs).then(() => value);
  }

  getFeatured(): Promise<Wallpaper[]> {
    return this.settle(byIds(featuredWallpaperIds));
  }

  getFeed(section: FeedSection, opts?: { limit?: number }): Promise<Wallpaper[]> {
    const limit = opts?.limit;
    const pick = (list: Wallpaper[]) => this.settle(limit ? list.slice(0, limit) : list);
    switch (section) {
      case 'featured':
        return pick(byIds(featuredWallpaperIds));
      case 'trending':
        return pick([...wallpapers].sort((a, b) => b.popularity - a.popularity));
      case 'new':
        return pick([...wallpapers].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      case 'staff-picks':
        return pick(byIds(staffPickIds));
    }
    return this.settle([]);
  }

  getCategories(): Promise<import('@atlas/core').Category[]> {
    return this.settle([...categories].sort((a, b) => a.sort - b.sort));
  }

  getCollections(): Promise<import('@atlas/core').Collection[]> {
    return this.settle(collections);
  }

  getWallpaper(id: string): Promise<Wallpaper | undefined> {
    return this.settle(wallpapers.find((w) => w.id === id));
  }

  getRelated(id: string, opts?: { limit?: number }): Promise<Wallpaper[]> {
    const target = wallpapers.find((w) => w.id === id);
    const related = target
      ? wallpapers.filter(
          (w) =>
            w.id !== id && w.categorySlugs.some((c) => target.categorySlugs.includes(c)),
        )
      : [];
    return this.settle(opts?.limit ? related.slice(0, opts.limit) : related);
  }

  listByCategory(slug: string, opts?: { limit?: number }): Promise<Wallpaper[]> {
    const list = wallpapers
      .filter((w) => w.categorySlugs.includes(slug))
      .sort((a, b) => b.popularity - a.popularity);
    return this.settle(opts?.limit ? list.slice(0, opts.limit) : list);
  }

  search(filters: SearchFilters): Promise<Wallpaper[]> {
    let list = wallpapers.slice();
    const q = filters.query?.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (w) =>
          w.title.toLowerCase().includes(q) ||
          w.tags.some((t) => t.includes(q)) ||
          w.categorySlugs.some((c) => c.includes(q)) ||
          (w.author?.toLowerCase().includes(q) ?? false),
      );
    }
    if (filters.categorySlugs?.length) {
      list = list.filter((w) => w.categorySlugs.some((c) => filters.categorySlugs!.includes(c)));
    }
    if (filters.tags?.length) {
      list = list.filter((w) => filters.tags!.some((t) => w.tags.includes(t)));
    }
    if (filters.orientation) {
      list = list.filter((w) => w.orientation === filters.orientation);
    }
    if (filters.minWidth) {
      list = list.filter((w) => w.width >= filters.minWidth!);
    }
    if (filters.minHeight) {
      list = list.filter((w) => w.height >= filters.minHeight!);
    }
    if (filters.colors?.length) {
      list = list.filter((w) => w.colors.some((c) => filters.colors!.includes(c)));
    }
    return this.settle(list.sort((a, b) => b.popularity - a.popularity));
  }
}
