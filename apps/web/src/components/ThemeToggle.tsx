import { Button, Icons } from '@atlas/ui';
import { useTheme } from '../app/theme';

/** Minimal dark/light switch. Full theme settings arrive in Phase 7. */
export function ThemeToggle() {
  const { resolved, setMode } = useTheme();
  const next = resolved === 'dark' ? 'light' : 'dark';
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-8 w-8 px-0"
      aria-label={`Switch to ${next} theme`}
      onClick={() => setMode(next)}
    >
      {resolved === 'dark' ? (
        <Icons.Sparkles className="h-4 w-4" />
      ) : (
        <Icons.Compass className="h-4 w-4" />
      )}
    </Button>
  );
}
