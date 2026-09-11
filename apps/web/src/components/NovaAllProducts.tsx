/**
 * The full-screen "all Nova products" view — opened by the "View all" row at the foot of
 * NovaSwitcher's dropdown. The dropdown stays the quick way to jump straight to a sibling
 * product; this is the slower, better-looking one for actually browsing the family, laid out as
 * a card grid instead of a short menu.
 *
 * Styled after Online Earth's All Tools launcher (read directly from that repo's all-tools/
 * before building this) but built on Atlas's own `Modal` (`@atlas/ui`, Radix Dialog underneath —
 * unused anywhere else in the app until now, and a real focus trap/portal/Escape handling is
 * exactly what this needed rather than reinventing one) and this app's own tokens, not Online
 * Earth's hand-rolled glass values. `overlayClassName` is the one thing `Modal` didn't have yet:
 * a heavier blur for a full-screen launcher reads as a bigger room, where the default scrim is
 * tuned for a small confirm dialog.
 */

import { Icons, Modal, cn } from '@atlas/ui';

export interface NovaAllProduct {
  id: string;
  label: string;
  tagline: string;
  icon: Icons.LucideIcon;
  url: string | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  current: string;
  currentLabel?: string;
  products: NovaAllProduct[];
  mark: React.ReactNode;
}

export function NovaAllProducts({ open, onClose, current, currentLabel, products, mark }: Props) {
  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      label="All Nova products"
      overlayClassName="backdrop-blur-2xl"
      className="max-w-3xl"
    >
      <div className="relative">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="border-border bg-surface text-foreground hover:bg-surface-raised absolute -top-14 right-0 inline-flex h-9 w-9 items-center justify-center rounded-lg border transition hover:scale-105"
        >
          <Icons.X className="h-4 w-4" />
        </button>

        <div className="text-center">
          <p className="text-foreground-subtle mb-3 inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide">
            <span className="h-5 w-5 shrink-0 overflow-hidden rounded">{mark}</span>
            <span>Nova</span>
          </p>
          <h2 className="text-foreground mb-1.5 text-2xl font-bold tracking-tight">All products</h2>
          <p className="text-foreground-muted mx-auto mb-7 max-w-md">Everything Nova makes, in one place.</p>

          <div className="grid grid-cols-2 gap-3.5 text-left sm:grid-cols-4">
            {products.map((p, i) => {
              const Icon = p.icon;
              const isCurrent = p.id === current;
              const label = isCurrent && currentLabel ? currentLabel : p.label;
              const body = (
                <>
                  <span
                    className={cn(
                      'bg-surface-raised text-foreground-muted mb-3 grid h-10 w-10 shrink-0 place-items-center rounded-md',
                      isCurrent && 'bg-background text-accent',
                    )}
                  >
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <span className="text-foreground block text-sm font-bold">{label}</span>
                  <span className={cn('text-foreground-subtle block text-xs', isCurrent && 'text-accent')}>
                    {isCurrent ? "You're here" : p.tagline}
                  </span>
                </>
              );
              const style = { animationDelay: `${i * 40}ms` };
              const cardClass =
                'animate-in fade-in-0 zoom-in-95 fill-mode-both relative flex flex-col rounded-2xl border p-5';

              if (isCurrent) {
                return (
                  <span
                    key={p.id}
                    style={style}
                    className={cn(cardClass, 'border-accent/40 bg-accent/10 cursor-default')}
                  >
                    {body}
                  </span>
                );
              }
              if (!p.url) {
                return (
                  <span
                    key={p.id}
                    style={style}
                    className={cn(cardClass, 'border-border text-foreground-subtle cursor-default')}
                  >
                    {body}
                    <span className="bg-surface-raised text-foreground-subtle absolute right-3.5 top-3.5 rounded-full px-2.5 py-0.5 text-[10px] font-semibold">
                      Soon
                    </span>
                  </span>
                );
              }
              return (
                <a
                  key={p.id}
                  href={p.url}
                  target="_blank"
                  rel="noreferrer"
                  style={style}
                  className={cn(
                    cardClass,
                    'border-border bg-surface no-underline',
                    'duration-base transition hover:-translate-y-0.5 hover:border-border-strong hover:bg-surface-raised hover:shadow-lg',
                  )}
                >
                  {body}
                </a>
              );
            })}
          </div>
        </div>
      </div>
    </Modal>
  );
}
