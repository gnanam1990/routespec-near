import { useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useConsole, useResource } from '../app/context.tsx';
import { usePageTitle } from '../app/usePageTitle.ts';
import type { FieldError } from '../api/errors.ts';
import type { Page, Project } from '../api/schemas.ts';
import {
  EmptyState,
  ErrorSummary,
  Field,
  Notice,
  PageHeader,
  ResourceView,
  Section,
} from '../components/ui.tsx';

/** Accepts the ephemeral control token. It stays in memory; reloading the page forgets it. */
export function ConnectPage() {
  usePageTitle('Connect');
  const { client, reconnect } = useConsole();
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const summary = useRef<HTMLDivElement>(null);
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim().length < 16) {
      setErrors([
        {
          field: 'controlToken',
          code: 'FORMAT',
          message: 'Paste the full control token printed by the local service.',
        },
      ]);
      window.requestAnimationFrame(() => summary.current?.focus());
      return;
    }
    client.setToken(value.trim());
    setValue('');
    reconnect();
    navigate('/');
  };
  return (
    <>
      <PageHeader title="Connect control session" />
      <ErrorSummary ref={summary} errors={errors} fieldIds={{ controlToken: 'control-token' }} />
      <Notice tone="neutral" icon="identity" title="Local control session">
        <p>
          Start the local service with the CLI and open the printed console link, or paste its control token
          here. The token is kept in this page’s memory only; it is never written to browser storage.
        </p>
      </Notice>
      <form className="form inline-form" noValidate onSubmit={onSubmit} aria-label="Connect control session">
        <Field id="control-token" label="Control token" error={errors[0]?.message}>
          {(props) => (
            <input
              {...props}
              type="password"
              className="input mono"
              autoComplete="off"
              spellCheck={false}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
        </Field>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary">
            Connect
          </button>
        </div>
      </form>
    </>
  );
}

export function ProjectsPage() {
  usePageTitle('Projects');
  const { state, reload } = useResource<Page<Project>>((client, signal) => client.listProjects(signal), []);
  if (state.status === 'success' && state.data.items.length === 1) {
    const only = state.data.items[0];
    if (only) return <Navigate to={`/projects/${encodeURIComponent(only.projectId)}/releases`} replace />;
  }
  return (
    <>
      <PageHeader title="Projects" />
      <ResourceView
        state={state}
        label="projects"
        onRetry={reload}
        isEmpty={(p) => p.items.length === 0}
        empty={
          <EmptyState title="No project configured">
            <p>
              Create a local project with{' '}
              <code className="mono">routespec project create --name &lt;name&gt;</code>.
            </p>
          </EmptyState>
        }
      >
        {(page) => (
          <Section title="Local projects">
            <ul className="plain-list">
              {page.items.map((p) => (
                <li key={p.projectId}>
                  <Link to={`/projects/${encodeURIComponent(p.projectId)}/releases`}>{p.name}</Link>
                  {p.description ? <span className="muted"> — {p.description}</span> : null}
                </li>
              ))}
            </ul>
          </Section>
        )}
      </ResourceView>
    </>
  );
}

export function NotFoundPage() {
  usePageTitle('Not found');
  return (
    <>
      <PageHeader title="Page not found" />
      <p>
        This console route does not exist. <Link to="/">Go to projects</Link>.
      </p>
    </>
  );
}
