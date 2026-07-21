import { Link } from 'react-router-dom';
import { assetOf, type Wallpaper } from '@atlas/core';
import { Icons } from '@atlas/ui';
import { WallpaperImage } from './WallpaperImage';

/**
 * Full-bleed featured banner. The whole banner links to the detail page (a
 * stretched anchor); the action chips are decorative here — real download/save
 * live on the detail page and land in Phase 5.
 */
export function FeaturedHero({ wallpaper }: { wallpaper: Wallpaper }) {
  const preview = assetOf(wallpaper, 'preview') ?? wallpaper.assets[0];

  return (
    <div className="relative overflow-hidden rounded-2xl border border-border">
      <WallpaperImage
        src={preview?.url ?? ''}
        alt={wallpaper.title}
        color={wallpaper.dominantColor}
        aspectRatio={21 / 9}
        priority
        className="min-h-[240px]"
        imgClassName="transition-transform duration-slow ease-out hover:scale-[1.02]"
      />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/80 via-black/25 to-transparent" />

      <Link to={`/w/${wallpaper.id}`} className="absolute inset-0" aria-label={`View ${wallpaper.title}`} />

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-wrap items-end justify-between gap-4 p-6">
        <div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-white backdrop-blur">
            <Icons.Sparkles className="h-3 w-3" />
            Featured
          </span>
          <h2 className="mt-3 text-2xl font-semibold text-white sm:text-3xl">{wallpaper.title}</h2>
          <p className="mt-1 text-sm text-white/70">
            {wallpaper.author} · {wallpaper.width}×{wallpaper.height}
          </p>
        </div>
        <div className="flex gap-2">
          <span className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm">
            <Icons.Download className="h-4 w-4" />
            Download
          </span>
          <span className="inline-flex h-10 items-center gap-2 rounded-lg border border-white/20 bg-white/10 px-4 text-sm font-medium text-white backdrop-blur">
            <Icons.Heart className="h-4 w-4" />
            Save
          </span>
        </div>
      </div>
    </div>
  );
}
