import type { Wallpaper } from '@atlas/core';
import { Skeleton } from '@atlas/ui';
import { WallpaperCard } from './WallpaperCard';

export interface WallpaperRowProps {
  wallpapers: Wallpaper[];
}

/** Horizontal, snap-scrolling carousel of uniformly cropped cards. */
export function WallpaperRow({ wallpapers }: WallpaperRowProps) {
  return (
    <div className="-mx-1 flex snap-x gap-4 overflow-x-auto px-1 pb-2">
      {wallpapers.map((wallpaper, i) => (
        <div key={wallpaper.id} className="w-72 shrink-0 snap-start">
          <WallpaperCard wallpaper={wallpaper} aspectRatio={16 / 10} priority={i < 3} />
        </div>
      ))}
    </div>
  );
}

export function WallpaperRowSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="-mx-1 flex gap-4 overflow-hidden px-1 pb-2">
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="aspect-[16/10] w-72 shrink-0 rounded-xl" />
      ))}
    </div>
  );
}
