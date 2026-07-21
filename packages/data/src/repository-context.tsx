import { createContext, useContext, type ReactNode } from 'react';
import type { CatalogRepository } from '@atlas/core';

const CatalogContext = createContext<CatalogRepository | null>(null);

/**
 * Provides the active CatalogRepository to the tree. Swap the `repository` prop
 * (mock ↔ Supabase) without touching any consumer.
 */
export function RepositoryProvider({
  repository,
  children,
}: {
  repository: CatalogRepository;
  children: ReactNode;
}) {
  return <CatalogContext.Provider value={repository}>{children}</CatalogContext.Provider>;
}

export function useCatalog(): CatalogRepository {
  const repo = useContext(CatalogContext);
  if (!repo) throw new Error('useCatalog must be used within a RepositoryProvider');
  return repo;
}
