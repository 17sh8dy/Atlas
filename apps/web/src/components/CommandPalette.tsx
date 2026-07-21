import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icons, Kbd, Modal, cn } from '@atlas/ui';
import { useCategories, useFeed } from '@atlas/data';
import { categoryIcon } from '../lib/categoryIcons';

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: Icons.LucideIcon;
  group: string;
  run: () => void;
}

const GROUP_ORDER = ['Navigation', 'Categories', 'Wallpapers'];

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const { data: categories } = useCategories();
  const { data: wallpapers } = useFeed('trending');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const activeRef = useRef<HTMLButtonElement>(null);

  const go = (to: string) => {
    onOpenChange(false);
    navigate(to);
  };

  const commands: Command[] = [
    { id: 'nav-home', label: 'Home', icon: Icons.Home, group: 'Navigation', run: () => go('/') },
    { id: 'nav-search', label: 'Search', icon: Icons.Search, group: 'Navigation', run: () => go('/search') },
    { id: 'nav-categories', label: 'Categories', icon: Icons.Grid2x2, group: 'Navigation', run: () => go('/categories') },
    { id: 'nav-library', label: 'Library', icon: Icons.Library, group: 'Navigation', run: () => go('/library') },
    { id: 'nav-settings', label: 'Settings', icon: Icons.Settings, group: 'Navigation', run: () => go('/settings') },
    ...(categories ?? []).map((c) => ({
      id: `cat-${c.slug}`,
      label: c.name,
      hint: 'Category',
      icon: categoryIcon(c.slug),
      group: 'Categories',
      run: () => go(`/category/${c.slug}`),
    })),
    ...(wallpapers ?? []).map((w) => ({
      id: `wp-${w.id}`,
      label: w.title,
      hint: w.author,
      icon: Icons.Sparkles,
      group: 'Wallpapers',
      run: () => go(`/w/${w.id}`),
    })),
  ];

  const q = query.trim().toLowerCase();
  const filtered = q
    ? commands.filter(
        (c) =>
          c.label.toLowerCase().includes(q) ||
          c.hint?.toLowerCase().includes(q) ||
          c.group.toLowerCase().includes(q),
      )
    : commands;

  const groups = GROUP_ORDER.map((group) => ({
    group,
    items: filtered.filter((c) => c.group === group),
  })).filter((g) => g.items.length > 0);

  useEffect(() => {
    setActive(0);
  }, [query, open]);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      filtered[active]?.run();
    }
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange} label="Command palette" position="top">
      <div className="overflow-hidden rounded-xl border border-border bg-surface-raised shadow-lg">
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Icons.Search className="h-4 w-4 text-foreground-subtle" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search wallpapers, categories, pages…"
            className="h-12 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-foreground-subtle"
          />
          <Kbd>Esc</Kbd>
        </div>

        <div className="max-h-[52vh] overflow-y-auto p-2">
          {filtered.length === 0 && (
            <p className="px-3 py-8 text-center text-sm text-foreground-muted">
              No results for “{query}”.
            </p>
          )}
          {groups.map(({ group, items }) => (
            <div key={group} className="mb-1">
              <p className="px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-foreground-subtle">
                {group}
              </p>
              {items.map((item) => {
                const idx = filtered.indexOf(item);
                const isActive = idx === active;
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    ref={isActive ? activeRef : undefined}
                    type="button"
                    onMouseMove={() => setActive(idx)}
                    onClick={() => item.run()}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition duration-fast',
                      isActive ? 'bg-primary/15 text-foreground' : 'text-foreground-muted hover:bg-surface',
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
                    {item.hint && (
                      <span className="ml-auto truncate pl-3 text-xs text-foreground-subtle">
                        {item.hint}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
