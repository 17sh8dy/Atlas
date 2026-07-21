import type { ReactNode } from 'react';

export interface SectionProps {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
}

export function Section({ title, subtitle, action, children }: SectionProps) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          {subtitle && <p className="mt-0.5 text-sm text-foreground-muted">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
