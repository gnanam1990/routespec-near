import { useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useResource } from '../app/context.tsx';
import { usePageTitle } from '../app/usePageTitle.ts';
import type { FieldError } from '../api/errors.ts';
import type { ImportCreateInput } from '../api/client.ts';
import type { ImportRow, Page } from '../api/schemas.ts';
import { Digest } from '../components/Digest.tsx';
import { StatusBadge } from '../components/Status.tsx';
import { Timestamp } from '../components/Timestamp.tsx';
import {
  EmptyState,
  ErrorNotice,
  ErrorSummary,
  Field,
  Notice,
  PageHeader,
  ResourceView,
  Section,
  ScrollRegion,
} from '../components/ui.tsx';
import { IMPORT_STATE_CONTENT } from '../content/status-content.ts';
import { MAX_IMPORT_BYTES, validateImportForm } from '../forms/validation.ts';

const IMPORT_FIELD_IDS = { traceFile: 'import-file', acknowledged: 'import-ack' };

export function RegressionsPage() {
  const { projectId = '' } = useParams();
  usePageTitle('Regressions');
  const imports = useResource<Page<ImportRow>>(
    (client, signal) => client.listImports(projectId, signal),
    [projectId],
  );
  const base = `/projects/${encodeURIComponent(projectId)}`;
  return (
    <>
      <PageHeader title="Regressions" />
      <Section title="Quarantine queue">
        <ResourceView
          state={imports.state}
          label="quarantine queue"
          onRetry={imports.reload}
          isEmpty={(p) => p.items.length === 0}
          empty={
            <EmptyState title="No captures or imports">
              <p>Capture an installed trace from a completed case run, or import a user file below.</p>
            </EmptyState>
          }
        >
          {(page) => (
            <ScrollRegion label="Quarantine queue (scrolls horizontally)">
              <table className="table">
                <caption className="visually-hidden">{page.total} captures and imports</caption>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Source</th>
                    <th scope="col">State</th>
                    <th scope="col">Findings</th>
                    <th scope="col">Digest</th>
                    <th scope="col">Size</th>
                    <th scope="col">Expires</th>
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((row) => (
                    <tr key={row.importId}>
                      <th scope="row">
                        <Link to={`${base}/regressions/${encodeURIComponent(row.importId)}`}>
                          {row.sanitizedName}
                        </Link>
                      </th>
                      <td>
                        {row.origin === 'INSTALLED_ARTIFACT_CAPTURE'
                          ? 'Installed artifact capture'
                          : 'User file'}
                        {row.source ? <div className="small mono">case {row.source.caseRunId}</div> : null}
                      </td>
                      <td>
                        <StatusBadge content={IMPORT_STATE_CONTENT[row.state]} code={row.state} />
                      </td>
                      <td className="small">
                        {row.findings.secret} secret, {row.findings.nondeterminism} nondeterministic,{' '}
                        {row.findings.unresolved} unresolved
                      </td>
                      <td>
                        <Digest value={row.digest} label="import digest" />
                      </td>
                      <td className="mono num">{row.sizeBytes}</td>
                      <td>
                        <Timestamp value={row.expiresAt} fallback="No expiry" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
          )}
        </ResourceView>
      </Section>
      <ImportForm projectId={projectId} onImported={imports.reload} />
    </>
  );
}

function ImportForm({ projectId, onImported }: { projectId: string; onImported: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const summary = useRef<HTMLDivElement>(null);
  const create = useMutation((client, input: ImportCreateInput) => client.createImport(input));
  const focusSummary = () => window.requestAnimationFrame(() => summary.current?.focus());

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const local = validateImportForm({
      fileName: file?.name ?? '',
      sizeBytes: file ? file.size : null,
      acknowledged,
    });
    if (local.length > 0 || file === null) {
      setErrors(local);
      focusSummary();
      return;
    }
    setErrors([]);
    // The file is read into memory and sent once; nothing is cached in browser storage.
    const content = await file.text();
    const outcome = await create.submit({ projectId, fileName: file.name, content });
    if (outcome.kind === 'ok') {
      onImported();
      const row = outcome.result.data;
      if (row.state === 'REJECTED' || row.blockers.length > 0) {
        // The service quarantined the trace and reported blocking findings: announce them as
        // errors on the file field. Finding paths and classes only; content is never echoed.
        setErrors(
          (row.blockers.length > 0
            ? row.blockers
            : [{ field: 'trace', code: 'RS_IMPORT_REJECTED', message: 'Rejected.' }]
          ).map((b) => ({
            field: 'traceFile',
            code: b.code,
            message: `The quarantine scan blocked this trace (${b.code} at ${b.field}). Its content is not shown or stored.`,
          })),
        );
        focusSummary();
      }
    } else if (outcome.kind === 'error' && outcome.error.fieldErrors.length > 0) {
      setErrors([...outcome.error.fieldErrors]);
      focusSummary();
    }
  };

  const errorFor = (field: string) => errors.find((e) => e.field === field)?.message;
  const serverError =
    create.state.status === 'error' && create.state.error.fieldErrors.length === 0
      ? create.state.error
      : null;

  return (
    <Section title="Import a user trace">
      <ErrorSummary ref={summary} errors={errors} fieldIds={IMPORT_FIELD_IDS} />
      {serverError ? <ErrorNotice error={serverError} /> : null}
      {create.state.status === 'success' && errors.length === 0 ? (
        <Notice tone="neutral" icon="archive" title="Imported into quarantine" role="status">
          <p>
            {create.state.result.data.sanitizedName} is{' '}
            {IMPORT_STATE_CONTENT[create.state.result.data.state].label.toLowerCase()}.
          </p>
        </Notice>
      ) : null}
      <form className="form" noValidate onSubmit={onSubmit} aria-label="Import a user trace">
        <Field
          id={IMPORT_FIELD_IDS.traceFile}
          label="Trace file"
          hint={`JSON, JSONL, or YAML, at most ${MAX_IMPORT_BYTES / 1024} KiB. Content is never rendered as HTML.`}
          error={errorFor('traceFile')}
        >
          {(props) => (
            <input
              {...props}
              type="file"
              className="input"
              accept=".json,.jsonl,.yaml,.yml,application/json"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          )}
        </Field>
        <Field id={IMPORT_FIELD_IDS.acknowledged} label="Untrusted content" error={errorFor('acknowledged')}>
          {(props) => (
            <label className="choice">
              <input
                {...props}
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              I understand this trace is untrusted and is quarantined, scanned for secrets, and normalized
              without network access.
            </label>
          )}
        </Field>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={create.state.status === 'pending'}>
            {create.state.status === 'pending' ? 'Importing…' : 'Import into quarantine'}
          </button>
        </div>
      </form>
    </Section>
  );
}
