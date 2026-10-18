/**
 * Makes the review panel reachable from anywhere in the app: a card in the conversation, the
 * Activity page, a result list. It owns nothing but "which files is the panel showing, if any", and
 * it does nothing on its own: the panel only appears when a person opens it.
 */

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { FileReview, Platform } from '@atlas/core';
import { ReviewPanel } from './ReviewPanel';

export interface ReviewApi {
  platform: Platform | null;
  /** Open the panel on these files, or on the history of recent edits when none are given. */
  open(files?: FileReview[], index?: number): void;
}

const Ctx = createContext<ReviewApi>({ platform: null, open: () => {} });

export function useReview(): ReviewApi {
  return useContext(Ctx);
}

export function ReviewProvider({ platform, children }: { platform: Platform | null; children: ReactNode }) {
  const [panel, setPanel] = useState<{ files: FileReview[] | null; index: number } | null>(null);
  const api = useMemo<ReviewApi>(
    () => ({ platform, open: (files, index = 0) => setPanel({ files: files && files.length ? files : null, index }) }),
    [platform],
  );
  return (
    <Ctx.Provider value={api}>
      {children}
      {panel && <ReviewPanel platform={platform} initial={panel.files} index={panel.index} onClose={() => setPanel(null)} />}
    </Ctx.Provider>
  );
}
