/**
 * Small pieces the Intelligence sections share, so each section reads as its
 * own content and not as markup.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Button, Input, cn } from '@atlas/ui';

export function Tag({
  children,
  tone = 'muted',
}: {
  children: ReactNode;
  tone?: 'on' | 'muted' | 'warn';
}) {
  return (
    <span
      className={cn(
        'rounded-full border px-2 py-0.5 text-[10px] font-medium',
        tone === 'on' && 'border-primary/30 bg-primary/10 text-primary',
        tone === 'muted' && 'border-border text-foreground-subtle',
        tone === 'warn' && 'border-border text-foreground-muted',
      )}
    >
      {children}
    </span>
  );
}

/** A section's title row: icon, title, and one plain sentence under it. */
export function SectionHeader({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center gap-2">
        {icon}
        <h2 className="text-foreground text-sm font-medium">{title}</h2>
      </div>
      {children && <p className="text-foreground-muted text-xs leading-relaxed">{children}</p>}
    </div>
  );
}

/**
 * Where a local server listens. Tucked under "Advanced": almost nobody changes
 * it, and it should not compete with the models for attention.
 */
export function EndpointField({
  value,
  placeholder,
  saving,
  onSave,
}: {
  value: string;
  placeholder: string;
  saving: boolean;
  onSave(next: string): void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  return (
    <details className="group mt-3">
      <summary className="text-foreground-subtle hover:text-foreground-muted cursor-pointer text-xs">
        Advanced
      </summary>
      <div className="mt-2">
        <div className="flex gap-2">
          <Input
            value={draft}
            placeholder={placeholder}
            spellCheck={false}
            autoComplete="off"
            aria-label="Server address"
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button
            variant="secondary"
            size="md"
            disabled={saving || draft === value}
            onClick={() => onSave(draft)}
          >
            Save
          </Button>
        </div>
        <p className="text-foreground-subtle mt-2 text-xs leading-relaxed">
          Leave blank for {placeholder}. This machine only — an address that isn&apos;t localhost is
          refused, so it can never become a route off the device.
        </p>
      </div>
    </details>
  );
}
