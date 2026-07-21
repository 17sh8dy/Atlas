import { useParams } from 'react-router-dom';
import { useCategories, useCategoryWallpapers } from '@atlas/data';
import { Page, PageHeader, BackLink, EmptyState } from '../components/layout';
import { WallpaperGrid, WallpaperGridSkeleton } from '../components/WallpaperGrid';
import { categoryIcon } from '../lib/categoryIcons';

export function CategoryDetail() {
  const { slug = '' } = useParams();
  const { data, loading } = useCategoryWallpapers(slug);
  const categories = useCategories();
  const category = categories.data?.find((c) => c.slug === slug);

  return (
    <Page className="flex flex-col gap-6">
      <BackLink to="/categories" label="Categories" />
      <PageHeader
        title={category?.name ?? slug}
        subtitle={loading ? 'Loading…' : `${data?.length ?? 0} wallpapers`}
        icon={categoryIcon(slug)}
      />
      {loading ? (
        <WallpaperGridSkeleton />
      ) : data && data.length > 0 ? (
        <WallpaperGrid wallpapers={data} />
      ) : (
        <EmptyState label="No wallpapers in this category yet." />
      )}
    </Page>
  );
}
