import { Button, Icons } from '@atlas/ui';
import { useTheme } from '../app/theme';

/** Quick dark/light toggle for the title bar. Full appearance controls, including
 * "system" mode, live in Settings → Appearance. */
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
      {resolved === 'dark' ? <Icons.Sun className="h-4 w-4" /> : <Icons.Moon className="h-4 w-4" />}
    </Button>
  );
}
