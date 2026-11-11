import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, matchPath, useLocation, useNavigate } from 'react-router-dom';
import { Icon, type IconName } from '../components/Icon.tsx';
import { useConsole, useResource } from './context.tsx';
import type { Page, Project } from '../api/schemas.ts';
import { useTheme, type ThemeChoice } from './theme.ts';

interface NavItem {
  readonly label: string;
  readonly icon: IconName;
  readonly to: (projectId: string | null) => string | null;
}

const NAV: readonly NavItem[] = [
  { label: 'Releases', icon: 'layers', to: (p) => (p ? `/projects/${p}/releases` : null) },
  { label: 'Gate runs', icon: 'play', to: (p) => (p ? `/projects/${p}/gate-runs` : null) },
  { label: 'Operations', icon: 'activity', to: (p) => (p ? `/projects/${p}/operations` : null) },
  { label: 'Regressions', icon: 'archive', to: (p) => (p ? `/projects/${p}/regressions` : null) },
  { label: 'Safety & Settings', icon: 'settings', to: () => '/settings' },
];

const CONNECTION_TEXT = {
  CONNECTED: { label: 'Local service connected', icon: 'check', tone: 'neutral' },
  DISCONNECTED: { label: 'Service disconnected — data stale', icon: 'disconnected', tone: 'review' },
  UNAUTHENTICATED: { label: 'Control session required', icon: 'identity', tone: 'review' },
  UNKNOWN: { label: 'Connecting to local service', icon: 'clock', tone: 'neutral' },
} as const;

export function useCurrentProjectId(): string | null {
  const location = useLocation();
  const match = matchPath({ path: '/projects/:projectId/*' }, location.pathname);
  return match?.params['projectId'] ?? null;
}

export function Shell({ children }: { children: ReactNode }) {
  const { connection, reconnect, announcement } = useConsole();
  const projectId = useCurrentProjectId();
  const navigate = useNavigate();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const { choice, setChoice } = useTheme();
  const mainRef = useRef<HTMLElement>(null);
  const projects = useResource<Page<Project>>((client, signal) => client.listProjects(signal), []);

  // Move focus to the page title on route change so keyboard and screen-reader users land
  // in the new view (browser Back restores the URL state, including filters in the query).
  const first = useRef(true);
  useEffect(() => {
    setNavOpen(false);
    if (first.current) {
      first.current = false;
      return;
    }
    // A page that restores focus to its invoking control (drawer close) asks the shell not to move it.
    const routeState = location.state as { restoreFocus?: boolean } | null;
    if (routeState?.restoreFocus) return;
    // A route-addressable panel (for example the evidence drawer) takes focus over the title.
    const target =
      document.querySelector<HTMLElement>('[data-route-focus]') ??
      document.querySelector<HTMLElement>('[data-page-title]');
    target?.focus({ preventScroll: false });
  }, [location.pathname]);

  const conn = CONNECTION_TEXT[connection];
  const projectList = projects.state.data?.items ?? [];

  return (
    <div className="app" data-nav-open={navOpen ? 'true' : 'false'}>
      <a
        className="skip-link"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          mainRef.current?.focus();
        }}
      >
        Skip to main content
      </a>
      <header className="app-header">
        <button
          type="button"
          className="btn-icon nav-toggle"
          aria-expanded={navOpen}
          aria-controls="primary-nav"
          title={navOpen ? 'Close navigation' : 'Open navigation'}
          onClick={() => setNavOpen((v) => !v)}
        >
          <Icon name="menu" />
          <span className="visually-hidden">{navOpen ? 'Close navigation' : 'Open navigation'}</span>
        </button>
        <span className="brand">RouteSpec</span>
        <span className="badge tone-neutral local-badge">
          <Icon name="shield" /> <span className="badge-label">Local only</span>
        </span>
        <label className="project-select">
          <span className="visually-hidden">Current project</span>
          <span aria-hidden="true" className="small muted">
            Project
          </span>
          <select
            value={projectId ?? ''}
            onChange={(event) => {
              const next = event.target.value;
              if (next) navigate(`/projects/${encodeURIComponent(next)}/releases`);
            }}
          >
            <option value="">
              {projects.state.status === 'loading' ? 'Loading projects…' : 'Select a project'}
            </option>
            {projectList.map((p) => (
              <option key={p.projectId} value={p.projectId}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="header-end">
          <span className={`badge tone-${conn.tone} connection`} data-connection={connection}>
            <Icon name={conn.icon} /> <span className="badge-label">{conn.label}</span>
          </span>
          {connection === 'DISCONNECTED' ? (
            <button type="button" className="btn" onClick={reconnect}>
              <Icon name="refresh" /> Reconnect
            </button>
          ) : null}
          <label className="theme-select">
            <span className="visually-hidden">Color theme</span>
            <select value={choice} onChange={(e) => setChoice(e.target.value as ThemeChoice)}>
              <option value="system">System theme</option>
              <option value="light">Light theme</option>
              <option value="dark">Dark theme</option>
            </select>
          </label>
        </div>
      </header>
      {connection === 'DISCONNECTED' ? (
        <div className="global-banner tone-review" role="status">
          <Icon name="disconnected" /> The local service is not reachable. Displayed records are frozen and
          marked stale. Missing updates are never shown as PASS or FAIL.
        </div>
      ) : null}
      <nav id="primary-nav" className="app-nav" aria-label="Primary">
        <ul>
          {NAV.map((item) => {
            const to = item.to(projectId);
            return (
              <li key={item.label}>
                {to === null ? (
                  <span className="nav-link is-disabled" aria-disabled="true">
                    <Icon name={item.icon} /> <span>{item.label}</span>
                    <span className="visually-hidden"> (select a project first)</span>
                  </span>
                ) : (
                  <NavLink className="nav-link" to={to} end={false}>
                    <Icon name={item.icon} /> <span>{item.label}</span>
                  </NavLink>
                )}
              </li>
            );
          })}
        </ul>
      </nav>
      <main id="main" ref={mainRef} tabIndex={-1} className="app-main">
        {children}
      </main>
      <div
        className="visually-hidden"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="announcer"
      >
        {announcement}
      </div>
    </div>
  );
}
