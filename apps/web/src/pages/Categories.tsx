import { Skeleton } from '@atlas/ui';
import { useCategories } from '@atlas/data';
import { Page, PageHeader } from '../components/layout';
import { CategoryTile } from '../components/CategoryTile';

export function Categories() {
  const { data, loading } = useCategories();

  return (
    <Page className="flex flex-col gap-6">
      <PageHeader title="Categories" subtitle="Explore wallpapers by theme" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {loading
          ? Array.from({ length: 12 }).map((_, i) => (
              <Skeleton key={i} className="h-[74px] rounded-xl" />
            ))
          : (data ?? []).map((category) => (
              <CategoryTile key={category.id} category={category} />
            ))}
      </div>
    </Page>
  );
}
