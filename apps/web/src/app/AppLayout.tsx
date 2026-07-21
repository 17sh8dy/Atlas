import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { Icons, cn } from '@atlas/ui';
import { ThemeToggle } from '../components/ThemeToggle';
import { TopBar } from '../components/TopBar';
import { CommandPalette } from '../components/CommandPalette';
import { AnimatedOutlet } from './AnimatedOutlet';

interface NavItem {
  to: string;
  label: string;
  icon: Icons.LucideIcon;
  end?: boolean;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Home', icon: Icons.Home, end: true },
  { to: '/search', label: 'Search', icon: Icons.Search },
  { to: '/categories', label: 'Categories', icon: Icons.Grid2x2 },
  { to: '/library', label: 'Library', icon: Icons.Library },
  { to: '/settings', label: 'Settings', icon: Icons.Settings },
];

export function AppLayout() {
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface/40 p-3">
        <div className="mb-5 flex items-center gap-2.5 px-2 py-1.5">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-primary-foreground shadow-glow">
            <Icons.Sparkles className="h-4 w-4" />
          </div>
          <span className="text-sm font-semibold tracking-tight">Atlas</span>
        </div>

        <nav className="flex flex-col gap-0.5">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition duration-fast ease-out',
                  isActive
                    ? 'bg-surface-raised text-foreground'
                    : 'text-foreground-muted hover:bg-surface hover:text-foreground',
                )
              }
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto flex items-center justify-between px-1 pt-3">
          <span className="px-2 text-xs text-foreground-subtle">Phase 1 · v0.0.0</span>
          <ThemeToggle />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onOpenPalette={() => setPaletteOpen(true)} />
        <main className="flex-1 overflow-y-auto">
          <AnimatedOutlet />
        </main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
