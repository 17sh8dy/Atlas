import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '../lib/cn';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        'h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground',
        'placeholder:text-foreground-subtle',
        'transition duration-fast ease-out',
        'focus-visible:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        className,
      )}
      {...props}
    />
  );
});
