import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { MockCatalogRepository, RepositoryProvider } from '@atlas/data';
import { router } from './app/router';
import { ThemeProvider } from './app/theme';
import '@atlas/tokens/tokens.css';
import './styles/index.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

// Phase 1 uses the in-memory catalog. Phase 2 swaps this one line for a
// Supabase-backed repository — no other change required.
const repository = new MockCatalogRepository();

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <ThemeProvider>
      <RepositoryProvider repository={repository}>
        <RouterProvider router={router} />
      </RepositoryProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
