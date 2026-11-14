import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useConsole, useMutation, useResource } from '../app/context.tsx';
import { usePageTitle } from '../app/usePageTitle.ts';
import type { CaseRun, CaseStart, Page, RecoveryResult } from '../api/schemas.ts';
import { Icon } from '../components/Icon.tsx';
import { StatusBadge } from '../components/Status.tsx';
import { Timestamp } from '../components/Timestamp.tsx';
import { Timeline } from '../components/Timeline.tsx';
import {
  Dialog,
  ErrorNotice,
  KeyValues,
  Notice,
  PageHeader,
  ResourceView,
  Section,
} from '../components/ui.tsx';
import {
  LIFECYCLE_CONTENT,
  VERDICT_CONTENT,
  coverageContent,
  evidenceContent,
} from '../content/status-content.ts';
import { CLIENT_STATE_TEXT, LINEAGE_ROLE_TEXT, TOKEN_STATE_TEXT } from '../content/case-content.ts';

/**
 * Isolated case workspace (UI-SPEC 3.2 steps 3–5). Actions are offered only from the persisted
 * case record; the only recovery is the backend-authorized read-only reconciliation.
 */
export function CaseRunPage() {
  const { projectId = '', gateRunId = '', caseRunId = '' } = useParams();
  usePageTitle('Case run');
  const cases = useResource<Page<CaseRun>>(
    (client, signal) => client.listCases(gateRunId, null, signal),
    [gateRunId],
  );
  const startCase = useMutation((client, id: string) => client.startCase(id));
  const recover = useMutation((client, id: string, key: string) =>
    client.recoverCase(id, { idempotencyKey: key }),
  );
  const abort = useMutation((client, id: string) => client.abortCase(id));
  const finish = useMutation((client, id: string) => client.finishCaseInput(id));
  const capture = useMutation((client, id: string) => client.captureCase(id));
  const [recoverOpen, setRecoverOpen] = useState(false);
  const [abortOpen, setAbortOpen] = useState(false);
  const recoverButton = useRef<HTMLButtonElement>(null);
  const abortButton = useRef<HTMLButtonElement>(null);
  const recoveryKey = useRef(globalThis.crypto.randomUUID());
  const [handoff, setHandoff] = useState<CaseStart | null>(null);
  const [recovered, setRecovered] = useState<RecoveryResult | null>(null);
  const base = `/projects/${encodeURIComponent(projectId)}`;

  return (
    <>
      <PageHeader
        title="Case run"
        meta={
          <nav aria-label="Breadcrumb" className="breadcrumb">
            <Link to={`${base}/gate-runs/${encodeURIComponent(gateRunId)}`}>Gate run</Link>
            <Icon name="chevron-right" />
            <span className="mono" aria-current="page">
              {caseRunId}
            </span>
          </nav>
        }
      />
      <ResourceView state={cases.state} label="case run" onRetry={cases.reload} skeletonLines={6}>
        {(page) => {
          const c = page.items.find((item) => item.caseRunId === caseRunId);
          if (!c) {
            return (
              <Notice tone="neutral" icon="question" title="Case run not found in this gate run">
                <p>The gate run does not list this case run.</p>
              </Notice>
            );
          }
          const canStart = c.lifecycle === 'READY' && c.token.state === 'NOT_ISSUED';
          const canRecover = c.recovery?.available === true;
          const canAbort = c.lifecycle === 'RUNNING' && !canRecover;
          const canFinish = c.lifecycle === 'RUNNING' && !canRecover && c.sessionId !== null;
          const canCapture = c.lifecycle === 'COMPLETED';
          return (
            <>
              <Section title={c.scenarioName}>
                <dl className="axis-list case-axes">
                  <div className="axis-row" data-tone={LIFECYCLE_CONTENT[c.lifecycle].tone}>
                    <dt className="axis-name">Execution state</dt>
                    <dd className="axis-value">
                      <StatusBadge content={LIFECYCLE_CONTENT[c.lifecycle]} code={c.lifecycle} />
                    </dd>
                  </div>
                  <div className="axis-row" data-tone={VERDICT_CONTENT[c.verdict].tone}>
                    <dt className="axis-name">Verdict</dt>
                    <dd className="axis-value">
                      <StatusBadge content={VERDICT_CONTENT[c.verdict]} code={c.verdict} />{' '}
                      <span className="small">
                        {c.verdictReason ?? VERDICT_CONTENT[c.verdict].description}
                      </span>
                    </dd>
                  </div>
                  <div className="axis-row" data-tone={evidenceContent(c.evidence).tone}>
                    <dt className="axis-name">Evidence</dt>
                    <dd className="axis-value">
                      <StatusBadge content={evidenceContent(c.evidence)} />
                    </dd>
                  </div>
                  <div className="axis-row" data-tone={coverageContent(c.effectCoverage).tone}>
                    <dt className="axis-name">Effect coverage</dt>
                    <dd className="axis-value">
                      <StatusBadge content={coverageContent(c.effectCoverage)} />
                    </dd>
                  </div>
                </dl>
                <KeyValues
                  items={[
                    ['Lineage role', LINEAGE_ROLE_TEXT[c.lineageRole]],
                    ['Logical job', <span className="mono">{c.logicalJobLabel}</span>],
                    ['Client', CLIENT_STATE_TEXT[c.clientState]],
                    ['Reset', c.resetState],
                    [
                      'Token',
                      `${TOKEN_STATE_TEXT[c.token.state]}${c.token.purpose ? ` (${c.token.purpose})` : ''}`,
                    ],
                    ['Token expiry', <Timestamp value={c.token.expiresAt} fallback="No active token" />],
                    ['Fencing epoch', <span className="mono num">{c.fencingEpoch}</span>],
                    [
                      'Required invariants',
                      <span className="mono">{c.requiredInvariants.join(', ') || 'none'}</span>,
                    ],
                    ['Provenance', c.provenance ?? 'not recorded'],
                  ]}
                />
              </Section>

              {c.lifecycle === 'RECOVERY_REQUIRED' || canRecover ? (
                <Notice tone="review" icon="alert" title="Crash recovery required">
                  <p>
                    The previous runner stopped with epoch {c.fencingEpoch}. The outcome of any in-flight
                    operation is unknown, so no mutation retry is offered.
                  </p>
                </Notice>
              ) : null}

              <Section title="Actions">
                <div className="action-row">
                  {canStart ? (
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={startCase.state.status === 'pending'}
                      onClick={() =>
                        void startCase.submit(c.caseRunId).then((o) => {
                          if (o.kind === 'ok') {
                            setHandoff(o.result.data);
                            cases.reload();
                          }
                        })
                      }
                    >
                      {startCase.state.status === 'pending' ? 'Starting case…' : 'Start isolated case'}
                    </button>
                  ) : null}
                  {canRecover ? (
                    <button
                      ref={recoverButton}
                      type="button"
                      className="btn btn-primary"
                      onClick={() => setRecoverOpen(true)}
                    >
                      Reconcile existing operation
                    </button>
                  ) : null}
                  {canFinish ? (
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={finish.state.status === 'pending'}
                      onClick={() =>
                        void finish.submit(c.caseRunId).then((o) => {
                          if (o.kind === 'ok') {
                            setHandoff(null);
                            cases.reload();
                          }
                        })
                      }
                    >
                      {finish.state.status === 'pending'
                        ? 'Closing input…'
                        : 'Finish case input and evaluate'}
                    </button>
                  ) : null}
                  {canAbort ? (
                    <button
                      ref={abortButton}
                      type="button"
                      className="btn btn-danger"
                      onClick={() => setAbortOpen(true)}
                    >
                      Cancel case
                    </button>
                  ) : null}
                  {canCapture ? (
                    <button
                      type="button"
                      className="btn"
                      disabled={capture.state.status === 'pending'}
                      onClick={() => void capture.submit(c.caseRunId)}
                    >
                      Capture installed trace
                    </button>
                  ) : null}
                  {!canStart && !canRecover && !canAbort && !canCapture && !canFinish ? (
                    <p className="muted">
                      No action is available for this case in its current persisted state.
                    </p>
                  ) : null}
                </div>
                {startCase.state.status === 'error' ? (
                  <ErrorNotice error={startCase.state.error} onRetry={cases.reload} />
                ) : null}
                {recover.state.status === 'error' ? (
                  <ErrorNotice error={recover.state.error} onRetry={cases.reload} />
                ) : null}
                {finish.state.status === 'error' ? (
                  <ErrorNotice error={finish.state.error} onRetry={cases.reload} />
                ) : null}
                {abort.state.status === 'error' ? (
                  <ErrorNotice error={abort.state.error} onRetry={cases.reload} />
                ) : null}
                {capture.state.status === 'error' ? (
                  <ErrorNotice error={capture.state.error} onRetry={cases.reload} />
                ) : null}
                {capture.state.status === 'success' ? (
                  <Notice
                    tone="neutral"
                    icon="archive"
                    title="Installed trace captured as untrusted"
                    role="status"
                  >
                    <p>
                      Capture <span className="mono">{capture.state.result.data.importId}</span> is{' '}
                      {capture.state.result.data.state}.{' '}
                      <Link
                        to={`${base}/regressions/${encodeURIComponent(capture.state.result.data.importId)}`}
                      >
                        Review in the regression library
                      </Link>
                    </p>
                  </Notice>
                ) : null}
              </Section>

              {handoff ? <ClientHandoff handoff={handoff} onDone={() => setHandoff(null)} /> : null}
              {recovered ? <RecoveryHandoff result={recovered} onDone={() => setRecovered(null)} /> : null}

              {c.runOperationIds.length > 0 ? (
                <Section title="Run operations">
                  <ul className="plain-list">
                    {c.runOperationIds.map((op) => (
                      <li key={op}>
                        <Link className="mono" to={`${base}/operations/${encodeURIComponent(op)}`}>
                          {op}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Section>
              ) : null}

              {c.sessionId ? (
                <Section title="Live trace">
                  <Timeline sessionId={c.sessionId} />
                </Section>
              ) : null}

              <Dialog
                open={recoverOpen}
                title="Reconcile existing operation"
                onClose={() => setRecoverOpen(false)}
                returnFocus={recoverButton}
              >
                <p>
                  This read-only recovery, for case <span className="mono">{c.caseRunId}</span>:
                </p>
                <ul>
                  <li>revokes the stale token at epoch {c.fencingEpoch};</li>
                  <li>increments the fencing epoch;</li>
                  <li>issues one RECONCILIATION_ONLY token that can only read status.</li>
                </ul>
                <p>
                  Quote finalization, commit, or any second mutation stays denied. Repeating it returns the
                  same result.
                </p>
                <div className="form-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    data-autofocus
                    disabled={recover.state.status === 'pending'}
                    onClick={() =>
                      void recover.submit(c.caseRunId, recoveryKey.current).then((o) => {
                        setRecoverOpen(false);
                        if (o.kind === 'ok') {
                          setRecovered(o.result.data);
                          cases.reload();
                        }
                      })
                    }
                  >
                    {recover.state.status === 'pending' ? 'Reconciling…' : 'Reconcile (read-only)'}
                  </button>
                  <button type="button" className="btn" onClick={() => setRecoverOpen(false)}>
                    Cancel
                  </button>
                </div>
              </Dialog>
              <Dialog
                open={abortOpen}
                title="Cancel this case?"
                onClose={() => setAbortOpen(false)}
                returnFocus={abortButton}
              >
                <p>
                  Cancelling revokes the case token and stops new proxy exchanges for{' '}
                  <span className="mono">{c.caseRunId}</span>. Evidence is kept. A cancelled required case is
                  incomplete and aggregates to REVIEW, never PASS. This cannot be undone.
                </p>
                <div className="form-actions">
                  <button
                    type="button"
                    className="btn btn-danger"
                    data-autofocus
                    disabled={abort.state.status === 'pending'}
                    onClick={() =>
                      void abort.submit(c.caseRunId).then(() => {
                        setAbortOpen(false);
                        cases.reload();
                      })
                    }
                  >
                    Cancel case and revoke token
                  </button>
                  <button type="button" className="btn" onClick={() => setAbortOpen(false)}>
                    Keep running
                  </button>
                </div>
              </Dialog>
            </>
          );
        }}
      </ResourceView>
    </>
  );
}

function OneTimeToken({ value, label }: { value: string; label: string }) {
  const { announce } = useConsole();
  return (
    <div className="one-time-token">
      <p className="small">{label}. Shown once; it is not stored and disappears when you acknowledge it.</p>
      <code className="mono token-value" data-sensitive="one-time-token">
        {value}
      </code>
      <button
        type="button"
        className="btn"
        onClick={() =>
          void navigator.clipboard?.writeText(value).then(
            () => announce(`${label} copied`),
            () => announce('Copy failed'),
          )
        }
      >
        <Icon name="copy" /> Copy token
      </button>
    </div>
  );
}

function ClientHandoff({ handoff, onDone }: { handoff: CaseStart; onDone: () => void }) {
  return (
    <Section title="Connect client">
      <p>
        RouteSpec assigns the run-operation identity. Retries inside this case reuse it; other builds and
        cases never do. Provider Authorization and all RouteSpec headers are stripped before any live upstream
        boundary.
      </p>
      <KeyValues
        items={[
          ['Proxy base URL', <code className="mono">{handoff.proxyBaseUrl}</code>],
          ['X-RouteSpec-Session', <code className="mono">{handoff.headers.session}</code>],
          ['X-RouteSpec-Case-Run', <code className="mono">{handoff.headers.caseRun}</code>],
          ['X-RouteSpec-Logical-Job', <code className="mono">{handoff.headers.logicalJob}</code>],
          ['X-RouteSpec-Adapter', <code className="mono">{handoff.headers.adapter}</code>],
          ['X-RouteSpec-Fencing-Epoch', <code className="mono">{handoff.headers.fencingEpoch}</code>],
          ['Client instance', <code className="mono">{handoff.clientInstanceId}</code>],
          ['Token expiry', <Timestamp value={handoff.token.expiresAt} />],
        ]}
      />
      <OneTimeToken value={handoff.token.value} label="X-RouteSpec-Case-Token (EXECUTION)" />
      <button type="button" className="btn" onClick={onDone}>
        I have configured the client — hide token
      </button>
    </Section>
  );
}

function RecoveryHandoff({ result, onDone }: { result: RecoveryResult; onDone: () => void }) {
  return (
    <Section title="Recovery issued">
      <Notice tone="neutral" icon="shield" title="Stale token revoked; read-only epoch issued" role="status">
        <p>
          Epoch {result.previousEpoch} → {result.fencingEpoch}. The revoked {result.revokedTokenPurpose} token
          can no longer be used. The new token is RECONCILIATION_ONLY: status reads and evaluation only.
        </p>
      </Notice>
      <KeyValues
        items={[
          ['Fencing epoch', <code className="mono">{result.fencingEpoch}</code>],
          ['Client instance', <code className="mono">{result.clientInstanceId ?? 'not issued'}</code>],
          ['Token expiry', <Timestamp value={result.token.expiresAt} />],
        ]}
      />
      <OneTimeToken value={result.token.value} label="Reconciliation-only case token" />
      <button type="button" className="btn" onClick={onDone}>
        I have configured the client — hide token
      </button>
    </Section>
  );
}
