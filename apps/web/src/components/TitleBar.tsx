/**
 * The window chrome, drawn by the app.
 *
 * The Tauri window has `decorations: false`, which buys a title bar that
 * matches the product instead of the OS — and obliges us to provide the two
 * things the OS was doing for us: a drag region and window controls.
 *
 * `data-tauri-drag-region` is what makes the bar draggable. It has to be on the
 * element the pointer actually lands on, so the buttons deliberately sit
 * *outside* it — an element inside a drag region swallows its own clicks.
 *
 * In a browser there is no window to control, so the buttons render only under
 * Tauri and the bar degrades to a plain header.
 */

import { Icons, cn } from '@atlas/ui';
import { isTauri } from '@atlas/platform';

interface Props {
  right?: React.ReactNode;
}

export function TitleBar({ right }: Props) {
  const native = isTauri();

  const windowAction = async (action: 'minimize' | 'close') => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    // Close hides rather than exits — Atlas stays resident, and the summon key
    // keeps working. Quitting is done from the tray, deliberately.
    if (action === 'minimize') await win.minimize();
    else await win.hide();
  };

  return (
    <header className="flex h-11 shrink-0 items-stretch border-b border-border bg-background/80 backdrop-blur">
      <div
        data-tauri-drag-region
        className="flex flex-1 items-center gap-2.5 px-4 select-none"
      >
        <div className="grid h-5 w-5 place-items-center rounded-md bg-primary text-primary-foreground">
          <Icons.Compass className="h-3 w-3" />
        </div>
        <span className="text-[13px] font-semibold tracking-tight text-foreground">Atlas</span>
        <span className="text-[11px] text-foreground-subtle">Navigator Engine</span>
      </div>

      <div className="flex items-center gap-1 pr-2">
        {right}

        {native && (
          <>
            <WindowButton label="Minimise" onClick={() => windowAction('minimize')}>
              <Icons.Minus className="h-3.5 w-3.5" />
            </WindowButton>
            <WindowButton label="Hide Atlas" onClick={() => windowAction('close')} danger>
              <Icons.X className="h-3.5 w-3.5" />
            </WindowButton>
          </>
        )}
      </div>
    </header>
  );
}

function WindowButton({
  children,
  label,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  label: string;
  onClick(): void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'grid h-7 w-7 place-items-center rounded-md text-foreground-subtle',
        'transition duration-fast hover:bg-surface hover:text-foreground',
        danger && 'hover:bg-danger/15 hover:text-danger',
      )}
    >
      {children}
    </button>
  );
}
