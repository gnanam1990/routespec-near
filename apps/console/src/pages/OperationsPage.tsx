import { useRef, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { usePageTitle } from '../app/usePageTitle.ts';
import type { FieldError } from '../api/errors.ts';
import { ErrorSummary, Field, Notice, PageHeader } from '../components/ui.tsx';

const ID_PATTERN = /^[0-9a-z][0-9a-z-]{0,159}$/;

/** Run-operation lookup. Search across logical jobs needs an API list endpoint (pending M08). */
export function OperationsPage() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  usePageTitle('Operations');
  const [value, setValue] = useState('');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const summary = useRef<HTMLDivElement>(null);
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const id = value.trim();
    if (!ID_PATTERN.test(id)) {
      setErrors([
        {
          field: 'runOperationId',
          code: 'FORMAT',
          message: 'Enter a run-operation ID (lowercase letters, digits, and hyphens).',
        },
      ]);
      window.requestAnimationFrame(() => summary.current?.focus());
      return;
    }
    setErrors([]);
    navigate(`/projects/${encodeURIComponent(projectId)}/operations/${encodeURIComponent(id)}`);
  };
  return (
    <>
      <PageHeader title="Operations" />
      <ErrorSummary ref={summary} errors={errors} fieldIds={{ runOperationId: 'op-id' }} />
      <Notice tone="neutral" icon="info" title="Open a run operation by its identity">
        <p>
          Run operations are listed on each case run. Logical-job search across gate runs is not available
          from this control API revision.
        </p>
      </Notice>
      <form className="form inline-form" noValidate onSubmit={onSubmit} aria-label="Open run operation">
        <Field id="op-id" label="Run-operation ID" error={errors[0]?.message}>
          {(props) => (
            <input
              {...props}
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
            Open run operation
          </button>
        </div>
      </form>
    </>
  );
}
