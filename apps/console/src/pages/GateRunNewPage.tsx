import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation } from '../app/context.tsx';
import { usePageTitle } from '../app/usePageTitle.ts';
import type { FieldError } from '../api/errors.ts';
import type { GateRunCreateInput } from '../api/client.ts';
import {
  GATE_RUN_FIELD_LABELS,
  GATE_RUN_PREFILL_FIELDS,
  MAX_PARALLELISM,
  emptyGateRunForm,
  gateRunFieldOf,
  validateGateRunForm,
  type GateRunFormValues,
} from '../forms/validation.ts';
import { ErrorNotice, ErrorSummary, Field, Notice, PageHeader } from '../components/ui.tsx';

const FIELD_IDS: Record<string, string> = Object.fromEntries(
  Object.keys(GATE_RUN_FIELD_LABELS).map((k) => [k, `gr-${k}`]),
);

/** Step 1 of the gate-run workspace: select exact identity (UI-SPEC 3.2). */
export function GateRunNewPage() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  usePageTitle('Create gate run');
  // Links from persisted records (for example a promoted corpus) may prefill identity fields;
  // the values are still shown, editable, and validated like typed input.
  const [values, setValues] = useState<GateRunFormValues>(() => {
    const initial = emptyGateRunForm();
    for (const field of GATE_RUN_PREFILL_FIELDS) {
      const v = search.get(field);
      if (v !== null && v.length <= 200) (initial as unknown as Record<string, string>)[field] = v;
    }
    return initial;
  });
  const [errors, setErrors] = useState<FieldError[]>([]);
  const summaryRef = useRef<HTMLDivElement>(null);
  const idempotencyKey = useRef<string>(globalThis.crypto.randomUUID());
  const create = useMutation((client, input: GateRunCreateInput, key: string) =>
    client.createGateRun(input, { idempotencyKey: key }),
  );

  const set = <K extends keyof GateRunFormValues>(key: K, value: GateRunFormValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    // Values changed: a later submission is a different request and needs a new key.
    idempotencyKey.current = globalThis.crypto.randomUUID();
  };

  const showErrors = (next: FieldError[]) => {
    setErrors(next);
    // Focus moves to the summary after it renders (UI-SPEC 6.4, T-049).
    window.requestAnimationFrame(() => summaryRef.current?.focus());
  };

  const onBlurField = (field: keyof GateRunFormValues) => {
    // Blur validation complements submit validation: it only clears errors that are fixed.
    if (!errors.some((e) => e.field === field)) return;
    const remaining = validateGateRunForm(values).filter((e) => e.field === field);
    setErrors((prev) => [...prev.filter((e) => e.field !== field), ...remaining]);
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const local = validateGateRunForm(values);
    if (local.length > 0) {
      showErrors(local);
      return;
    }
    setErrors([]);
    const optional = (v: string) => (v.trim().length > 0 ? v.trim() : null);
    const input: GateRunCreateInput = {
      projectId,
      gateId: optional(values.gateId),
      buildRevisionId: values.buildRevisionId.trim(),
      artifactDigest: values.artifactDigest.trim(),
      corpusRevisionId: values.corpusRevisionId.trim(),
      effectManifestDigest: values.effectManifestDigest.trim(),
      effectCoveragePolicyDigest: values.effectCoveragePolicyDigest.trim(),
      callsiteInventoryDigest: optional(values.callsiteInventoryDigest),
      interceptorProfileDigest: optional(values.interceptorProfileDigest),
      buildAttestation:
        values.attestationChoice === 'USER_ASSERTED_LOCAL'
          ? { class: 'USER_ASSERTED_LOCAL' }
          : { subjectAttestationId: values.subjectAttestationId.trim() },
      mode: values.mode,
      maxParallelCases: Number(values.parallelism),
    };
    const outcome = await create.submit(input, idempotencyKey.current);
    if (outcome.kind === 'ok') {
      navigate(
        `/projects/${encodeURIComponent(projectId)}/gate-runs/${encodeURIComponent(outcome.result.data.gateRunId)}`,
      );
    } else if (outcome.kind === 'error' && outcome.error.fieldErrors.length > 0) {
      // Server field errors are shown as returned, attached to the matching form field.
      showErrors(
        outcome.error.fieldErrors.map((e) => {
          const field = gateRunFieldOf(e.field);
          return field === null
            ? e
            : { ...e, field, message: `${GATE_RUN_FIELD_LABELS[field]}: ${e.message} (${e.code})` };
        }),
      );
    }
  };

  const serverError = create.state.status === 'error' ? create.state.error : null;
  const serverFieldErrors = serverError?.fieldErrors ?? [];
  const allErrors = errors;
  const errorFor = (field: string) => allErrors.find((e) => e.field === field)?.message;

  const textField = (field: keyof GateRunFormValues, hint?: string, mono = true) => (
    <Field
      id={FIELD_IDS[field] ?? field}
      label={GATE_RUN_FIELD_LABELS[field]}
      {...(hint ? { hint } : {})}
      error={errorFor(field)}
    >
      {(props) => (
        <input
          {...props}
          name={field}
          className={mono ? 'input mono' : 'input'}
          autoComplete="off"
          spellCheck={false}
          value={values[field]}
          onChange={(e) => set(field, e.target.value as never)}
          onBlur={() => onBlurField(field)}
        />
      )}
    </Field>
  );

  return (
    <>
      <PageHeader title="Create gate run" meta={<span>Step 1 of 5 — select exact identity</span>} />
      <ErrorSummary ref={summaryRef} errors={allErrors} fieldIds={FIELD_IDS} />
      {serverError && serverFieldErrors.length === 0 ? <ErrorNotice error={serverError} /> : null}
      <Notice tone="neutral" icon="info" title="The gate run uses the networkless scenario runtime">
        <p>
          SIMULATE and REPLAY never contact a provider. The official dry compatibility probe is a separate
          action under <Link to="/settings">Safety &amp; Settings</Link>; no settlement is tested there
          either.
        </p>
      </Notice>
      <form className="form" noValidate onSubmit={onSubmit} aria-label="Create gate run">
        <fieldset className="fieldset">
          <legend className="h3">Subject</legend>
          {textField('gateId', 'Evaluating the run against a gate definition requires its gate ID.')}
          {textField('buildRevisionId')}
          {textField('artifactDigest', 'sha256: followed by 64 lowercase hex characters.')}
          <fieldset className="fieldset nested" aria-describedby="att-hint">
            <legend>{GATE_RUN_FIELD_LABELS.attestationChoice}</legend>
            <p id="att-hint" className="field-hint">
              A user assertion is recorded as USER_ASSERTED_LOCAL and never counts as a verified build.
            </p>
            <label className="choice">
              <input
                type="radio"
                name="attestationChoice"
                id={FIELD_IDS['attestationChoice']}
                checked={values.attestationChoice === 'USER_ASSERTED_LOCAL'}
                onChange={() => set('attestationChoice', 'USER_ASSERTED_LOCAL')}
              />
              User-asserted local build
            </label>
            <label className="choice">
              <input
                type="radio"
                name="attestationChoice"
                checked={values.attestationChoice === 'ATTESTATION_ID'}
                onChange={() => set('attestationChoice', 'ATTESTATION_ID')}
              />
              Existing build-registration attestation
            </label>
            {values.attestationChoice === 'ATTESTATION_ID' ? textField('subjectAttestationId') : null}
          </fieldset>
        </fieldset>
        <fieldset className="fieldset">
          <legend className="h3">Corpus and effect policy</legend>
          {textField('corpusRevisionId')}
          {textField('effectManifestDigest')}
          {textField(
            'effectCoveragePolicyDigest',
            'Declared-hooks-only policies may run only as a labelled diagnostic; complete-effect predicates stay at REVIEW.',
          )}
          {textField('callsiteInventoryDigest')}
          {textField('interceptorProfileDigest')}
        </fieldset>
        <fieldset className="fieldset">
          <legend className="h3">Runtime</legend>
          <Field id={FIELD_IDS['mode'] ?? 'mode'} label={GATE_RUN_FIELD_LABELS.mode} error={errorFor('mode')}>
            {(props) => (
              <select
                {...props}
                className="input"
                value={values.mode}
                onChange={(e) => set('mode', e.target.value as GateRunFormValues['mode'])}
              >
                <option value="SIMULATE">SIMULATE — networkless scenario</option>
                <option value="REPLAY">REPLAY — networkless replay</option>
              </select>
            )}
          </Field>
          <Field
            id={FIELD_IDS['parallelism'] ?? 'parallelism'}
            label={GATE_RUN_FIELD_LABELS.parallelism}
            hint={`Whole number from 1 to ${MAX_PARALLELISM}. Cases never share a client or mutable state.`}
            error={errorFor('parallelism')}
          >
            {(props) => (
              <input
                {...props}
                className="input mono narrow"
                inputMode="numeric"
                value={values.parallelism}
                onChange={(e) => set('parallelism', e.target.value)}
                onBlur={() => onBlurField('parallelism')}
              />
            )}
          </Field>
        </fieldset>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={create.state.status === 'pending'}>
            {create.state.status === 'pending' ? 'Creating gate run…' : 'Create gate run'}
          </button>
          <Link className="btn" to={`/projects/${encodeURIComponent(projectId)}/gate-runs`}>
            Cancel
          </Link>
        </div>
      </form>
    </>
  );
}
