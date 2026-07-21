import { useParams } from 'react-router-dom';
import { assetOf } from '@atlas/core';
import { Button, Icons, Skeleton } from '@atlas/ui';
import { useRelated, useWallpaper } from '@atlas/data';
import { Page, BackLink, EmptyState } from '../components/layout';
import { Section } from '../components/Section';
import { WallpaperImage } from '../components/WallpaperImage';
import { WallpaperRow } from '../components/WallpaperRow';

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-foreground-subtle">{label}</p>
      <p className="mt-0.5 text-sm font-medium">{value}</p>
    </div>
  );
}

export function WallpaperDetail() {
  const { id = '' } = useParams();
  const { data: wallpaper, loading } = useWallpaper(id);
  const { data: related } = useRelated(id, 6);

  if (loading) {
    return (
      <Page className="flex flex-col gap-6">
        <Skeleton className="aspect-video w-full rounded-2xl" />
      </Page>
    );
  }

  if (!wallpaper) {
    return (
      <Page className="flex flex-col gap-6">
        <BackLink to="/" label="Home" />
        <EmptyState label="Wallpaper not found." />
      </Page>
    );
  }

  const preview = assetOf(wallpaper, 'preview') ?? wallpaper.assets[0];

  return (
    <Page className="flex flex-col gap-8">
      <BackLink to="/" label="Home" />

      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <div className="overflow-hidden rounded-2xl border border-border">
          <WallpaperImage
            src={preview?.url ?? ''}
            alt={wallpaper.title}
            color={wallpaper.dominantColor}
            aspectRatio={wallpaper.width / wallpaper.height}
            priority
          />
        </div>

        <aside className="flex flex-col gap-5">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{wallpaper.title}</h1>
            <p className="mt-1 text-sm text-foreground-muted">{wallpaper.attribution}</p>
          </div>

          <div className="flex gap-2">
            <Button className="flex-1">
              <Icons.Download className="h-4 w-4" />
              Download
            </Button>
            <Button variant="secondary" aria-label="Save to favorites">
              <Icons.Heart className="h-4 w-4" />
            </Button>
            <Button variant="secondary" aria-label="Share">
              <Icons.Share2 className="h-4 w-4" />
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Meta label="Resolution" value={`${wallpaper.width}×${wallpaper.height}`} />
            <Meta label="Orientation" value={wallpaper.orientation} />
            <Meta label="Source" value={wallpaper.source} />
            <Meta label="Popularity" value={wallpaper.popularity.toLocaleString()} />
          </div>

          <div>
            <p className="mb-2 text-[11px] uppercase tracking-wide text-foreground-subtle">Tags</p>
            <div className="flex flex-wrap gap-2">
              {wallpaper.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full border border-border bg-surface px-2.5 py-1 text-xs text-foreground-muted"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        </aside>
      </div>

      {related && related.length > 0 && (
        <Section title="Related">
          <WallpaperRow wallpapers={related} />
        </Section>
      )}
    </Page>
  );
}
