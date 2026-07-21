import type { HTMLAttributes } from 'react';
import { cn } from '../lib/cn';

export interface SurfaceProps extends HTMLAttributes<HTMLDivElement> {
  /** Use the raised surface color + shadow for elevated cards/panels. */
  raised?: boolean;
}

export function Surface({ className, raised = false, ...props }: SurfaceProps) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border',
        raised ? 'bg-surface-raised shadow-md' : 'bg-surface',
        className,
      )}
      {...props}
    />
  );
}
