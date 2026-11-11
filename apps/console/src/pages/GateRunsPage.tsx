import { Link, useParams } from 'react-router-dom';
import { useResource } from '../app/context.tsx';
import { usePageTitle } from '../app/usePageTitle.ts';
import type { Matrix } from '../api/schemas.ts';
import { StatusBadge } from '../components/Status.tsx';
import { Timestamp } from '../components/Timestamp.tsx';
import { EmptyState, PageHeader, ResourceView, Section } from '../components/ui.tsx';
import { LIFECYCLE_CONTENT, VERDICT_CONTENT } from '../content/status-content.ts';

/** Gate runs known to the project matrix. Creating a run is a separate, explicit form. */
export function GateRunsPage() {
  const { projectId = '' } = useParams();
  const { state, reload } = useResource<Matrix>(
    (client, signal) => client.getMatrix(projectId, signal),
    [projectId],
  );
  usePageTitle('Gate runs');
  const base = `/projects/${encodeURIComponent(projectId)}`;
  return (
    <>
      <PageHeader title="Gate runs">
        <Link className="btn btn-primary" to={`${base}/gate-runs/new`}>
          Create gate run
        </Link>
      </PageHeader>
      <ResourceView
        state={state}
        label="gate runs"
        onRetry={reload}
        isEmpty={(m) => m.rows.every((r) => r.gateRunId === null)}
        empty={
          <EmptyState title="No gate runs yet">
            <p>Create a gate run to select an exact subject build, corpus, effect policy, and adapter.</p>
          </EmptyState>
        }
      >
        {(matrix) => (
          <Section title="Recorded gate runs">
            <div
              className="table-scroll"
              role="region"
              aria-label="Gate runs (scrolls horizontally)"
              tabIndex={0}
            >
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Gate run</th>
                    <th scope="col">Revision</th>
                    <th scope="col">Execution state</th>
                    <th scope="col">Verdict</th>
                    <th scope="col">Cases</th>
                    <th scope="col">Last evaluation</th>
                  </tr>
                </thead>
                <tbody>
                  {matrix.rows
                    .filter((r) => r.gateRunId !== null)
                    .map((r) => (
                      <tr key={r.gateRunId}>
                        <th scope="row">
                          <Link
                            className="mono"
                            to={`${base}/gate-runs/${encodeURIComponent(r.gateRunId ?? '')}`}
                          >
                            {r.gateRunId}
                          </Link>
                        </th>
                        <td>{r.revisionLabel}</td>
                        <td>
                          <StatusBadge content={LIFECYCLE_CONTENT[r.lifecycle]} code={r.lifecycle} />
                        </td>
                        <td>
                          <StatusBadge content={VERDICT_CONTENT[r.verdict]} code={r.verdict} />
                        </td>
                        <td className="mono num">{r.counts.total}</td>
                        <td>
                          <Timestamp value={r.evaluatedAt} fallback="Not evaluated" />
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </Section>
        )}
      </ResourceView>
    </>
  );
}
