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
import { createSnapshotFetch, parseDemoSnapshot } from './api/static-demo.ts';
import { trackInputModality } from './app/input-modality.ts';

trackInputModality(document);

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
// Router basename from the build's base path ('/' for the console the local service serves).
const basename = import.meta.env.BASE_URL.replace(/\/$/, '');

if (import.meta.env['VITE_ROUTESPEC_DEMO'] === '1') {
  // Static read-only demo (M54): records come from a snapshot recorded from the real control API
  // over a contained run; there is no service, no token, and no mutation.
  // A deep link that reached the site's root 404 page arrives as `?route=<path>` (see the demo
  // build's root fallback); put it back into the address bar before the router reads it.
  const route = new URLSearchParams(window.location.search).get('route');
  // Only a path below the demo's base is accepted (never another origin or a scheme).
  if (route !== null && /^[A-Za-z0-9._~%/?=&-]*$/.test(route) && !route.startsWith('/')) {
    window.history.replaceState(null, '', `${import.meta.env.BASE_URL}${route}`);
  }
  void (async () => {
    const response = await fetch(`${import.meta.env.BASE_URL}demo/snapshot.json`, { cache: 'no-store' });
    const snapshot = parseDemoSnapshot(await response.json());
    const client = new ControlClient({ fetchImpl: createSnapshotFetch(snapshot), readAttempts: 1 });
    client.setToken('read-only-demo');
    createRoot(root).render(
      <StrictMode>
        <App client={client} basename={basename} demo={snapshot.source} />
      </StrictMode>,
    );
  })();
} else {
  const client = new ControlClient();
  // The local service opens the console with `#token=<control token>`; it is moved into memory
  // and removed from the address bar and history immediately.
  client.setToken(takeTokenFromFragment(window.location, window.history));
  createRoot(root).render(
    <StrictMode>
      <App client={client} basename={basename} />
    </StrictMode>,
  );
}
