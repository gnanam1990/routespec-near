import { Link, useParams, useSearchParams } from 'react-router';
import { useResource } from '../app/context.tsx';
import { usePageTitle } from '../app/usePageTitle.ts';
import type { Matrix, MatrixRow } from '../api/schemas.ts';
import { Digest } from '../components/Digest.tsx';
import { StatusAxisGroup, StatusBadge } from '../components/Status.tsx';
import { Timestamp } from '../components/Timestamp.tsx';
import { EmptyState, KeyValues, Notice, PageHeader, ResourceView, Section } from '../components/ui.tsx';
import {
  COMPATIBILITY_CONTENT,
  ENFORCEMENT_CONTENT,
  LIFECYCLE_CONTENT,
  VERDICT_CONTENT,
  artifactContent,
  attestationContent,
  coverageContent,
  evidenceContent,
} from '../content/status-content.ts';

export function rowKey(row: MatrixRow): string {
  return `${row.revisionId}|${row.buildRevisionId}|${row.corpusRevisionId}|${row.gateRunId ?? 'none'}`;
}

/** Cases with a recorded terminal verdict; used only to describe progress, never a percentage. */
function completedCases(row: MatrixRow): number {
  return row.counts.passed + row.counts.failed + row.counts.review + row.counts.unsupportedRequired;
}

export function ReleasesPage() {
  const { projectId = '' } = useParams();
  const [search, setSearch] = useSearchParams();
  const { state, reload } = useResource<Matrix>(
    (client, signal) => client.getMatrix(projectId, signal),
    [projectId],
  );
  usePageTitle('Releases');
  const selectedKey = search.get('row');

  return (
    <>
      <PageHeader title="Releases" meta={state.data ? <span>{state.data.projectName}</span> : null}>
        <Link className="btn btn-primary" to={`/projects/${encodeURIComponent(projectId)}/gate-runs/new`}>
          Run gate
        </Link>
      </PageHeader>
      <ResourceView
        state={state}
        label="release matrix"
        onRetry={reload}
        isEmpty={(m) => m.rows.length === 0}
        empty={
          <EmptyState title="No revision registered">
            <p>
              Register an integration revision and a subject build first, for example with{' '}
              <code className="mono">
                routespec revision register --project {projectId} --label &lt;label&gt; --config-digest
                &lt;digest&gt;
              </code>
              . No sample metrics are shown.
            </p>
            <p>
              A corpus is created from the{' '}
              <Link to={`/projects/${encodeURIComponent(projectId)}/regressions`}>regression library</Link>{' '}
              and must name exact scenario revision identities.
            </p>
          </EmptyState>
        }
      >
        {(matrix) => {
          const selected = matrix.rows.find((r) => rowKey(r) === selectedKey) ?? matrix.rows[0] ?? null;
          return (
            <>
              {selected ? <GateSummary row={selected} projectId={projectId} /> : null}
              <Section title="Revision matrix">
                <p className="small muted" id="matrix-count">
                  {matrix.rows.length} row{matrix.rows.length === 1 ? '' : 's'}
                  {matrix.nextCursor ? ' (more available)' : ''}. Each row is one exact revision, subject
                  build, corpus, and gate run.
                </p>
                <div
                  className="table-scroll"
                  role="region"
                  aria-label="Revision matrix (scrolls horizontally)"
                  tabIndex={0}
                >
                  <table className="table" aria-describedby="matrix-count">
                    <thead>
                      <tr>
                        <th scope="col">Revision</th>
                        <th scope="col">Subject build</th>
                        <th scope="col">Corpus</th>
                        <th scope="col">Execution state</th>
                        <th scope="col">Verdict</th>
                        <th scope="col">Evidence</th>
                        <th scope="col">Subject identity</th>
                        <th scope="col">Effect coverage</th>
                        <th scope="col">Artifact</th>
                        <th scope="col">Enforcement</th>
                        <th scope="col">Official compatibility</th>
                        <th scope="col">Gate run</th>
                      </tr>
                    </thead>
                    <tbody>
                      {matrix.rows.map((row) => {
                        const key = rowKey(row);
                        const isSelected = selected !== null && rowKey(selected) === key;
                        return (
                          <tr
                            key={key}
                            aria-selected={isSelected}
                            className={isSelected ? 'is-selected' : undefined}
                          >
                            <th scope="row">
                              <button
                                type="button"
                                className="link-button"
                                aria-pressed={isSelected}
                                onClick={() => setSearch({ row: key })}
                              >
                                {row.revisionLabel}
                              </button>
                              <div className="small mono">
                                {row.commitSha ? row.commitSha.slice(0, 12) : 'no commit'}
                              </div>
                            </th>
                            <td>
                              <Digest value={row.artifactDigest} label="artifact digest" />
                            </td>
                            <td>
                              <Digest value={row.corpusDigest} label="corpus digest" />
                              <div className="small">{row.caseCount} cases</div>
                            </td>
                            <td>
                              <StatusBadge content={LIFECYCLE_CONTENT[row.lifecycle]} code={row.lifecycle} />
                            </td>
                            <td>
                              <StatusBadge content={VERDICT_CONTENT[row.verdict]} code={row.verdict} />
                            </td>
                            <td>
                              <StatusBadge content={evidenceContent(row.evidence)} />
                            </td>
                            <td>
                              <StatusBadge content={attestationContent(row.attestation)} />
                            </td>
                            <td>
                              <StatusBadge content={coverageContent(row.effectCoverage)} />
                            </td>
                            <td>
                              <StatusBadge content={artifactContent(row.artifactReady)} />
                            </td>
                            <td>
                              <StatusBadge content={ENFORCEMENT_CONTENT[row.enforcementMode]} />
                            </td>
                            <td>
                              <StatusBadge
                                content={COMPATIBILITY_CONTENT[row.officialCompatibility.status]}
                              />
                            </td>
                            <td>
                              {row.gateRunId ? (
                                <Link
                                  to={`/projects/${encodeURIComponent(projectId)}/gate-runs/${encodeURIComponent(row.gateRunId)}`}
                                >
                                  Open gate run
                                  <span className="visually-hidden"> for {row.revisionLabel}</span>
                                </Link>
                              ) : (
                                <span className="muted">No gate run</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Section>
            </>
          );
        }}
      </ResourceView>
    </>
  );
}

function GateSummary({ row, projectId }: { row: MatrixRow; projectId: string }) {
  const done = completedCases(row);
  return (
    <Section title={`Gate summary — ${row.revisionLabel}`}>
      {row.lifecycle === 'RUNNING' || row.lifecycle === 'EVALUATING' ? (
        <Notice tone="neutral" icon="activity" title="Evaluation in progress" role="status">
          <p>
            {done} of {row.counts.total} cases have a recorded result. Progress is counted from persisted case
            results, not elapsed time.
          </p>
        </Notice>
      ) : null}
      {row.verdict === 'REVIEW' && row.counts.notRun > 0 ? (
        <Notice tone="review" icon="pause" title="Partial result — REVIEW">
          <p>
            {row.counts.notRun} required cases have no complete evaluation. Open the gate run to see which.
          </p>
        </Notice>
      ) : null}
      <div className="summary-grid">
        <StatusAxisGroup axes={row} />
        <div>
          <h3 className="h3">Counts</h3>
          <KeyValues
            items={[
              ['Passed', <span className="mono num">{row.counts.passed}</span>],
              ['Failed', <span className="mono num">{row.counts.failed}</span>],
              ['Review', <span className="mono num">{row.counts.review}</span>],
              ['Unsupported required', <span className="mono num">{row.counts.unsupportedRequired}</span>],
              ['Not run', <span className="mono num">{row.counts.notRun}</span>],
            ]}
          />
          <h3 className="h3">Identity</h3>
          <KeyValues
            items={[
              ['Revision', <span className="mono">{row.revisionId}</span>],
              ['Commit', <span className="mono">{row.commitSha ?? 'none'}</span>],
              ['Subject build', <span className="mono">{row.buildRevisionId}</span>],
              ['Artifact', <Digest value={row.artifactDigest} label="artifact digest" />],
              ['Corpus', <Digest value={row.corpusDigest} label="corpus digest" />],
              ['Last evaluation', <Timestamp value={row.evaluatedAt} fallback="Not evaluated" />],
              ['Evidence observed', <Timestamp value={row.evidenceObservedAt} />],
            ]}
          />
          {row.gateRunId ? (
            <p>
              <Link
                to={`/projects/${encodeURIComponent(projectId)}/gate-runs/${encodeURIComponent(row.gateRunId)}`}
              >
                Inspect cases for this gate run
              </Link>
            </p>
          ) : null}
        </div>
      </div>
    </Section>
  );
}
