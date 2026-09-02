import React from 'react';
import ReactDOM from 'react-dom/client';
import { detectPlatform } from '@atlas/platform';
import { detectStorage } from '@atlas/data';
import { AtlasApp } from './app/AtlasApp';
import { ThemeProvider } from './app/theme';
import { EffectsProvider } from './app/effects';
import '@atlas/tokens/tokens.css';
import './styles/index.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

// The one place the runtime is decided. Everything above this line is written
// against the Platform port and never learns whether it's in a window or a tab.
const platform = detectPlatform();
const storage = detectStorage(platform.id);

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <ThemeProvider>
      <EffectsProvider>
        <AtlasApp platform={platform} storage={storage} />
      </EffectsProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
