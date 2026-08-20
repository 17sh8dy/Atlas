import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_ACCENT, applyAccent, isAccentId } from '@atlas/tokens';
import type { AccentId, ResolvedTheme, ThemeMode } from '@atlas/tokens';

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
  accent: AccentId;
  setAccent: (accent: AccentId) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
const STORAGE_KEY = 'atlas.theme';
const ACCENT_KEY = 'atlas.accent';

function systemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function resolve(mode: ThemeMode): ResolvedTheme {
  return mode === 'system' ? systemTheme() : mode;
}

function readStoredMode(): ThemeMode {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'dark';
}

function readStoredAccent(): AccentId {
  const stored = localStorage.getItem(ACCENT_KEY);
  return isAccentId(stored) ? stored : DEFAULT_ACCENT;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(readStoredMode);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolve(readStoredMode()));
  const [accent, setAccent] = useState<AccentId>(readStoredAccent);

  // Re-applied when the *theme* changes too, not just the accent: each scheme
  // carries a light and a dark variant, and the light one is a shade deeper.
  useEffect(() => {
    applyAccent(document.documentElement, accent, resolved);
    localStorage.setItem(ACCENT_KEY, accent);
  }, [accent, resolved]);

  useEffect(() => {
    const applied = resolve(mode);
    setResolved(applied);
    document.documentElement.dataset.theme = applied;
    localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  // Track OS theme changes while in "system" mode.
  useEffect(() => {
    if (mode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => {
      const applied = systemTheme();
      setResolved(applied);
      document.documentElement.dataset.theme = applied;
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [mode]);

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, resolved, setMode, accent, setAccent }),
    [mode, resolved, accent],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
