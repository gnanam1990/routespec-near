import { useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { useConsole, useMutation, useResource } from '../app/context.tsx';
import { usePageTitle } from '../app/usePageTitle.ts';
import type { ApiError, FieldError } from '../api/errors.ts';
import type { ImportDetail, ProposedMapping } from '../api/schemas.ts';
import { Digest } from '../components/Digest.tsx';
import { Icon } from '../components/Icon.tsx';
import { StatusBadge } from '../components/Status.tsx';
import {
  Dialog,
  ErrorNotice,
  ErrorSummary,
  Field,
  KeyValues,
  Notice,
  PageHeader,
  ResourceView,
  Section,
  ScrollRegion,
} from '../components/ui.tsx';
import { IMPORT_STATE_CONTENT, VERDICT_CONTENT } from '../content/status-content.ts';
import { LINEAGE_ROLE_TEXT } from '../content/case-content.ts';
import { EVIDENCE_USE_TEXT, refusalText } from '../content/evidence-content.ts';

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

const DECISION_TEXT: Readonly<Record<string, string>> = {
  REDACTIONS_APPROVED: 'Redactions are correct and no secret material remains',
  SOURCE_BINDING_APPROVED: 'The source build, gate run, case, and session binding is correct',
  OPERATION_LINEAGE_APPROVED: 'The run-operation phases and lineage are correct',
  EXPECTED_TERMINAL_APPROVED: 'The expected terminal outcome is correct',
  FORBIDDEN_BEHAVIORS_APPROVED: 'The forbidden behaviours are correct',
  EVIDENCE_LIMITS_APPROVED: 'The evidence limits (visibility, scope) are correct',
  EFFECT_COVERAGE_APPROVED: 'The required effect sinks and coverage limitations are correct',
  PROVENANCE_APPROVED: 'The provenance class is correct',
};

const REGRESSION_STATUS_TEXT: Readonly<Record<NonNullable<ImportDetail['regressionStatus']>, string>> = {
  IN_QUARANTINE: 'In quarantine — not a regression yet',
  REJECTED: 'Rejected',
  PROMOTED_AWAITING_CORRECTED_RUN: 'Promoted — awaiting a corrected installed-client run',
  CORRECTED_RUN_NOT_PASSING: 'Corrected installed-client run recorded, not passing',
  CORRECTED_RUN_PASSED: 'Corrected installed-client run passed the promoted case',
};

/**
 * Review workbench and scenario lineage (UI-SPEC 3.4). Every step is a server mutation on the
 * import's current revision; the console re-reads the import after each one. Promotion is
 * offered only when the service reports the import promotable.
 */
export function ImportPage() {
  const { projectId = '', importId = '' } = useParams();
  usePageTitle('Regression review');
  const { client } = useConsole();
  const { state, reload } = useResource<ImportDetail>(
    (c, signal) => c.getImport(importId, signal),
    [importId],
  );
  const [proposal, setProposal] = useState<ProposedMapping | null>(null);
  const [proposalError, setProposalError] = useState<ApiError | null>(null);
  const saveMapping = useMutation((c, id: string, mapping: unknown, rev: number) =>
    c.saveMapping(id, mapping, { expectedRevision: rev }),
  );
  const verify = useMutation((c, id: string, rev: number) => c.verifyReplay(id, { expectedRevision: rev }));
  const promote = useMutation((c, id: string, rev: number, input: Parameters<typeof c.promoteImport>[1]) =>
    c.promoteImport(id, input, { expectedRevision: rev }),
  );
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [corpusLabel, setCorpusLabel] = useState('');
  const [severity, setSeverity] = useState<'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'>('HIGH');
  const [evidenceUse, setEvidenceUse] = useState<'RELEASE_EVIDENCE' | 'DIAGNOSTIC_ONLY' | null>(null);
  const promoteButton = useRef<HTMLButtonElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  const base = `/projects/${encodeURIComponent(projectId)}`;

  const loadProposal = async () => {
    setProposalError(null);
    try {
      setProposal(await client.getProposedMapping(importId));
    } catch (error) {
      setProposalError(error as ApiError);
    }
  };

  return (
    <>
      <PageHeader
        title="Regression review"
        meta={
          <nav aria-label="Breadcrumb" className="breadcrumb">
            <Link to={`${base}/regressions`}>Regressions</Link>
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
          const promotion = imp.promotion ?? null;
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
                    ['Revision', <span className="mono num">{imp.revision}</span>],
                    ['Secret findings', <span className="mono num">{imp.findings.secret}</span>],
                    [
                      'Nondeterminism findings',
                      <span className="mono num">{imp.findings.nondeterminism}</span>,
                    ],
                    ['Unresolved material', <span className="mono num">{imp.findings.unresolved}</span>],
                    [
                      'Regression status',
                      imp.regressionStatus ? REGRESSION_STATUS_TEXT[imp.regressionStatus] : 'not reported',
                    ],
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
                {promotion ? (
                  <div className="lineage-links">
                    <KeyValues
                      items={[
                        ['Promoted scenario', <span className="mono">{promotion.scenarioRevisionId}</span>],
                        ['New corpus', <span className="mono">{promotion.corpusRevisionId}</span>],
                        [
                          'Evidence use',
                          <span data-evidence-use={promotion.evidenceUse ?? 'UNCLASSIFIED'}>
                            {EVIDENCE_USE_TEXT[promotion.evidenceUse ?? 'UNCLASSIFIED']}
                          </span>,
                        ],
                      ]}
                    />
                    <p>
                      <Link
                        className="btn"
                        to={`${base}/gate-runs/new?corpusRevisionId=${encodeURIComponent(promotion.corpusRevisionId)}`}
                      >
                        Run the corrected client against the new corpus
                      </Link>
                    </p>
                    {(imp.correctedRuns ?? []).length > 0 ? (
                      <ScrollRegion label="Corrected runs">
                        <table className="table">
                          <caption className="visually-hidden">Corrected installed-client case runs</caption>
                          <thead>
                            <tr>
                              <th scope="col">Gate run</th>
                              <th scope="col">Build</th>
                              <th scope="col">Lineage role</th>
                              <th scope="col">Execution state</th>
                              <th scope="col">Verdict</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(imp.correctedRuns ?? []).map((r) => (
                              <tr key={r.caseRunId}>
                                <th scope="row">
                                  <Link
                                    className="mono"
                                    to={`${base}/gate-runs/${encodeURIComponent(r.gateRunId)}`}
                                  >
                                    {r.gateRunId}
                                  </Link>
                                </th>
                                <td className="mono">{r.buildRevisionId}</td>
                                <td>{LINEAGE_ROLE_TEXT[r.lineageRole]}</td>
                                <td className="mono">{r.lifecycle}</td>
                                <td>
                                  <StatusBadge
                                    content={VERDICT_CONTENT[r.verdict ?? 'NOT_RUN']}
                                    code={r.verdict ?? 'NOT_RUN'}
                                  />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </ScrollRegion>
                    ) : null}
                  </div>
                ) : null}
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
                    {imp.proposedEvents.length === 0 ? (
                      <p className="muted small">No mapping has been saved yet.</p>
                    ) : (
                      <ol className="plain-list mono small">
                        {imp.proposedEvents.map((e) => (
                          <li key={e.sequence}>
                            #{e.sequence} {e.phase ?? '—'} {e.summary}
                          </li>
                        ))}
                      </ol>
                    )}
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

                {['CAPTURED_UNTRUSTED', 'QUARANTINED', 'SANITIZED'].includes(imp.state) &&
                imp.blockers.length === 0 ? (
                  <div className="workbench-step">
                    <h3 className="h3">1. Map the sanitized trace</h3>
                    {proposal === null ? (
                      <button type="button" className="btn" onClick={() => void loadProposal()}>
                        Load the proposed mapping draft
                      </button>
                    ) : (
                      <>
                        <Notice
                          tone="neutral"
                          icon="info"
                          title="Unreviewed draft from the service"
                          role="status"
                        >
                          <p>
                            Derived from the{' '}
                            {proposal.derivedFrom === 'SOURCE_SCENARIO'
                              ? 'source scenario'
                              : 'observed trace'}
                            . It maps{' '}
                            {Array.isArray(proposal.mapping['operations'])
                              ? proposal.mapping['operations'].length
                              : 0}{' '}
                            run operation(s). Saving it records a review draft; mapping never executes code or
                            fetches URLs.
                          </p>
                        </Notice>
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={saveMapping.state.status === 'pending'}
                          onClick={() =>
                            void saveMapping
                              .submit(imp.importId, proposal.mapping, imp.revision)
                              .then((o) => {
                                if (o.kind === 'ok') {
                                  setProposal(null);
                                  reload();
                                }
                              })
                          }
                        >
                          Save mapping draft
                        </button>
                      </>
                    )}
                    {proposalError ? (
                      <ErrorNotice error={proposalError} onRetry={() => void loadProposal()} />
                    ) : null}
                    {saveMapping.state.status === 'error' ? (
                      <ErrorNotice error={saveMapping.state.error} onRetry={reload} />
                    ) : null}
                  </div>
                ) : null}

                {imp.state === 'MAPPED' ? (
                  <div className="workbench-step">
                    <h3 className="h3">2. Verify deterministic replay</h3>
                    <p>
                      Runs repeated networkless trial replays and records whether the canonical digests are
                      stable.
                    </p>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={verify.state.status === 'pending'}
                      onClick={() => void verify.submit(imp.importId, imp.revision).then(reload)}
                    >
                      {verify.state.status === 'pending'
                        ? 'Verifying replay…'
                        : 'Verify deterministic replay'}
                    </button>
                    {verify.state.status === 'error' ? (
                      <ErrorNotice error={verify.state.error} onRetry={reload} />
                    ) : null}
                  </div>
                ) : null}

                {imp.state === 'REPLAY_VERIFIED' && imp.review ? (
                  <ReviewForm imp={imp} onDone={reload} />
                ) : null}

                {imp.releaseEvidence && !promotion ? (
                  <div
                    className="release-evidence"
                    data-release-evidence={String(imp.releaseEvidence.releaseEvidence)}
                  >
                    <h3 className="h3">Release evidence</h3>
                    {imp.releaseEvidence.releaseEvidence ? (
                      <p>
                        This capture is confined, independently observed, and covered through a reviewed
                        interceptor profile. It can be promoted as a required release case.
                      </p>
                    ) : (
                      <Notice tone="review" icon="shield" title="Not release evidence">
                        <p>
                          The service refuses to promote this capture as release evidence. It can only be kept
                          as a diagnostic-only, advisory case that never becomes required.
                        </p>
                        <ul aria-label="Release-evidence refusal reasons">
                          {imp.releaseEvidence.refusalReasons.map((r) => (
                            <li key={r}>
                              <span className="mono small">{r}</span> — {refusalText(r)}
                            </li>
                          ))}
                        </ul>
                      </Notice>
                    )}
                  </div>
                ) : null}

                <div className="action-row">
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
                <label className="field-label" htmlFor="promote-label">
                  New corpus label
                </label>
                <input
                  id="promote-label"
                  className="input"
                  autoComplete="off"
                  value={corpusLabel}
                  onChange={(e) => setCorpusLabel(e.target.value)}
                />
                {(() => {
                  const allowed = imp.releaseEvidence?.promotableAs ?? [
                    'RELEASE_EVIDENCE',
                    'DIAGNOSTIC_ONLY',
                  ];
                  const chosen =
                    evidenceUse ??
                    (allowed.includes('RELEASE_EVIDENCE') ? 'RELEASE_EVIDENCE' : 'DIAGNOSTIC_ONLY');
                  return (
                    <fieldset className="fieldset">
                      <legend className="field-label">Evidence use</legend>
                      {(['RELEASE_EVIDENCE', 'DIAGNOSTIC_ONLY'] as const).map((use) => (
                        <label key={use} className="choice">
                          <input
                            type="radio"
                            name="promote-evidence-use"
                            value={use}
                            checked={chosen === use}
                            disabled={!allowed.includes(use)}
                            onChange={() => setEvidenceUse(use)}
                          />{' '}
                          {use === 'RELEASE_EVIDENCE'
                            ? 'Release evidence (required case)'
                            : 'Diagnostic only (advisory case, never required)'}
                        </label>
                      ))}
                      {!allowed.includes('RELEASE_EVIDENCE') ? (
                        <p className="muted small">
                          Release evidence is unavailable: the service reports this capture is not release
                          evidence.
                        </p>
                      ) : null}
                    </fieldset>
                  );
                })()}
                <label className="field-label" htmlFor="promote-severity">
                  Severity
                </label>
                <select
                  id="promote-severity"
                  className="input"
                  value={severity}
                  onChange={(e) => setSeverity(e.target.value as typeof severity)}
                >
                  <option value="CRITICAL">Critical</option>
                  <option value="HIGH">High</option>
                  <option value="MEDIUM">Medium</option>
                  <option value="LOW">Low</option>
                </select>
                <div className="form-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    data-autofocus
                    disabled={
                      promote.state.status === 'pending' ||
                      !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(corpusLabel.trim()) ||
                      !imp.review?.latestReviewId
                    }
                    onClick={() => {
                      const allowed = imp.releaseEvidence?.promotableAs ?? [
                        'RELEASE_EVIDENCE',
                        'DIAGNOSTIC_ONLY',
                      ];
                      const use =
                        evidenceUse ??
                        (allowed.includes('RELEASE_EVIDENCE') ? 'RELEASE_EVIDENCE' : 'DIAGNOSTIC_ONLY');
                      void promote
                        .submit(imp.importId, imp.revision, {
                          reviewId: imp.review?.latestReviewId as string,
                          baseCorpusRevisionId: null,
                          corpusLabel: corpusLabel.trim(),
                          severity,
                          // A diagnostic-only capture is never a required case (M16, RP-08).
                          gatePolicy: use === 'RELEASE_EVIDENCE' ? 'REQUIRED' : 'ADVISORY',
                          evidenceUse: use,
                        })
                        .then(() => {
                          setPromoteOpen(false);
                          reload();
                        });
                    }}
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

/** Explicit local review: every published decision and the exact confirmation phrase. */
function ReviewForm({ imp, onDone }: { imp: ImportDetail; onDone: () => void }) {
  const review = imp.review as NonNullable<ImportDetail['review']>;
  const [reviewer, setReviewer] = useState('');
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [confirmation, setConfirmation] = useState('');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const summaryRef = useRef<HTMLDivElement>(null);
  const submit = useMutation((c, rev: number, body: Parameters<typeof c.reviewImport>[1]) =>
    c.reviewImport(imp.importId, body, { expectedRevision: rev }),
  );
  const fieldIds: Record<string, string> = {
    reviewer: 'review-reviewer',
    decisions: 'review-decision-0',
    confirmation: 'review-confirmation',
  };
  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const next: FieldError[] = [];
    if (!/^[ -~]{1,120}$/.test(reviewer.trim()))
      next.push({
        field: 'reviewer',
        code: 'REQUIRED',
        message: 'Enter the reviewer name (printable ASCII).',
      });
    if (review.decisions.some((d) => checked[d] !== true))
      next.push({
        field: 'decisions',
        code: 'REQUIRED',
        message: 'Approve every review decision explicitly.',
      });
    if (confirmation !== review.confirmationPhrase)
      next.push({
        field: 'confirmation',
        code: 'MISMATCH',
        message: 'Type the confirmation sentence exactly as shown.',
      });
    setErrors(next);
    if (next.length > 0) {
      window.requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }
    const outcome = await submit.submit(imp.revision, {
      reviewer: reviewer.trim(),
      decisions: Object.fromEntries(review.decisions.map((d) => [d, true])),
      confirmation,
    });
    if (outcome.kind === 'ok') onDone();
  };
  const errorFor = (f: string) => errors.find((e) => e.field === f)?.message;
  return (
    <form className="form workbench-step" noValidate onSubmit={onSubmit} aria-label="Review the regression">
      <h3 className="h3">3. Review</h3>
      <ErrorSummary ref={summaryRef} errors={errors} fieldIds={fieldIds} />
      <Field id="review-reviewer" label="Reviewer" error={errorFor('reviewer')}>
        {(props) => (
          <input
            {...props}
            className="input"
            autoComplete="off"
            value={reviewer}
            onChange={(e) => setReviewer(e.target.value)}
          />
        )}
      </Field>
      <fieldset
        className="fieldset nested"
        aria-describedby={errorFor('decisions') ? 'review-decisions-error' : undefined}
      >
        <legend>Review decisions</legend>
        {errorFor('decisions') ? (
          <p id="review-decisions-error" className="field-error">
            {errorFor('decisions')}
          </p>
        ) : null}
        {review.decisions.map((d, i) => (
          <label key={d} className="choice">
            <input
              type="checkbox"
              id={`review-decision-${i}`}
              checked={checked[d] === true}
              onChange={(e) => setChecked((c) => ({ ...c, [d]: e.target.checked }))}
            />
            {DECISION_TEXT[d] ?? d} <code className="mono small">{d}</code>
          </label>
        ))}
      </fieldset>
      <Field
        id="review-confirmation"
        label="Confirmation"
        hint={`Type exactly: ${review.confirmationPhrase}`}
        error={errorFor('confirmation')}
      >
        {(props) => (
          <input
            {...props}
            className="input"
            autoComplete="off"
            spellCheck={false}
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
          />
        )}
      </Field>
      {submit.state.status === 'error' ? <ErrorNotice error={submit.state.error} onRetry={onDone} /> : null}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={submit.state.status === 'pending'}>
          Record review
        </button>
      </div>
    </form>
  );
}
