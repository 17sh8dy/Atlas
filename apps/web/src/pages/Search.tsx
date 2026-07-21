import { useMemo, useState } from 'react';
import { Icons, Input, cn } from '@atlas/ui';
import { useSearch } from '@atlas/data';
import { Page, PageHeader, EmptyState } from '../components/layout';
import { WallpaperGrid, WallpaperGridSkeleton } from '../components/WallpaperGrid';
import { useDebounced } from '../lib/useDebounced';

const SUGGESTIONS = ['space', 'minimal', 'neon', 'nature', 'cyberpunk', 'abstract', 'anime', 'cars'];

export function Search() {
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query, 180);
  const filters = useMemo(() => ({ query: debounced.trim() || undefined }), [debounced]);
  const { data, loading } = useSearch(filters);

  return (
    <Page className="flex flex-col gap-6">
      <PageHeader title="Search" subtitle="Find the perfect wallpaper" />

      <div className="relative max-w-xl">
        <Icons.Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Try 'space', 'minimal', 'neon'…"
          className="pl-9"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        {SUGGESTIONS.map((tag) => (
          <button
            key={tag}
            type="button"
            onClick={() => setQuery(tag)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium transition duration-fast',
              debounced.trim() === tag
                ? 'border-primary/40 bg-primary/15 text-foreground'
                : 'border-border bg-surface text-foreground-muted hover:border-border-strong hover:text-foreground',
            )}
          >
            {tag}
          </button>
        ))}
      </div>

      {loading ? (
        <WallpaperGridSkeleton />
      ) : data && data.length > 0 ? (
        <WallpaperGrid wallpapers={data} />
      ) : (
        <EmptyState label={debounced.trim() ? `No results for “${debounced}”.` : 'Start typing to search.'} />
      )}
    </Page>
  );
}
