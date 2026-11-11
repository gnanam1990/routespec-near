/**
 * Client-side form checks. They complement, never replace, the server's schema-strict
 * validation: the server's field errors are always rendered as returned.
 */
import type { FieldError } from '../api/errors.ts';

export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const MAX_PARALLELISM = 16;
/** Mirrors the control API's upload bound (200,000 characters inside a 256 KiB request body). */
export const MAX_IMPORT_BYTES = 192 * 1024;

export const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Fields of POST /gate-runs. Pins the service derives (revision, adapter, evaluator) are not asked. */
export interface GateRunFormValues {
  gateId: string;
  buildRevisionId: string;
  artifactDigest: string;
  attestationChoice: 'USER_ASSERTED_LOCAL' | 'ATTESTATION_ID';
  subjectAttestationId: string;
  corpusRevisionId: string;
  effectManifestDigest: string;
  effectCoveragePolicyDigest: string;
  callsiteInventoryDigest: string;
  interceptorProfileDigest: string;
  mode: 'SIMULATE' | 'REPLAY';
  parallelism: string;
}

export const GATE_RUN_FIELD_LABELS: Readonly<Record<keyof GateRunFormValues, string>> = {
  gateId: 'Gate ID (optional)',
  buildRevisionId: 'Subject build revision ID',
  artifactDigest: 'Built artifact digest',
  attestationChoice: 'Subject build attestation',
  subjectAttestationId: 'Build attestation ID',
  corpusRevisionId: 'Corpus revision ID',
  effectManifestDigest: 'Effect manifest digest',
  effectCoveragePolicyDigest: 'Effect coverage policy digest',
  callsiteInventoryDigest: 'Call-site inventory digest (optional)',
  interceptorProfileDigest: 'Interceptor profile digest (optional)',
  mode: 'Mode',
  parallelism: 'Bounded parallelism',
};

export const GATE_RUN_PREFILL_FIELDS: readonly (keyof GateRunFormValues)[] = [
  'gateId',
  'buildRevisionId',
  'artifactDigest',
  'corpusRevisionId',
  'effectManifestDigest',
  'effectCoveragePolicyDigest',
];

export function emptyGateRunForm(): GateRunFormValues {
  return {
    gateId: '',
    buildRevisionId: '',
    artifactDigest: '',
    attestationChoice: 'USER_ASSERTED_LOCAL',
    subjectAttestationId: '',
    corpusRevisionId: '',
    effectManifestDigest: '',
    effectCoveragePolicyDigest: '',
    callsiteInventoryDigest: '',
    interceptorProfileDigest: '',
    mode: 'SIMULATE',
    parallelism: '1',
  };
}

const required: readonly (keyof GateRunFormValues)[] = [
  'buildRevisionId',
  'artifactDigest',
  'corpusRevisionId',
  'effectManifestDigest',
  'effectCoveragePolicyDigest',
];
const digestFields: readonly (keyof GateRunFormValues)[] = [
  'artifactDigest',
  'effectManifestDigest',
  'effectCoveragePolicyDigest',
  'callsiteInventoryDigest',
  'interceptorProfileDigest',
];
const idFields: readonly (keyof GateRunFormValues)[] = ['gateId', 'buildRevisionId', 'corpusRevisionId'];

export function validateGateRunForm(values: GateRunFormValues): FieldError[] {
  const errors: FieldError[] = [];
  for (const field of required) {
    if (values[field].trim().length === 0) {
      errors.push({
        field,
        code: 'REQUIRED',
        message: `Enter the ${GATE_RUN_FIELD_LABELS[field].toLowerCase()}.`,
      });
    }
  }
  for (const field of idFields) {
    const value = values[field].trim();
    if (value.length > 0 && !ID_PATTERN.test(value)) {
      errors.push({
        field,
        code: 'ID_FORMAT',
        message: `${GATE_RUN_FIELD_LABELS[field].replace(' (optional)', '')} must be a lowercase UUID.`,
      });
    }
  }
  for (const field of digestFields) {
    const value = values[field].trim();
    if (value.length > 0 && !DIGEST_PATTERN.test(value)) {
      errors.push({
        field,
        code: 'DIGEST_FORMAT',
        message: `${GATE_RUN_FIELD_LABELS[field].replace(' (optional)', '')} must be sha256: followed by 64 lowercase hex characters.`,
      });
    }
  }
  if (values.attestationChoice === 'ATTESTATION_ID') {
    const v = values.subjectAttestationId.trim();
    if (v.length === 0) {
      errors.push({
        field: 'subjectAttestationId',
        code: 'REQUIRED',
        message: 'Enter the build attestation ID, or choose the user-asserted local build.',
      });
    } else if (!ID_PATTERN.test(v)) {
      errors.push({
        field: 'subjectAttestationId',
        code: 'ID_FORMAT',
        message: 'Build attestation ID must be a lowercase UUID.',
      });
    }
  }
  if (values.mode !== 'SIMULATE' && values.mode !== 'REPLAY') {
    errors.push({
      field: 'mode',
      code: 'UNSUPPORTED_MODE',
      message: 'Gate runs support SIMULATE or REPLAY only.',
    });
  }
  const parallelism = Number(values.parallelism);
  if (!/^\d+$/.test(values.parallelism.trim()) || parallelism < 1 || parallelism > MAX_PARALLELISM) {
    errors.push({
      field: 'parallelism',
      code: 'RANGE',
      message: `Bounded parallelism must be a whole number from 1 to ${MAX_PARALLELISM}.`,
    });
  }
  return errors;
}

/** Server field paths (zod issue paths) mapped onto this form's fields. */
export function gateRunFieldOf(serverField: string): keyof GateRunFormValues | null {
  if (serverField === 'maxParallelCases') return 'parallelism';
  if (serverField.startsWith('buildAttestation')) return 'subjectAttestationId';
  return serverField in GATE_RUN_FIELD_LABELS ? (serverField as keyof GateRunFormValues) : null;
}

export interface ImportFormValues {
  fileName: string;
  sizeBytes: number | null;
  acknowledged: boolean;
}

export function validateImportForm(values: ImportFormValues): FieldError[] {
  const errors: FieldError[] = [];
  if (values.sizeBytes === null || values.fileName.length === 0) {
    errors.push({ field: 'traceFile', code: 'REQUIRED', message: 'Choose a trace file to import.' });
  } else {
    if (!/\.(json|ya?ml|jsonl)$/i.test(values.fileName)) {
      errors.push({
        field: 'traceFile',
        code: 'FILE_TYPE',
        message: 'The trace file must be JSON, JSONL, or YAML.',
      });
    }
    if (values.sizeBytes > MAX_IMPORT_BYTES) {
      errors.push({
        field: 'traceFile',
        code: 'TOO_LARGE',
        message: `The trace file is larger than the ${MAX_IMPORT_BYTES / 1024} KiB import limit.`,
      });
    }
    if (values.sizeBytes === 0) {
      errors.push({ field: 'traceFile', code: 'EMPTY', message: 'The trace file is empty.' });
    }
  }
  if (!values.acknowledged) {
    errors.push({
      field: 'acknowledged',
      code: 'REQUIRED',
      message: 'Confirm that the trace is untrusted and will be quarantined without network access.',
    });
  }
  return errors;
}
