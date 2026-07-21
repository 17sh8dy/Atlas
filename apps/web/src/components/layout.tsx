import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import { Icons, cn } from '@atlas/ui';

export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mx-auto w-full max-w-6xl px-6 py-8', className)}>{children}</div>;
}

export function PageHeader({
  title,
  subtitle,
  icon: Icon,
}: {
  title: string;
  subtitle?: string;
  icon?: Icons.LucideIcon;
}) {
  return (
    <div className="flex items-center gap-3">
      {Icon && (
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </span>
      )}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-foreground-muted">{subtitle}</p>}
      </div>
    </div>
  );
}

export function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      className="inline-flex w-fit items-center gap-1.5 text-sm text-foreground-muted transition duration-fast hover:text-foreground"
    >
      <Icons.ArrowLeft className="h-4 w-4" />
      {label}
    </Link>
  );
}

export function SeeAllLink({ to }: { to: string }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1 text-sm text-foreground-muted transition duration-fast hover:text-foreground"
    >
      See all
      <Icons.ChevronRight className="h-4 w-4" />
    </Link>
  );
}

export function EmptyState({ label }: { label: string }) {
  return (
    <div className="grid place-items-center rounded-xl border border-dashed border-border py-16 text-center">
      <div>
        <Icons.ImageOff className="mx-auto h-8 w-8 text-foreground-subtle" />
        <p className="mt-3 text-sm text-foreground-muted">{label}</p>
      </div>
    </div>
  );
}
