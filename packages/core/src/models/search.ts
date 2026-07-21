import type { Orientation } from './wallpaper';

/** Normalized search intent — resolved by a SearchRepository (Phase 3). */
export interface SearchFilters {
  query?: string;
  categorySlugs?: string[];
  tags?: string[];
  /** Hex color strings to match against a wallpaper's palette. */
  colors?: string[];
  orientation?: Orientation;
  minWidth?: number;
  minHeight?: number;
}

export type FeedSection = 'featured' | 'trending' | 'new' | 'staff-picks';
