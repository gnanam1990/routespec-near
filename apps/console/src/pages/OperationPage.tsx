import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useResource } from '../app/context.tsx';
import { usePageTitle } from '../app/usePageTitle.ts';
import type { Evidence, RunOperation } from '../api/schemas.ts';
import { Digest } from '../components/Digest.tsx';
import { Icon } from '../components/Icon.tsx';
import { StatusBadge } from '../components/Status.tsx';
import { Timestamp } from '../components/Timestamp.tsx';
import { Timeline } from '../components/Timeline.tsx';
import { KeyValues, Notice, PageHeader, ResourceView, Section, ScrollRegion } from '../components/ui.tsx';
import {
  EVIDENCE_CLASS_CONTENT,
  EVIDENCE_REASON_TEXT,
  EVIDENCE_SCOPE_CONTENT,
  VERDICT_CONTENT,
  coverageContent,
} from '../content/status-content.ts';

const PHASES = [
  ['quoteRequest', 'Quote request', 'Immutable request-known fields. No assigned deposit address.'],
  [
    'quoteFinalization',
    'Quote finalization',
    'Atomic: quote identity, constraints, response-assigned deposit address.',
  ],
  [
    'commitBinding',
    'Commit binding',
    'One-time: method/route, material digest, finalized quote, deposit address.',
  ],
] as const;

export function OperationPage() {
  const { projectId = '', runOperationId = '', evidenceId } = useParams();
  usePageTitle('Run operation');
  const navigate = useNavigate();
  const { state, reload } = useResource<RunOperation>(
    (client, signal) => client.getRunOperation(runOperationId, signal),
    [runOperationId],
  );
  const [filter, setFilter] = useState<'all' | 'attention'>('all');
  const lastEvidenceLink = useRef<string | null>(null);
  const opPath = `/projects/${encodeURIComponent(projectId)}/operations/${encodeURIComponent(runOperationId)}`;

  // Closing the evidence drawer returns focus to the link that opened it (UI-SPEC 6.5).
  useEffect(() => {
    if (evidenceId !== undefined) return;
    const id = lastEvidenceLink.current;
    if (id === null) return;
    lastEvidenceLink.current = null;
    document.querySelector<HTMLElement>(`[data-evidence-link="${CSS.escape(id)}"]`)?.focus();
  }, [evidenceId]);

  return (
    <>
      <PageHeader title="Run operation" meta={<span className="mono">{runOperationId}</span>} />
      <ResourceView state={state} label="run operation" onRetry={reload} skeletonLines={10}>
        {(op) => {
          const attention = op.invariants.filter((i) => i.status === 'FAIL' || i.status === 'REVIEW');
          const shown = filter === 'all' ? op.invariants : attention;
          const subjectReports = op.sinkObservations.filter((s) => s.source === 'SUBJECT_REPORTED');
          const boundary = op.sinkObservations.filter((s) => s.source === 'INDEPENDENT_BOUNDARY');
          const selected = evidenceId ? (op.evidence.find((e) => e.evidenceId === evidenceId) ?? null) : null;
          return (
            <div className={`operation-layout${evidenceId ? ' has-drawer' : ''}`}>
              <aside className="summary-rail" aria-label="Operation summary">
                <h2 className="h3">Identity</h2>
                <KeyValues
                  items={[
                    ['Logical job', <span>{op.logicalJobLabel}</span>],
                    ['Logical job digest', <Digest value={op.logicalJobDigest} label="logical job digest" />],
                    ['Run operation', <span className="mono">{op.runOperationId}</span>],
                    ['Binding digest', <Digest value={op.bindingDigest} label="binding digest" />],
                    [
                      'Gate run',
                      <Link
                        className="mono"
                        to={`/projects/${encodeURIComponent(projectId)}/gate-runs/${encodeURIComponent(op.identity.gateRunId)}`}
                      >
                        {op.identity.gateRunId}
                      </Link>,
                    ],
                    [
                      'Case run',
                      <Link
                        className="mono"
                        to={`/projects/${encodeURIComponent(projectId)}/gate-runs/${encodeURIComponent(op.identity.gateRunId)}/cases/${encodeURIComponent(op.identity.caseRunId)}`}
                      >
                        {op.identity.caseRunId}
                      </Link>,
                    ],
                    ['Session', <span className="mono">{op.identity.sessionId}</span>],
                    ['Subject build', <span className="mono">{op.identity.buildRevisionId}</span>],
                    ['Artifact', <Digest value={op.identity.artifactDigest} label="artifact digest" />],
                    ['Adapter', <span className="mono">{op.identity.adapterRevision}</span>],
                    ['Fencing epoch', <span className="mono num">{op.identity.fencingEpoch}</span>],
                    ['Current phase', <span className="mono">{op.currentPhase}</span>],
                    [
                      'Attempts',
                      <span>
                        <span className="mono num">{op.attempts.count}</span>
                        {op.attempts.uncertainty === 'OUTCOME_UNKNOWN' ? ' — outcome unknown' : ''}
                      </span>,
                    ],
                  ]}
                />
                {op.lineage.length > 0 ? (
                  <>
                    <h3 className="h3">Typed lineage</h3>
                    <ul className="plain-list">
                      {op.lineage.map((l) => (
                        <li key={`${l.relation}-${l.runOperationId}`}>
                          <span className="mono small">{l.relation}</span>{' '}
                          <Link
                            className="mono"
                            to={`/projects/${encodeURIComponent(projectId)}/operations/${encodeURIComponent(l.runOperationId)}`}
                          >
                            {l.runOperationId}
                          </Link>
                        </li>
                      ))}
                    </ul>
                    <p className="small muted">
                      Lineage links separate run operations; they never share attempts, evidence, or results.
                    </p>
                  </>
                ) : null}
              </aside>

              <div className="operation-main">
                <Section title="Outcome">
                  <div className="side-by-side">
                    <div>
                      <h3 className="h3">Provider reported</h3>
                      <p>
                        {op.providerReported.rawStatus === null ? (
                          <span className="muted">No provider observation</span>
                        ) : (
                          <code className="mono">{op.providerReported.rawStatus}</code>
                        )}
                        {op.providerReported.rawStatus !== null && !op.providerReported.rawStatusKnown ? (
                          <span>
                            {' '}
                            — unknown raw status, mapped to REVIEW until a reviewed profile maps it
                          </span>
                        ) : null}
                      </p>
                      <p className="small">
                        Normalized fact:{' '}
                        <span className="mono">{op.providerReported.normalizedFact ?? '—'}</span>
                      </p>
                      <p className="small">
                        Observed: <Timestamp value={op.providerReported.observedAt} />
                      </p>
                    </div>
                    <div>
                      <h3 className="h3">Independently evaluated</h3>
                      <p>
                        <StatusBadge
                          content={VERDICT_CONTENT[op.evaluatedOutcome.verdict]}
                          code={op.evaluatedOutcome.verdict}
                        />
                      </p>
                      <p className="small">
                        Evaluated fact: <span className="mono">{op.evaluatedOutcome.fact ?? '—'}</span>
                      </p>
                    </div>
                  </div>
                </Section>

                <Section title="Phases">
                  <ol className="phase-list">
                    {PHASES.map(([key, title, help]) => {
                      const binding = op.phases[key];
                      return (
                        <li key={key} className="phase">
                          <h3 className="h3">{title}</h3>
                          <p className="small muted">{help}</p>
                          <p>
                            State:{' '}
                            <strong>
                              {binding.state === 'BOUND'
                                ? 'Bound'
                                : binding.state === 'ABSENT'
                                  ? 'Not reached'
                                  : 'Rejected conflict'}
                            </strong>
                            {binding.boundAt ? (
                              <>
                                {' '}
                                at <Timestamp value={binding.boundAt} />
                              </>
                            ) : null}
                          </p>
                          {binding.digest ? (
                            <Digest value={binding.digest} label={`${title} digest`} />
                          ) : null}
                          {binding.fields.length > 0 ? (
                            <dl className="kv compact">
                              {binding.fields.map((f) => (
                                <div className="kv-row" key={f.name}>
                                  <dt className="mono">{f.name}</dt>
                                  <dd className="mono">
                                    {f.value}
                                    {f.masked ? <span className="small muted"> (masked)</span> : null}
                                  </dd>
                                </div>
                              ))}
                            </dl>
                          ) : null}
                        </li>
                      );
                    })}
                    <li className="phase">
                      <h3 className="h3">Read-only reconciliation</h3>
                      <p>
                        {op.phases.reconciliation.observations} status observation
                        {op.phases.reconciliation.observations === 1 ? '' : 's'}; last{' '}
                        <Timestamp value={op.phases.reconciliation.lastObservedAt} />
                      </p>
                    </li>
                  </ol>
                  {op.conflicts.length > 0 ? (
                    <>
                      <h3 className="h3">Rejected conflicts</h3>
                      <p className="small">
                        The original binding is unchanged; these attempts were rejected.
                      </p>
                      <ul className="findings">
                        {op.conflicts.map((c, i) => (
                          <li key={`${c.code}-${i}`} className="finding">
                            <StatusBadge
                              content={{ label: 'Rejected', description: '', icon: 'x', tone: 'neutral' }}
                            />
                            <span className="mono small">{c.phase}</span> {c.message}{' '}
                            <code className="mono small">{c.code}</code>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                </Section>

                <Section title="Effect coverage">
                  <p>
                    <StatusBadge content={coverageContent(op.effectCoverage)} />
                  </p>
                  {op.effectCoverage.missing.length > 0 ? (
                    <ul className="missing-list" aria-label="Missing coverage">
                      {op.effectCoverage.missing.map((m) => (
                        <li key={m}>{m}</li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="side-by-side">
                    <SinkTable
                      title="Subject reports"
                      caption="Reported by subject; does not prove coverage."
                      rows={subjectReports}
                    />
                    <SinkTable
                      title="Independent boundary observations"
                      caption="Observed by the independently launched interceptor."
                      rows={boundary}
                    />
                  </div>
                </Section>

                <Section title="Invariants">
                  <div className="toolbar" role="group" aria-label="Invariant filter">
                    <button
                      type="button"
                      className="btn"
                      aria-pressed={filter === 'all'}
                      onClick={() => setFilter('all')}
                    >
                      All
                    </button>
                    <button
                      type="button"
                      className="btn"
                      aria-pressed={filter === 'attention'}
                      onClick={() => setFilter('attention')}
                    >
                      Failures and review
                    </button>
                  </div>
                  <p className="small" role="status">
                    Showing {shown.length} of {op.invariants.length} invariants
                    {filter === 'attention' ? ` (${op.invariants.length - shown.length} hidden)` : ''}.
                  </p>
                  <ScrollRegion label="Invariants (scrolls horizontally)">
                    <table className="table">
                      <thead>
                        <tr>
                          <th scope="col">Invariant</th>
                          <th scope="col">Status</th>
                          <th scope="col">Applicable</th>
                          <th scope="col">Missing predicates</th>
                          <th scope="col">Evidence</th>
                          <th scope="col">Remediation</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shown.map((inv) => (
                          <tr key={inv.invariantId}>
                            <th scope="row">
                              <span className="mono">{inv.invariantId}</span> <span>{inv.title}</span>
                            </th>
                            <td>
                              <StatusBadge content={VERDICT_CONTENT[inv.status]} code={inv.status} />
                            </td>
                            <td>{inv.applicable ? 'Yes' : 'No'}</td>
                            <td>{inv.missingPredicates.join('; ') || '—'}</td>
                            <td>
                              {inv.evidenceIds.map((id) => (
                                <Link
                                  key={id}
                                  className="mono evidence-link"
                                  data-evidence-link={id}
                                  to={`${opPath}/evidence/${encodeURIComponent(id)}`}
                                  onClick={() => {
                                    lastEvidenceLink.current = id;
                                  }}
                                >
                                  {id}
                                </Link>
                              ))}
                            </td>
                            <td className="mono small">{inv.remediationCode ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </ScrollRegion>
                </Section>

                <Section title="Timeline">
                  <Timeline sessionId={op.identity.sessionId} runOperationId={op.runOperationId} />
                </Section>
              </div>

              {evidenceId ? (
                <EvidenceDrawer
                  evidence={selected}
                  evidenceId={evidenceId}
                  onClose={() => navigate(opPath, { state: { restoreFocus: true } })}
                />
              ) : null}
            </div>
          );
        }}
      </ResourceView>
    </>
  );
}

function SinkTable({
  title,
  caption,
  rows,
}: {
  title: string;
  caption: string;
  rows: RunOperation['sinkObservations'];
}) {
  return (
    <div>
      <h3 className="h3">{title}</h3>
      <p className="small muted">{caption}</p>
      {rows.length === 0 ? (
        <p className="muted">None recorded. Absence is not proof of safety.</p>
      ) : (
        <div
          className="table-scroll"
          role="region"
          aria-label={`${title} (scrolls horizontally)`}
          tabIndex={0}
        >
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Seq</th>
                <th scope="col">Sink</th>
                <th scope="col">Effect</th>
                <th scope="col">Action</th>
                <th scope="col">Scope</th>
                <th scope="col">Freshness</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.observationId}>
                  <td className="mono num">{r.sequence}</td>
                  <td>
                    {r.sinkClass}
                    {r.hookId ? <div className="small mono">{r.hookId}</div> : null}
                  </td>
                  <td>{r.effectType}</td>
                  <td className="mono">{r.action}</td>
                  <td className="small">
                    {r.processTreeScope ??
                      (r.interceptorProfileId ? `profile ${r.interceptorProfileId}` : '—')}
                  </td>
                  <td>{r.freshness}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Route-addressable evidence drawer; full-screen sheet on small screens (UI-SPEC 6.5). */
function EvidenceDrawer({
  evidence,
  evidenceId,
  onClose,
}: {
  evidence: Evidence | null;
  evidenceId: string;
  onClose: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [evidenceId]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <aside className="drawer" aria-labelledby="evidence-heading">
      <div className="drawer-head">
        <h2 id="evidence-heading" className="h2" tabIndex={-1} ref={heading} data-route-focus>
          Evidence <span className="mono small">{evidenceId}</span>
        </h2>
        <button type="button" className="btn" onClick={onClose}>
          <Icon name="x" /> Close evidence
        </button>
      </div>
      {evidence === null ? (
        <Notice tone="neutral" icon="question" title="Evidence not part of this run operation" />
      ) : (
        <>
          <p>
            <StatusBadge content={EVIDENCE_CLASS_CONTENT[evidence.class]} code={evidence.class} />{' '}
            <StatusBadge content={EVIDENCE_SCOPE_CONTENT[evidence.scope]} code={evidence.scope} />
          </p>
          {evidence.reasons.length > 0 ? (
            <ul>
              {evidence.reasons.map((r) => (
                <li key={r}>{EVIDENCE_REASON_TEXT[r]}</li>
              ))}
            </ul>
          ) : null}
          <KeyValues
            items={[
              ['Subject', evidence.subject],
              ['Provenance', evidence.provenance],
              ['Observed', <Timestamp value={evidence.observedAt} />],
              ['Collected', <Timestamp value={evidence.collectedAt} />],
              ['Freshness', evidence.freshness],
              ['Digest', <Digest value={evidence.digest} label="evidence digest" />],
              [
                'Redaction',
                evidence.redacted
                  ? 'Redacted; sensitive locators masked and excluded from exports'
                  : 'No redaction',
              ],
            ]}
          />
        </>
      )}
    </aside>
  );
}
