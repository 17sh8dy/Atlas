import type { HTMLAttributes } from 'react';
import { cn } from '../lib/cn';

export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded border border-border bg-surface-raised px-1.5',
        'font-sans text-[11px] font-medium text-foreground-muted',
        className,
      )}
      {...props}
    />
  );
}
