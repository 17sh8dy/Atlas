/**
 * Appearance — theme mode and accent, the two halves of how Atlas looks.
 *
 * The title bar's `ThemeToggle` only ever flips between light and dark; the
 * "system" mode `ThemeProvider` already supports was never reachable from the
 * UI. This is that missing control, plus the accent picker: the theme decides
 * the surfaces you read on, the accent decides the one colour painted on top.
 *
 * Swatches are drawn from `accentSwatch`, not from hardcoded CSS, so a preview
 * can never disagree with what picking it actually does — and they are drawn
 * in the *resolved* theme, because each scheme is a shade deeper on white.
 */

import { ACCENTS, accentSwatch } from '@atlas/tokens';
import type { AccentId, ThemeMode } from '@atlas/tokens';
import { Icons, SegmentedControl, Switch, cn } from '@atlas/ui';
import { useTheme } from '../../app/theme';
import { useEnhancedEffects } from '../../app/effects';

const OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

export function Appearance() {
  const { mode, setMode, resolved, accent, setAccent } = useTheme();
  const { enabled, setEnabled, active } = useEnhancedEffects();

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-foreground mb-1 text-sm font-medium">Theme</h2>
        <p className="text-foreground-subtle mb-3 text-xs leading-relaxed">
          &quot;System&quot; follows your OS setting and switches automatically when it changes.
        </p>
        <SegmentedControl options={OPTIONS} value={mode} onChange={setMode} />
      </section>

      <section>
        <h2 className="text-foreground mb-1 text-sm font-medium">Buttons &amp; highlights</h2>
        <p className="text-foreground-subtle mb-3 text-xs leading-relaxed">
          The accent colour used for buttons, your messages, the logo and focus rings. Sunset and
          Ocean blend two colours; the rest are flat.
        </p>

        <div className="flex flex-wrap gap-2">
          {ACCENTS.map((scheme) => (
            <Swatch
              key={scheme.id}
              id={scheme.id}
              label={scheme.label}
              background={accentSwatch(scheme, resolved)}
              selected={scheme.id === accent}
              onSelect={setAccent}
            />
          ))}
        </div>
      </section>

      <section>
        <div className="border-border flex items-center justify-between gap-4 rounded-xl border px-4 py-3.5">
          <div>
            <h2 className="text-foreground text-sm font-medium">Enhanced Effects</h2>
            <p className="text-foreground-subtle mt-0.5 text-xs leading-relaxed">
              Adds a subtle lift, glow and cursor-tracked highlight to buttons and cards, plus a
              faint moving backdrop on Home. Off by default — the standard interface is already
              finished without it.
              {enabled && !active && (
                <span className="text-foreground-subtle block">
                  {' '}
                  Currently inactive because your system has reduced motion turned on.
                </span>
              )}
            </p>
          </div>
          <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enhanced Effects" />
        </div>
      </section>
    </div>
  );
}

function Swatch({
  id,
  label,
  background,
  selected,
  onSelect,
}: {
  id: AccentId;
  label: string;
  background: string;
  selected: boolean;
  onSelect(id: AccentId): void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      aria-pressed={selected}
      className={cn(
        'duration-fast flex items-center gap-2.5 rounded-xl border px-3 py-2 transition',
        'focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2',
        selected
          ? 'border-border-strong bg-surface text-foreground'
          : 'border-border bg-surface/40 text-foreground-muted hover:bg-surface hover:text-foreground',
      )}
    >
      {/* The swatch is painted with the scheme's own paint, so a gradient
          scheme previews as a gradient rather than as one of its two ends. */}
      <span
        className="grid h-6 w-6 place-items-center rounded-lg"
        style={{ background }}
        aria-hidden
      >
        {selected && <Icons.Check className="h-3.5 w-3.5 text-white drop-shadow" />}
      </span>
      <span className="text-xs font-medium">{label}</span>
    </button>
  );
}
