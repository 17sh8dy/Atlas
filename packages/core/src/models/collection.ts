import type { ID } from './wallpaper';

export interface Collection {
  id: ID;
  title: string;
  description?: string;
  coverUrl?: string;
  /** Undefined for editorial/staff collections; set for user-owned ones. */
  ownerId?: ID;
  isFeatured: boolean;
  isStaffPick: boolean;
  wallpaperIds: ID[];
}
