import { Link } from 'react-router-dom';
import { assetOf, type Wallpaper } from '@atlas/core';
import { Icons, cn } from '@atlas/ui';
import { WallpaperImage } from './WallpaperImage';

export interface WallpaperCardProps {
  wallpaper: Wallpaper;
  /** Force a fixed crop (e.g. 16/10 in carousels). Omit to keep native aspect. */
  aspectRatio?: number;
  priority?: boolean;
  className?: string;
}

export function WallpaperCard({
  wallpaper,
  aspectRatio,
  priority,
  className,
}: WallpaperCardProps) {
  const asset = assetOf(wallpaper, 'thumb') ?? wallpaper.assets[0];
  const ratio = aspectRatio ?? wallpaper.width / wallpaper.height;

  return (
    <Link
      to={`/w/${wallpaper.id}`}
      className={cn(
        'group relative block overflow-hidden rounded-xl border border-border bg-surface',
        'transition duration-fast ease-out hover:border-border-strong',
        '[content-visibility:auto] [contain-intrinsic-size:1px_360px]',
        className,
      )}
    >
      <WallpaperImage
        src={asset?.url ?? ''}
        alt={wallpaper.title}
        color={wallpaper.dominantColor}
        aspectRatio={ratio}
        priority={priority}
        imgClassName="transition-transform duration-slow ease-out group-hover:scale-[1.04]"
      />

      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/75 via-black/0 to-black/0 opacity-0 transition-opacity duration-base ease-out group-hover:opacity-100" />

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex translate-y-1 items-end justify-between gap-2 p-3 opacity-0 transition duration-base ease-out group-hover:translate-y-0 group-hover:opacity-100">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-white">{wallpaper.title}</p>
          {wallpaper.author && (
            <p className="truncate text-xs text-white/70">{wallpaper.author}</p>
          )}
        </div>
        <span className="shrink-0 rounded-md bg-white/15 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur">
          {wallpaper.width}×{wallpaper.height}
        </span>
      </div>

      {wallpaper.isAi && (
        <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-md bg-black/50 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur">
          <Icons.Wand2 className="h-3 w-3" />
          AI
        </span>
      )}
    </Link>
  );
}
