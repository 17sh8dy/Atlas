import { Link } from 'react-router-dom';
import type { Collection } from '@atlas/core';
import { WallpaperImage } from './WallpaperImage';

export function CollectionCard({ collection }: { collection: Collection }) {
  return (
    <Link
      to="/library"
      className="group relative block w-72 shrink-0 snap-start overflow-hidden rounded-xl border border-border"
    >
      <WallpaperImage
        src={collection.coverUrl ?? ''}
        alt={collection.title}
        color="#16161c"
        aspectRatio={16 / 10}
        imgClassName="transition-transform duration-slow ease-out group-hover:scale-[1.04]"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/25 to-transparent" />
      <span className="absolute right-3 top-3 rounded-md bg-black/40 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur">
        Collection
      </span>
      <div className="absolute inset-x-0 bottom-0 p-4">
        <p className="text-sm font-semibold text-white">{collection.title}</p>
        <p className="mt-0.5 text-xs text-white/70">{collection.wallpaperIds.length} wallpapers</p>
      </div>
    </Link>
  );
}
