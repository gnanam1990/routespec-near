import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useResource } from '../app/context.tsx';
import { usePageTitle } from '../app/usePageTitle.ts';
import type { ImportDetail } from '../api/schemas.ts';
import { Digest } from '../components/Digest.tsx';
import { Icon } from '../components/Icon.tsx';
import { StatusBadge } from '../components/Status.tsx';
import {
  Dialog,
  ErrorNotice,
  ErrorSummary,
  KeyValues,
  Notice,
  PageHeader,
  ResourceView,
  Section,
} from '../components/ui.tsx';
import { IMPORT_STATE_CONTENT } from '../content/status-content.ts';

const STAGE_TEXT: Readonly<Record<ImportDetail['lineage'][number]['stage'], string>> = {
  CAPTURE: 'Capture',
  QUARANTINE: 'Quarantine',
  SANITIZE: 'Sanitize',
  MAP: 'Map',
  REPLAY_VERIFICATION: 'Replay verification',
  REVIEW: 'Review',
  PROMOTED_SCENARIO: 'Promoted immutable scenario',
  NEW_CORPUS: 'New corpus',
  CORRECTED_RERUN: 'Corrected installed-client gate run',
};

/** Review workbench and scenario lineage (UI-SPEC 3.4). Promotion is offered only when the server says so. */
export function ImportPage() {
  const { projectId = '', importId = '' } = useParams();
  usePageTitle('Regression review');
  const { state, reload } = useResource<ImportDetail>(
    (client, signal) => client.getImport(importId, signal),
    [importId],
  );
  const verify = useMutation((client, id: string) => client.verifyReplay(id));
  const promote = useMutation((client, id: string, note: string) =>
    client.promoteImport(id, { reviewNote: note }),
  );
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const promoteButton = useRef<HTMLButtonElement>(null);
  const summary = useRef<HTMLDivElement>(null);

  return (
    <>
      <PageHeader
        title="Regression review"
        meta={
          <nav aria-label="Breadcrumb" className="breadcrumb">
            <Link to={`/projects/${encodeURIComponent(projectId)}/regressions`}>Regressions</Link>
            <Icon name="chevron-right" />
            <span className="mono" aria-current="page">
              {importId}
            </span>
          </nav>
        }
      />
      <ResourceView state={state} label="import" onRetry={reload} skeletonLines={8}>
        {(imp) => {
          const fieldIds = Object.fromEntries(imp.blockers.map((b) => [b.field, `review-${b.field}`]));
          return (
            <>
              <ErrorSummary
                ref={summary}
                title="Promotion is blocked until these are resolved"
                errors={imp.blockers.map((b) => ({ field: b.field, code: b.code, message: b.message }))}
                fieldIds={fieldIds}
              />
              <Section title={imp.sanitizedName}>
                <p>
                  <StatusBadge content={IMPORT_STATE_CONTENT[imp.state]} code={imp.state} />
                </p>
                <KeyValues
                  items={[
                    [
                      'Source',
                      imp.origin === 'INSTALLED_ARTIFACT_CAPTURE'
                        ? 'Installed artifact capture'
                        : 'User file',
                    ],
                    [
                      'Source build',
                      <span className="mono">
                        {imp.source?.buildRevisionId ?? 'not an installed capture'}
                      </span>,
                    ],
                    ['Source case', <span className="mono">{imp.source?.caseRunId ?? '—'}</span>],
                    ['Digest', <Digest value={imp.digest} label="import digest" />],
                    ['Secret findings', <span className="mono num">{imp.findings.secret}</span>],
                    [
                      'Nondeterminism findings',
                      <span className="mono num">{imp.findings.nondeterminism}</span>,
                    ],
                    ['Unresolved material', <span className="mono num">{imp.findings.unresolved}</span>],
                  ]}
                />
                {imp.findings.secret > 0 ? (
                  <Notice tone="private" icon="eye-off" title="Secret-bearing content">
                    <p>Only the source digest and safe finding classes are stored. Values are never shown.</p>
                  </Notice>
                ) : null}
                {imp.replayOnlyPass ? (
                  <Notice tone="review" icon="pause" title="Replay-only PASS is insufficient">
                    <p>
                      The corrected installed client must complete the promoted case through a normal gate
                      run.
                    </p>
                  </Notice>
                ) : null}
              </Section>

              <Section title="Scenario lineage">
                <ol className="lineage">
                  {imp.lineage.map((node) => (
                    <li key={node.stage} className={`lineage-node state-${node.state.toLowerCase()}`}>
                      <Icon
                        name={node.state === 'DONE' ? 'check' : node.state === 'BLOCKED' ? 'x' : 'circle'}
                      />
                      <span className="lineage-stage">{STAGE_TEXT[node.stage]}</span>
                      <span className="small">
                        {node.state === 'DONE' ? 'Done' : node.state === 'BLOCKED' ? 'Blocked' : 'Pending'}
                      </span>
                      {node.digest ? (
                        <Digest value={node.digest} label={`${STAGE_TEXT[node.stage]} digest`} />
                      ) : null}
                    </li>
                  ))}
                </ol>
              </Section>

              <Section title="Review workbench">
                <div className="side-by-side">
                  <div id={fieldIds['sourceEvents'] ?? undefined} tabIndex={-1}>
                    <h3 className="h3">Sanitized source events</h3>
                    <ol className="plain-list mono small">
                      {imp.sourceEvents.map((e) => (
                        <li key={e.sequence}>
                          #{e.sequence} {e.summary}
                        </li>
                      ))}
                    </ol>
                  </div>
                  <div id={fieldIds['proposedEvents'] ?? undefined} tabIndex={-1}>
                    <h3 className="h3">Proposed normalized events</h3>
                    <ol className="plain-list mono small">
                      {imp.proposedEvents.map((e) => (
                        <li key={e.sequence}>
                          #{e.sequence} {e.phase ?? '—'} {e.summary}
                        </li>
                      ))}
                    </ol>
                  </div>
                </div>
                {imp.blockers.length > 0 ? (
                  <ul className="blockers">
                    {imp.blockers.map((b) => (
                      <li key={`${b.field}-${b.code}`} id={fieldIds[b.field]} tabIndex={-1}>
                        <strong>{b.field}</strong>: {b.message} <code className="mono small">{b.code}</code>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="action-row">
                  {imp.state === 'MAPPED' ? (
                    <button
                      type="button"
                      className="btn"
                      disabled={verify.state.status === 'pending'}
                      onClick={() => void verify.submit(imp.importId).then(reload)}
                    >
                      Verify deterministic replay
                    </button>
                  ) : null}
                  {imp.promotable ? (
                    <button
                      ref={promoteButton}
                      type="button"
                      className="btn btn-primary"
                      onClick={() => setPromoteOpen(true)}
                    >
                      Promote regression
                    </button>
                  ) : (
                    <p className="muted">
                      Promote is unavailable: the service reports this import is not promotable.
                    </p>
                  )}
                </div>
                {verify.state.status === 'error' ? (
                  <ErrorNotice error={verify.state.error} onRetry={reload} />
                ) : null}
                {promote.state.status === 'error' ? (
                  <ErrorNotice error={promote.state.error} onRetry={reload} />
                ) : null}
              </Section>

              <Dialog
                open={promoteOpen}
                title="Promote to a new immutable scenario?"
                onClose={() => setPromoteOpen(false)}
                returnFocus={promoteButton}
              >
                <p>
                  Promotion creates a new scenario revision and a new corpus revision from{' '}
                  <span className="mono">{imp.importId}</span>. Existing corpora are never edited. The
                  corrected installed client must still pass the new corpus through a normal gate run.
                </p>
                <label className="field-label" htmlFor="promote-note">
                  Review note
                </label>
                <textarea
                  id="promote-note"
                  className="input"
                  rows={3}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                <div className="form-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={promote.state.status === 'pending' || note.trim().length === 0}
                    onClick={() =>
                      void promote.submit(imp.importId, note.trim()).then(() => {
                        setPromoteOpen(false);
                        reload();
                      })
                    }
                  >
                    Promote regression
                  </button>
                  <button type="button" className="btn" onClick={() => setPromoteOpen(false)}>
                    Cancel
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
