import { Link } from 'react-router-dom';
import type { Category } from '@atlas/core';
import { Icons } from '@atlas/ui';
import { categoryIcon } from '../lib/categoryIcons';

export function CategoryTile({ category }: { category: Category }) {
  const Icon = categoryIcon(category.slug);
  return (
    <Link
      to={`/category/${category.slug}`}
      className="group flex items-center gap-3 rounded-xl border border-border bg-surface p-4 transition duration-fast ease-out hover:border-border-strong hover:bg-surface-raised"
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary transition duration-fast group-hover:bg-primary/20">
        <Icon className="h-5 w-5" />
      </span>
      <span className="text-sm font-medium">{category.name}</span>
      <Icons.ChevronRight className="ml-auto h-4 w-4 text-foreground-subtle transition duration-fast group-hover:translate-x-0.5 group-hover:text-foreground-muted" />
    </Link>
  );
}
