import React from 'react';
import ReactDOM from 'react-dom/client';
import { detectPlatform } from '@atlas/platform';
import { AtlasApp } from './app/AtlasApp';
import { ThemeProvider } from './app/theme';
import '@atlas/tokens/tokens.css';
import './styles/index.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

// The one place the runtime is decided. Everything above this line is written
// against the Platform port and never learns whether it's in a window or a tab.
const platform = detectPlatform();

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <ThemeProvider>
      <AtlasApp platform={platform} />
    </ThemeProvider>
  </React.StrictMode>,
);
