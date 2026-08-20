import { cn } from '../lib/cn';

export interface SegmentedControlOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedControlProps<T extends string> {
  options: readonly SegmentedControlOption<T>[];
  value: T;
  onChange(value: T): void;
  className?: string;
}

/**
 * A small fixed set of mutually exclusive choices (theme mode, and similar).
 * Not Radix-based — a handful of buttons with `radio` semantics doesn't
 * justify a dependency the way `Tabs`/`Switch` do for their richer behaviour.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="radiogroup"
      className={cn('inline-flex gap-1 rounded-lg border border-border bg-surface p-1', className)}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-md px-3 py-1.5 text-sm font-medium transition duration-fast',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            option.value === value
              ? 'bg-surface-raised text-foreground shadow-sm'
              : 'text-foreground-muted hover:text-foreground',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
