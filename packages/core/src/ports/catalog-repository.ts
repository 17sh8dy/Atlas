import type { Wallpaper } from '../models/wallpaper';
import type { Category } from '../models/taxonomy';
import type { Collection } from '../models/collection';
import type { FeedSection, SearchFilters } from '../models/search';

/**
 * A port (interface) the domain defines and infrastructure implements.
 * Phase 1 ships a mock implementation; Phase 2 adds a Supabase-backed one.
 * The UI depends only on this interface, never on a concrete data source.
 */
export interface CatalogRepository {
  getFeed(section: FeedSection, opts?: { limit?: number }): Promise<Wallpaper[]>;
  getFeatured(): Promise<Wallpaper[]>;
  getCategories(): Promise<Category[]>;
  getCollections(): Promise<Collection[]>;
  getWallpaper(id: string): Promise<Wallpaper | undefined>;
  getRelated(id: string, opts?: { limit?: number }): Promise<Wallpaper[]>;
  listByCategory(slug: string, opts?: { limit?: number }): Promise<Wallpaper[]>;
  search(filters: SearchFilters): Promise<Wallpaper[]>;
}
