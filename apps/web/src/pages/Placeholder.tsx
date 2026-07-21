import { Button, Surface, Icons } from '@atlas/ui';

export interface PlaceholderProps {
  title: string;
  blurb: string;
}

/**
 * Phase 0 placeholder. Proves the shell (tokens, theming, routing, component
 * system) end-to-end. Real content replaces these in later phases.
 */
export function Placeholder({ title, blurb }: PlaceholderProps) {
  return (
    <div className="mx-auto flex min-h-full max-w-5xl flex-col gap-6 p-8">
      <header className="flex items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-widest text-foreground-subtle">
            Atlas
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">{title}</h1>
        </div>
        <Button size="sm" variant="secondary">
          <Icons.Sparkles className="h-4 w-4" />
          Coming soon
        </Button>
      </header>

      <Surface raised className="grid place-items-center px-6 py-16 text-center">
        <div className="max-w-md">
          <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-xl bg-primary/15 text-primary">
            <Icons.Compass className="h-6 w-6" />
          </div>
          <h2 className="text-lg font-medium">{title}</h2>
          <p className="mt-2 text-sm text-foreground-muted">{blurb}</p>
          <p className="mt-4 text-xs text-foreground-subtle">
            The Phase 0 foundation is live — design tokens, dark-first theming, routing, and the
            component system are all wired up.
          </p>
        </div>
      </Surface>
    </div>
  );
}
