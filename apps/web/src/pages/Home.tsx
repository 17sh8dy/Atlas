import { Skeleton } from '@atlas/ui';
import {
  useCategories,
  useCollections,
  useFeatured,
  useFeed,
} from '@atlas/data';
import { Page, SeeAllLink } from '../components/layout';
import { Section } from '../components/Section';
import { FeaturedHero } from '../components/FeaturedHero';
import { WallpaperRow, WallpaperRowSkeleton } from '../components/WallpaperRow';
import { CategoryTile } from '../components/CategoryTile';
import { CollectionCard } from '../components/CollectionCard';

export function Home() {
  const featured = useFeatured();
  const trending = useFeed('trending', 8);
  const fresh = useFeed('new', 8);
  const staff = useFeed('staff-picks', 8);
  const categories = useCategories();
  const collections = useCollections();

  const hero = featured.data?.[0];

  return (
    <Page className="flex flex-col gap-10">
      {hero ? (
        <FeaturedHero wallpaper={hero} />
      ) : (
        <Skeleton className="aspect-[21/9] w-full rounded-2xl" />
      )}

      <Section
        title="Trending"
        subtitle="What everyone's downloading right now"
        action={<SeeAllLink to="/search" />}
      >
        {trending.loading ? (
          <WallpaperRowSkeleton />
        ) : (
          <WallpaperRow wallpapers={trending.data ?? []} />
        )}
      </Section>

      <Section title="Fresh drops" subtitle="Just added to Atlas">
        {fresh.loading ? <WallpaperRowSkeleton /> : <WallpaperRow wallpapers={fresh.data ?? []} />}
      </Section>

      <Section title="Browse by category" action={<SeeAllLink to="/categories" />}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {(categories.data ?? []).map((category) => (
            <CategoryTile key={category.id} category={category} />
          ))}
        </div>
      </Section>

      <Section title="Staff picks" subtitle="Hand-selected by the Atlas team">
        {staff.loading ? <WallpaperRowSkeleton /> : <WallpaperRow wallpapers={staff.data ?? []} />}
      </Section>

      <Section title="Collections" subtitle="Curated sets for every mood">
        <div className="-mx-1 flex snap-x gap-4 overflow-x-auto px-1 pb-2">
          {(collections.data ?? []).map((collection) => (
            <CollectionCard key={collection.id} collection={collection} />
          ))}
        </div>
      </Section>
    </Page>
  );
}
