import { useState, type CSSProperties } from 'react';
import { cn } from '@atlas/ui';

export interface WallpaperImageProps {
  src: string;
  alt: string;
  /** Dominant color shown as a placeholder while the image decodes. */
  color: string;
  /** width / height, used to reserve layout space and avoid shift. */
  aspectRatio?: number;
  className?: string;
  imgClassName?: string;
  priority?: boolean;
}

/**
 * Progressive image: paints the dominant color immediately, reserves space via
 * aspect-ratio (no layout shift), then fades the photo in on load. A blurhash
 * decode can slot in here later once real assets carry hashes.
 */
export function WallpaperImage({
  src,
  alt,
  color,
  aspectRatio,
  className,
  imgClassName,
  priority = false,
}: WallpaperImageProps) {
  const [loaded, setLoaded] = useState(false);

  const style: CSSProperties = {
    backgroundColor: color,
    aspectRatio: aspectRatio ? String(aspectRatio) : undefined,
  };

  return (
    <div className={cn('relative overflow-hidden', className)} style={style}>
      <img
        src={src}
        alt={alt}
        loading={priority ? 'eager' : 'lazy'}
        decoding="async"
        onLoad={() => setLoaded(true)}
        className={cn(
          'h-full w-full object-cover transition-opacity duration-slow ease-out',
          loaded ? 'opacity-100' : 'opacity-0',
          imgClassName,
        )}
      />
    </div>
  );
}
