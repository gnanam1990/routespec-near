import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import { App } from './app/App.tsx';
import { ControlClient, takeTokenFromFragment } from './api/client.ts';
import { trackInputModality } from './app/input-modality.ts';

trackInputModality(document);

const client = new ControlClient();
// The local service opens the console with `#token=<control token>`; it is moved into memory
// and removed from the address bar and history immediately.
client.setToken(takeTokenFromFragment(window.location, window.history));

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <App client={client} />
  </StrictMode>,
);
