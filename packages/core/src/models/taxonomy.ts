import type { ID } from './wallpaper';

export interface Category {
  id: ID;
  slug: string;
  name: string;
  /** Icon name resolved by the UI layer (e.g. a lucide icon key). */
  icon?: string;
  sort: number;
}

export interface Tag {
  id: ID;
  slug: string;
  name: string;
}
