import { Icons, Kbd } from '@atlas/ui';

export function TopBar({ onOpenPalette }: { onOpenPalette: () => void }) {
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background/80 px-6 backdrop-blur">
      <button
        type="button"
        onClick={onOpenPalette}
        className="group flex h-9 w-full max-w-md items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm text-foreground-subtle transition duration-fast ease-out hover:border-border-strong hover:text-foreground-muted"
      >
        <Icons.Search className="h-4 w-4" />
        <span>Search wallpapers…</span>
        <span className="ml-auto flex items-center gap-1">
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>

      <div className="ml-auto flex items-center gap-2">
        <span className="hidden items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary sm:inline-flex">
          <Icons.Sparkles className="h-3.5 w-3.5" />
          Atlas Pro
        </span>
      </div>
    </header>
  );
}
