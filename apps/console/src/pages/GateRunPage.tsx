import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useResource } from '../app/context.tsx';
import { usePageTitle } from '../app/usePageTitle.ts';
import type { CaseRun, ExportPlan, GateRun, Page } from '../api/schemas.ts';
import { Digest } from '../components/Digest.tsx';
import { StatusAxisGroup, StatusBadge } from '../components/Status.tsx';
import { ErrorNotice, KeyValues, Notice, PageHeader, ResourceView, Section } from '../components/ui.tsx';
import {
  LIFECYCLE_CONTENT,
  VERDICT_CONTENT,
  coverageContent,
  evidenceContent,
} from '../content/status-content.ts';
import { LINEAGE_ROLE_TEXT, TOKEN_STATE_TEXT, CLIENT_STATE_TEXT } from '../content/case-content.ts';

export function GateRunPage() {
  const { projectId = '', gateRunId = '' } = useParams();
  const gate = useResource<GateRun>((client, signal) => client.getGateRun(gateRunId, signal), [gateRunId]);
  const cases = useResource<Page<CaseRun>>(
    (client, signal) => client.listCases(gateRunId, null, signal),
    [gateRunId],
  );
  const validate = useMutation((client, id: string, rev: number) =>
    client.validateGateRun(id, { expectedRevision: rev }),
  );
  const start = useMutation((client, id: string, rev: number) =>
    client.startGateRun(id, { expectedRevision: rev }),
  );
  const evaluate = useMutation((client, gateId: string, id: string) => client.evaluateGate(gateId, id));
  const plan = useMutation((client, gateEvaluationId: string, use: 'RELEASE_EVIDENCE' | 'DIAGNOSTIC_ONLY') =>
    client.planExport(gateEvaluationId, use),
  );
  const [exportUse, setExportUse] = useState<'RELEASE_EVIDENCE' | 'DIAGNOSTIC_ONLY'>('RELEASE_EVIDENCE');
  usePageTitle('Gate run');
  const base = `/projects/${encodeURIComponent(projectId)}`;

  const after = (outcome: { kind: string }) => {
    if (outcome.kind === 'ok') {
      gate.reload();
      cases.reload();
    }
  };

  return (
    <>
      <PageHeader title="Gate run" meta={<span className="mono">{gateRunId}</span>}>
        {gate.state.data?.lifecycle === 'DRAFT' ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={validate.state.status === 'pending'}
            onClick={() => {
              const g = gate.state.data;
              if (g) void validate.submit(g.gateRunId, g.revision).then(after);
            }}
          >
            {validate.state.status === 'pending' ? 'Validating…' : 'Validate preflight'}
          </button>
        ) : null}
        {gate.state.data?.lifecycle === 'READY' ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={start.state.status === 'pending'}
            onClick={() => {
              const g = gate.state.data;
              if (g) void start.submit(g.gateRunId, g.revision).then(after);
            }}
          >
            {start.state.status === 'pending' ? 'Starting…' : 'Start gate run'}
          </button>
        ) : null}
        {gate.state.data?.gateId &&
        ['RUNNING', 'EVALUATING', 'RECOVERY_REQUIRED', 'COMPLETED'].includes(gate.state.data.lifecycle) ? (
          <button
            type="button"
            className="btn"
            disabled={evaluate.state.status === 'pending'}
            onClick={() => {
              const g = gate.state.data;
              if (g?.gateId) void evaluate.submit(g.gateId, g.gateRunId).then(after);
            }}
          >
            {evaluate.state.status === 'pending' ? 'Evaluating…' : 'Evaluate gate'}
          </button>
        ) : null}
      </PageHeader>
      {evaluate.state.status === 'error' ? (
        <ErrorNotice error={evaluate.state.error} onRetry={gate.reload} />
      ) : null}
      {evaluate.state.status === 'success' ? (
        <Notice tone="neutral" icon="info" title="Gate evaluation recorded" role="status">
          <p>
            A new immutable evaluation was recorded by the service. The status below is read back from it; it
            is advisory and does not block a release.
          </p>
        </Notice>
      ) : null}
      {validate.state.status === 'error' ? (
        <ErrorNotice error={validate.state.error} onRetry={gate.reload} />
      ) : null}
      {start.state.status === 'error' ? (
        <ErrorNotice error={start.state.error} onRetry={gate.reload} />
      ) : null}
      <ResourceView state={gate.state} label="gate run" onRetry={gate.reload} skeletonLines={8}>
        {(g) => (
          <>
            {g.effectCoverage.basis === 'DECLARED_HOOKS_ONLY' ? (
              <Notice tone="review" icon="pause" title="Diagnostic run: declared hooks only">
                <p>
                  Complete-effect predicates for this gate run evaluate REVIEW. Subject hooks do not prove
                  coverage.
                </p>
              </Notice>
            ) : null}
            <div className="summary-grid">
              <StatusAxisGroup axes={g} title="Gate status" />
              <div>
                <h3 className="h3">Bounded parallelism</h3>
                <KeyValues
                  items={[
                    ['Declared', <span className="mono num">{g.parallelism.declared}</span>],
                    ['Running', <span className="mono num">{g.parallelism.running}</span>],
                    ['Queued (waiting for a slot)', <span className="mono num">{g.parallelism.queued}</span>],
                    ['Mode', <span className="mono">{g.mode}</span>],
                  ]}
                />
                <h3 className="h3">Counts</h3>
                <KeyValues
                  items={[
                    ['Cases', <span className="mono num">{g.counts.total}</span>],
                    ['Passed', <span className="mono num">{g.counts.passed}</span>],
                    ['Failed', <span className="mono num">{g.counts.failed}</span>],
                    ['Review', <span className="mono num">{g.counts.review}</span>],
                    [
                      'Unsupported required',
                      <span className="mono num">{g.counts.unsupportedRequired}</span>,
                    ],
                    ['Not run', <span className="mono num">{g.counts.notRun}</span>],
                  ]}
                />
              </div>
            </div>
            {g.findings.length > 0 ? (
              <Section title="Findings">
                <ul className="findings">
                  {g.findings.map((f, i) => (
                    <li key={`${f.code}-${i}`} className={`finding level-${f.level.toLowerCase()}`}>
                      <StatusBadge
                        content={
                          f.level === 'FAIL'
                            ? VERDICT_CONTENT.FAIL
                            : f.level === 'REVIEW'
                              ? VERDICT_CONTENT.REVIEW
                              : { label: 'Info', description: '', icon: 'info', tone: 'neutral' }
                        }
                      />
                      <span>{f.message}</span> <code className="mono small">{f.code}</code>
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}
            <Section title="Export">
              {g.gateEvaluationId ? (
                <>
                  <p>
                    Plan a redacted evidence bundle for evaluation{' '}
                    <span className="mono">{g.gateEvaluationId}</span>. Planning runs the privacy scan and
                    writes nothing; writing the file needs a separate local confirmation.
                  </p>
                  <label className="field-label" htmlFor="export-evidence-use">
                    Bundle use
                  </label>
                  <select
                    id="export-evidence-use"
                    className="input"
                    value={exportUse}
                    onChange={(e) => setExportUse(e.target.value as typeof exportUse)}
                  >
                    <option value="RELEASE_EVIDENCE">
                      Release evidence (refused if a capture is diagnostic only)
                    </option>
                    <option value="DIAGNOSTIC_ONLY">Diagnostic only</option>
                  </select>
                  <button
                    type="button"
                    className="btn"
                    disabled={plan.state.status === 'pending'}
                    onClick={() => void plan.submit(g.gateEvaluationId as string, exportUse)}
                  >
                    {plan.state.status === 'pending' ? 'Planning export…' : 'Plan export'}
                  </button>
                  {plan.state.status === 'error' ? (
                    <ErrorNotice error={plan.state.error} onRetry={gate.reload} />
                  ) : null}
                  {plan.state.status === 'success' ? <ExportPlanView plan={plan.state.result.data} /> : null}
                </>
              ) : (
                <p className="muted">Export becomes available after the service records a gate evaluation.</p>
              )}
            </Section>
            <Section title="Identity">
              <KeyValues
                items={[
                  ['Repository', <span>{g.identity.repository ?? 'not recorded'}</span>],
                  ['Commit', <span className="mono">{g.identity.commitSha ?? 'none'}</span>],
                  [
                    'Dirty-tree digest',
                    <Digest value={g.identity.dirtyTreeDigest} label="dirty-tree digest" />,
                  ],
                  ['Subject build', <span className="mono">{g.identity.buildRevisionId}</span>],
                  ['Artifact', <Digest value={g.identity.artifactDigest} label="artifact digest" />],
                  [
                    'Effect policy',
                    <Digest value={g.identity.effectPolicyDigest} label="effect policy digest" />,
                  ],
                  [
                    'Effect manifest',
                    <Digest value={g.identity.effectManifestDigest} label="effect manifest digest" />,
                  ],
                  [
                    'Call-site inventory',
                    <Digest value={g.identity.callSiteInventoryDigest} label="call-site inventory digest" />,
                  ],
                  [
                    'Interceptor profile',
                    <Digest value={g.identity.interceptorProfileDigest} label="interceptor profile digest" />,
                  ],
                  ['Corpus', <Digest value={g.identity.corpusDigest} label="corpus digest" />],
                  ['Evaluator', <span className="mono">{g.identity.evaluatorRevision}</span>],
                  ['Adapter', <span className="mono">{g.identity.adapterRevision}</span>],
                  ['Protocol profile', <span className="mono">{g.identity.protocolProfileId}</span>],
                  [
                    'Configuration',
                    <Digest value={g.identity.configurationDigest} label="configuration digest" />,
                  ],
                  ['Workflow run', <span className="mono">{g.identity.workflowRunId ?? 'none'}</span>],
                  ['App revision', <span className="mono">{g.identity.appRevision}</span>],
                ]}
              />
            </Section>
          </>
        )}
      </ResourceView>
      <Section title="Case runs">
        <ResourceView
          state={cases.state}
          label="case runs"
          onRetry={cases.reload}
          isEmpty={(p) => p.items.length === 0}
          empty={<p className="muted">This gate run has no case runs.</p>}
        >
          {(page) => (
            <>
              <p className="small muted" id="cases-count">
                {page.total} isolated case run{page.total === 1 ? '' : 's'}, in corpus order. Cases with the
                same logical job stay isolated.
              </p>
              <div
                className="table-scroll"
                role="region"
                aria-label="Case runs (scrolls horizontally)"
                tabIndex={0}
              >
                <table className="table" aria-describedby="cases-count">
                  <thead>
                    <tr>
                      <th scope="col">#</th>
                      <th scope="col">Scenario</th>
                      <th scope="col">Lineage role</th>
                      <th scope="col">Execution state</th>
                      <th scope="col">Verdict</th>
                      <th scope="col">Evidence</th>
                      <th scope="col">Effect coverage</th>
                      <th scope="col">Client / reset</th>
                      <th scope="col">Token</th>
                      <th scope="col">Epoch</th>
                      <th scope="col">Required invariants</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((c) => (
                      <tr key={c.caseRunId} data-case={c.caseRunId}>
                        <td className="mono num">{c.ordinal}</td>
                        <th scope="row">
                          <Link
                            to={`${base}/gate-runs/${encodeURIComponent(gateRunId)}/cases/${encodeURIComponent(c.caseRunId)}`}
                          >
                            {c.scenarioName}
                          </Link>
                          <div className="small mono">{c.logicalJobLabel}</div>
                        </th>
                        <td>{LINEAGE_ROLE_TEXT[c.lineageRole]}</td>
                        <td>
                          <StatusBadge content={LIFECYCLE_CONTENT[c.lifecycle]} code={c.lifecycle} />
                          {c.queuePosition !== null ? (
                            <div className="small">Queued, position {c.queuePosition}</div>
                          ) : null}
                        </td>
                        <td>
                          <StatusBadge content={VERDICT_CONTENT[c.verdict]} code={c.verdict} />
                        </td>
                        <td>
                          <StatusBadge content={evidenceContent(c.evidence)} />
                        </td>
                        <td>
                          <StatusBadge content={coverageContent(c.effectCoverage)} />
                        </td>
                        <td>
                          {CLIENT_STATE_TEXT[c.clientState]}
                          <div className="small">Reset: {c.resetState.toLowerCase()}</div>
                        </td>
                        <td>
                          {TOKEN_STATE_TEXT[c.token.state]}
                          {c.token.purpose ? <div className="small mono">{c.token.purpose}</div> : null}
                        </td>
                        <td className="mono num">{c.fencingEpoch}</td>
                        <td className="mono small">{c.requiredInvariants.join(', ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </ResourceView>
      </Section>
    </>
  );
}

function ExportPlanView({ plan }: { plan: ExportPlan }) {
  return (
    <div role="status" className="export-plan">
      <h3 className="h3">Export plan {plan.blocked ? '(blocked by the privacy scan)' : ''}</h3>
      <KeyValues
        items={[
          ['Plan', <span className="mono">{plan.exportId}</span>],
          ['Bundle use', <span className="mono">{plan.evidenceUse ?? 'RELEASE_EVIDENCE'}</span>],
          ['Privacy scan', <span className="mono">{plan.privacyScanResult}</span>],
          ['Plan digest', <Digest value={plan.planDigest} label="export plan digest" />],
          ['Bundle digest', <Digest value={plan.bundleDigest} label="bundle digest" />],
          ['Bundle size', <span className="mono num">{plan.bundleBytes ?? 0} bytes</span>],
          ['Entries', <span className="mono num">{plan.entries.length}</span>],
          ['Declared exclusions', <span>{plan.exclusions.join('; ') || 'none'}</span>],
          ['Written', 'No. Write it with the CLI or API after confirming the plan digest.'],
        ]}
      />
    </div>
  );
}
