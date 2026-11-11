/**
 * Client-side form checks. They complement, never replace, the server's schema-strict
 * validation: the server's field errors are always rendered as returned.
 */
import type { FieldError } from '../api/errors.ts';

export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const MAX_PARALLELISM = 16;
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

export interface GateRunFormValues {
  revisionId: string;
  buildRevisionId: string;
  artifactDigest: string;
  attestationChoice: 'USER_ASSERTED_LOCAL' | 'ATTESTATION_ID';
  subjectAttestationId: string;
  corpusRevisionId: string;
  effectManifestDigest: string;
  effectCoveragePolicyDigest: string;
  adapterRevision: string;
  evaluatorRevision: string;
  configurationDigest: string;
  mode: 'SIMULATE' | 'REPLAY';
  parallelism: string;
}

export const GATE_RUN_FIELD_LABELS: Readonly<Record<keyof GateRunFormValues, string>> = {
  revisionId: 'Integration revision ID',
  buildRevisionId: 'Subject build revision ID',
  artifactDigest: 'Built artifact digest',
  attestationChoice: 'Subject build attestation',
  subjectAttestationId: 'Build attestation ID',
  corpusRevisionId: 'Corpus revision ID',
  effectManifestDigest: 'Effect manifest digest',
  effectCoveragePolicyDigest: 'Effect coverage policy digest',
  adapterRevision: 'Actual-client adapter revision',
  evaluatorRevision: 'Evaluator revision',
  configurationDigest: 'Configuration digest',
  mode: 'Mode',
  parallelism: 'Bounded parallelism',
};

export function emptyGateRunForm(): GateRunFormValues {
  return {
    revisionId: '',
    buildRevisionId: '',
    artifactDigest: '',
    attestationChoice: 'USER_ASSERTED_LOCAL',
    subjectAttestationId: '',
    corpusRevisionId: '',
    effectManifestDigest: '',
    effectCoveragePolicyDigest: '',
    adapterRevision: '',
    evaluatorRevision: '',
    configurationDigest: '',
    mode: 'SIMULATE',
    parallelism: '1',
  };
}

const required: readonly (keyof GateRunFormValues)[] = [
  'revisionId',
  'buildRevisionId',
  'artifactDigest',
  'corpusRevisionId',
  'effectManifestDigest',
  'effectCoveragePolicyDigest',
  'adapterRevision',
  'evaluatorRevision',
  'configurationDigest',
];
const digestFields: readonly (keyof GateRunFormValues)[] = [
  'artifactDigest',
  'effectManifestDigest',
  'effectCoveragePolicyDigest',
  'configurationDigest',
];

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
  for (const field of digestFields) {
    const value = values[field].trim();
    if (value.length > 0 && !DIGEST_PATTERN.test(value)) {
      errors.push({
        field,
        code: 'DIGEST_FORMAT',
        message: `${GATE_RUN_FIELD_LABELS[field]} must be sha256: followed by 64 lowercase hex characters.`,
      });
    }
  }
  if (values.attestationChoice === 'ATTESTATION_ID' && values.subjectAttestationId.trim().length === 0) {
    errors.push({
      field: 'subjectAttestationId',
      code: 'REQUIRED',
      message: 'Enter the build attestation ID, or choose the user-asserted local build.',
    });
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
        message: `The trace file is larger than the ${MAX_IMPORT_BYTES / 1024 / 1024} MiB import limit.`,
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
