export type ID = string;

export type Orientation = 'portrait' | 'landscape' | 'square';

/**
 * Where a wallpaper originated. The app never branches on this in the UI —
 * it exists so the content pipeline can migrate from third-party APIs to owned
 * CMS content and creator/AI uploads without changing the data model.
 */
export type WallpaperSource = 'unsplash' | 'pexels' | 'wallhaven' | 'atlas' | 'creator' | 'ai';

export type AssetKind = 'thumb' | 'preview' | 'full' | 'uhd' | 'video';

/** A single downloadable/renderable representation of a wallpaper. */
export interface WallpaperAsset {
  kind: AssetKind;
  url: string;
  width: number;
  height: number;
  bytes?: number;
}

/** The canonical wallpaper model. Every source normalizes to this shape. */
export interface Wallpaper {
  id: ID;
  title: string;
  source: WallpaperSource;
  sourceId: string;
  sourceUrl?: string;
  author?: string;
  license?: string;
  attribution?: string;
  width: number;
  height: number;
  orientation: Orientation;
  /** Hex string, e.g. "#7c5cff" — powers instant background + color filters. */
  dominantColor: string;
  colors: string[];
  /** Compact placeholder hash for progressive loading. */
  blurhash?: string;
  tags: string[];
  categorySlugs: string[];
  isAi: boolean;
  isLive: boolean;
  assets: WallpaperAsset[];
  popularity: number;
  createdAt: string;
}

export function orientationOf(width: number, height: number): Orientation {
  if (width === height) return 'square';
  return width > height ? 'landscape' : 'portrait';
}

export function assetOf(wallpaper: Wallpaper, kind: AssetKind): WallpaperAsset | undefined {
  return wallpaper.assets.find((a) => a.kind === kind);
}
