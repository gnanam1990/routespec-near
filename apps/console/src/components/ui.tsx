import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type ReactNode,
  type RefObject,
} from 'react';
import { Link } from 'react-router';
import { Icon, type IconName } from './Icon.tsx';
import { Timestamp } from './Timestamp.tsx';
import type { ApiError, FieldError } from '../api/errors.ts';
import type { ResourceState } from '../app/context.tsx';
import { useConsole } from '../app/context.tsx';

/** Icon-only control: accessible name, tooltip, and visible focus (UI-SPEC 5.5). */
export function IconButton({
  icon,
  label,
  ...rest
}: { icon: IconName; label: string } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>) {
  return (
    <button type="button" className="btn-icon" title={label} {...rest}>
      <Icon name={icon} />
      <span className="visually-hidden">{label}</span>
    </button>
  );
}

export function PageHeader({
  title,
  children,
  meta,
}: {
  title: string;
  children?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1 className="h1" tabIndex={-1} data-page-title>
          {title}
        </h1>
        {meta ? <div className="page-meta">{meta}</div> : null}
      </div>
      {children ? <div className="page-actions">{children}</div> : null}
    </header>
  );
}

export function Section({
  title,
  children,
  id,
  actions,
}: {
  title: string;
  children: ReactNode;
  id?: string;
  actions?: ReactNode;
}) {
  const headingId = useId();
  return (
    <section className="section" aria-labelledby={headingId} {...(id ? { id } : {})}>
      <div className="section-head">
        <h2 id={headingId} className="h2">
          {title}
        </h2>
        {actions ? <div className="section-actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function Notice({
  tone,
  icon,
  title,
  children,
  role,
}: {
  tone: 'neutral' | 'review' | 'fail' | 'private';
  icon: IconName;
  title: string;
  children?: ReactNode;
  role?: 'status' | 'alert';
}) {
  return (
    <div className={`notice tone-${tone}`} {...(role ? { role } : {})}>
      <Icon name={icon} size={20} />
      <div>
        <p className="notice-title">{title}</p>
        {children ? <div className="notice-body">{children}</div> : null}
      </div>
    </div>
  );
}

interface ErrorCopy {
  readonly title: string;
  readonly icon: IconName;
  readonly tone: 'neutral' | 'review' | 'fail' | 'private';
  readonly body: string;
}

export function errorCopy(error: ApiError): ErrorCopy {
  switch (error.kind) {
    case 'NETWORK':
    case 'TIMEOUT':
      return {
        title: 'Service disconnected',
        icon: 'disconnected',
        tone: 'review',
        body: `${error.message} Read-only reload tried ${error.attempts} time${error.attempts === 1 ? '' : 's'}.`,
      };
    case 'UNAUTHENTICATED':
      return {
        title: 'Control session required',
        icon: 'identity',
        tone: 'review',
        body: 'Connect with the control token printed by the local service.',
      };
    case 'TOKEN_EXPIRED':
      return {
        title: 'Control token expired',
        icon: 'clock',
        tone: 'review',
        body: 'Start a new control session from the CLI and reconnect.',
      };
    case 'TOKEN_REVOKED':
      return {
        title: 'Control token revoked',
        icon: 'x',
        tone: 'review',
        body: 'This token was revoked. Start a new control session.',
      };
    case 'TOKEN_REUSED':
      return { title: 'Token reuse rejected', icon: 'x', tone: 'review', body: error.message };
    case 'CONCURRENT_CLIENT':
      return { title: 'Concurrent client rejected', icon: 'x', tone: 'review', body: error.message };
    case 'PERMISSION_DENIED':
      return { title: 'Permission denied', icon: 'slash', tone: 'review', body: error.message };
    case 'NOT_FOUND':
      return { title: 'Record not found', icon: 'question', tone: 'neutral', body: error.message };
    case 'UNSUPPORTED_ENDPOINT':
      return {
        title: 'Not provided by this control API revision',
        icon: 'slash',
        tone: 'neutral',
        body: `The local service does not expose ${error.method} ${error.path}. Nothing is shown instead of guessing.`,
      };
    case 'UNSUPPORTED_SCHEMA':
      return { title: 'Unsupported record schema', icon: 'slash', tone: 'review', body: error.message };
    case 'CONFLICT':
      return {
        title: 'Changed by another action',
        icon: 'refresh',
        tone: 'review',
        body: `${error.message} Reload to compare with the newer record.`,
      };
    case 'VALIDATION':
      return { title: 'The request was rejected', icon: 'alert', tone: 'fail', body: error.message };
    case 'POLICY_DENIED':
      return {
        title: 'Safety policy denied the action',
        icon: 'shield',
        tone: 'review',
        body: error.message,
      };
    case 'RECOVERY_MUTATION_DENIED':
      return {
        title: 'Mutation denied during recovery',
        icon: 'shield',
        tone: 'review',
        body: error.message,
      };
    case 'PRIVACY_BLOCKED':
      return {
        title: 'Blocked by secret/privacy scan',
        icon: 'eye-off',
        tone: 'private',
        body: error.message,
      };
    case 'RESOURCE_LIMIT':
      return { title: 'Resource limit exceeded', icon: 'alert', tone: 'review', body: error.message };
    case 'SERVER':
      return { title: 'Service error', icon: 'alert', tone: 'review', body: error.message };
  }
}

/** In-page error with request identity. Never toast-only (UI-SPEC 6.5). */
export function ErrorNotice({ error, onRetry }: { error: ApiError; onRetry?: (() => void) | undefined }) {
  const copy = errorCopy(error);
  const session =
    error.kind === 'UNAUTHENTICATED' || error.kind === 'TOKEN_EXPIRED' || error.kind === 'TOKEN_REVOKED';
  return (
    <Notice tone={copy.tone} icon={copy.icon} title={copy.title} role="alert">
      <p>{copy.body}</p>
      {error.outcomeUnknown ? (
        <p>
          <strong>Outcome unknown.</strong> The request may have been applied. Reload the authoritative
          record; the console does not resend it.
        </p>
      ) : null}
      {error.code || error.requestId ? (
        <p className="mono small">
          {error.code ?? ''} {error.requestId ? `request ${error.requestId}` : ''}
        </p>
      ) : null}
      <div className="notice-actions">
        {session ? (
          <Link className="btn" to="/connect">
            Connect control session
          </Link>
        ) : null}
        {onRetry && !session ? (
          <button type="button" className="btn" onClick={onRetry}>
            <Icon name="refresh" /> Reload (read-only)
          </button>
        ) : null}
      </div>
    </Notice>
  );
}

/**
 * Renders a persisted record through authentic loading/empty/error/stale states (UI-SPEC 9).
 * Skeletons reserve layout and never imply values. After a failure, the last authoritative
 * record stays visible, frozen and labelled stale.
 */
export function ResourceView<T>({
  state,
  label,
  onRetry,
  isEmpty,
  empty,
  skeletonLines = 4,
  children,
}: {
  state: ResourceState<T>;
  label: string;
  onRetry: () => void;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  skeletonLines?: number;
  children: (data: T, meta: { stale: boolean }) => ReactNode;
}) {
  const { connection } = useConsole();
  if (state.data === null) {
    if (state.status === 'loading') {
      return (
        <div className="skeleton" aria-busy="true" role="status" aria-label={`Loading ${label}`}>
          {Array.from({ length: skeletonLines }, (_, i) => (
            <div key={i} className="skeleton-line" />
          ))}
          <span className="visually-hidden">Loading {label} from the local service.</span>
        </div>
      );
    }
    if (state.status === 'error') return <ErrorNotice error={state.error} onRetry={onRetry} />;
    return null;
  }
  const stale = state.status === 'error' || connection === 'DISCONNECTED';
  if (state.status === 'success' && isEmpty?.(state.data)) return <>{empty}</>;
  return (
    <div className={`resource${stale ? ' is-stale' : ''}`} data-stale={stale ? 'true' : 'false'}>
      {stale ? (
        <Notice tone="review" icon="clock" title={`Stale: showing the last ${label} received`} role="status">
          <p>
            Last received <Timestamp value={state.fetchedAt} />. Displayed data is frozen; missing updates are
            not treated as PASS or FAIL.
          </p>
          {state.status === 'error' ? <p>{errorCopy(state.error).title}.</p> : null}
          <div className="notice-actions">
            <button type="button" className="btn" onClick={onRetry}>
              <Icon name="refresh" /> Reload (read-only)
            </button>
          </div>
        </Notice>
      ) : null}
      <p
        className={`muted small refreshing${state.status === 'loading' ? ' is-visible' : ''}`}
        aria-hidden="true"
      >
        Refreshing…
      </p>
      {children(state.data, { stale })}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      <div className="empty-body">{children}</div>
    </div>
  );
}

/** Focusable error summary with links to each invalid control (UI-SPEC 6.4, 8; T-049). */
export const ErrorSummary = forwardRef<
  HTMLDivElement,
  { errors: readonly FieldError[]; fieldIds: Record<string, string>; title?: string }
>(function ErrorSummary({ errors, fieldIds, title = 'Fix the following before submitting' }, ref) {
  if (errors.length === 0) return null;
  return (
    <div ref={ref} className="error-summary" tabIndex={-1} role="alert" aria-labelledby="error-summary-title">
      <h2 id="error-summary-title" className="h3">
        <Icon name="alert" /> {title}
      </h2>
      <ul>
        {errors.map((e) => {
          const target = fieldIds[e.field];
          return (
            <li key={`${e.field}-${e.code}`}>
              {target ? (
                <a
                  href={`#${target}`}
                  onClick={(event) => {
                    event.preventDefault();
                    const el = document.getElementById(target);
                    el?.focus();
                    el?.scrollIntoView({ block: 'center' });
                  }}
                >
                  {e.message}
                </a>
              ) : (
                <span>{e.message}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
});

export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string | undefined;
  children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => ReactNode;
}) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');
  return (
    <div className={`field${error ? ' has-error' : ''}`}>
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      {hint ? (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="field-error">
          <Icon name="alert" /> <span className="visually-hidden">Error: </span>
          {error}
        </p>
      ) : null}
      {children({
        id,
        ...(describedBy ? { 'aria-describedby': describedBy } : {}),
        ...(error ? { 'aria-invalid': true } : {}),
      })}
    </div>
  );
}

/**
 * Modal dialog for bounded decisions: titled, focus trapped, Escape closes when safe, focus
 * restored to the invoking control (UI-SPEC 6.5; T-048).
 */
export function Dialog({
  open,
  title,
  onClose,
  children,
  returnFocus,
  closeOnEscape = true,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  returnFocus: RefObject<HTMLElement | null>;
  closeOnEscape?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const wasOpen = useRef(false);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      dialog.showModal();
      wasOpen.current = true;
      const first = dialog.querySelector<HTMLElement>(
        '[data-autofocus], button, [href], input, select, textarea',
      );
      first?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
    if (!open && wasOpen.current) {
      wasOpen.current = false;
      returnFocus.current?.focus();
    }
  }, [open, returnFocus]);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (closeOnEscape) onClose();
      }}
    >
      <h2 id={titleId} className="h2">
        {title}
      </h2>
      {children}
    </dialog>
  );
}

export function KeyValues({ items }: { items: ReadonlyArray<readonly [string, ReactNode]> }) {
  return (
    <dl className="kv">
      {items.map(([k, v]) => (
        <div key={k} className="kv-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
