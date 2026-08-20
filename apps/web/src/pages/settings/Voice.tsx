/**
 * Voice — placeholder.
 *
 * There is no audio code anywhere in Atlas yet: no text-to-speech, no speech
 * recognition. The approach is genuinely undecided — the WebView Atlas runs in
 * can do offline text-to-speech today, but speech recognition in a Chromium
 * engine typically needs a network round-trip, which sits uneasily next to
 * "works with nothing connected." That tension hasn't been resolved, so this
 * tab says so instead of half-building around it.
 */

import { Icons, Surface } from '@atlas/ui';

export function Voice() {
  return (
    <Surface className="flex items-start gap-3 p-4">
      <Icons.Mic className="text-foreground-subtle mt-0.5 h-4 w-4 shrink-0" />
      <div>
        <h2 className="text-foreground text-sm font-medium">Coming soon</h2>
        <p className="text-foreground-subtle mt-1 text-xs leading-relaxed">
          Voice input and output aren&apos;t built yet. The open question is whether speech
          recognition should require a network connection (better accuracy, offline-first exception)
          or wait for a fully local engine — undecided, revisit later.
        </p>
      </div>
    </Surface>
  );
}
