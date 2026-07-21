import type { Wallpaper } from '@atlas/core';
import { Skeleton, cn } from '@atlas/ui';
import { WallpaperCard } from './WallpaperCard';

export interface WallpaperGridProps {
  wallpapers: Wallpaper[];
  className?: string;
}

/**
 * Masonry grid that preserves each wallpaper's native aspect ratio. Offscreen
 * cards are skipped by the browser via `content-visibility: auto` on each card,
 * which keeps large catalogs smooth; a windowing library can replace this if
 * catalogs grow into the thousands.
 */
export function WallpaperGrid({ wallpapers, className }: WallpaperGridProps) {
  return (
    <div className={cn('columns-1 gap-4 sm:columns-2 lg:columns-3 xl:columns-4', className)}>
      {wallpapers.map((wallpaper, i) => (
        <div key={wallpaper.id} className="mb-4 break-inside-avoid">
          <WallpaperCard wallpaper={wallpaper} priority={i < 4} />
        </div>
      ))}
    </div>
  );
}

const SKELETON_HEIGHTS = [220, 320, 260, 300, 240, 340, 280, 300];

export function WallpaperGridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="columns-1 gap-4 sm:columns-2 lg:columns-3 xl:columns-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="mb-4 break-inside-avoid">
          <Skeleton
            className="w-full rounded-xl"
            style={{ height: SKELETON_HEIGHTS[i % SKELETON_HEIGHTS.length] }}
          />
        </div>
      ))}
    </div>
  );
}
