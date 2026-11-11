/**
 * M00 supplementary tests: closed versioned schemas, lifecycle tables, separate axes,
 * protocol profile, status normalization, header stripping, and the dependency boundary.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONTRACTS,
  ENFORCEMENT_MODES,
  EXECUTION_LIFECYCLES,
  ONECLICK_PROFILE,
  ONECLICK_SDK_PIN,
  RAW_PROVIDER_STATUSES,
  VERDICTS,
  allowedTransitions,
  assertTransition,
  foldOutcomes,
  isRouteSpecError,
  normalizeRawStatus,
  parseContract,
  resolveProfileRoute,
  stripForUpstream,
  validateCommit,
  validateQuoteFinalization,
  validateQuoteRequest,
  validateStatusQuery,
  type ErrorCode,
} from '../src/index.ts';
import { digestFor, quoteRequest, quoteResponse, uuidFor } from './fixtures.ts';

function codeOf(fn: () => unknown): ErrorCode | 'NO_ERROR' {
  try {
    fn();
    return 'NO_ERROR';
  } catch (error) {
    if (isRouteSpecError(error)) return error.code;
    throw error;
  }
}

function buildRow(): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    buildRevisionId: uuidFor('build'),
    projectId: uuidFor('project'),
    integrationRevisionId: uuidFor('integration'),
    repositoryLocator: 'git+file:client',
    commitSha: 'a'.repeat(40),
    dirtyTreeDigest: null,
    artifactDigest: digestFor('artifact'),
    toolchainDigest: digestFor('toolchain'),
    lockDigest: digestFor('lock'),
    effectManifestDigest: digestFor('manifest'),
    ciWorkflowRunId: null,
    launchRecipeDigest: digestFor('recipe'),
    registrationClaim: 'USER_ASSERTED_LOCAL',
    identityDigest: digestFor('identity'),
  };
}

describe('closed versioned contracts', () => {
  it('accepts a valid build row whose registration claim is permanently USER_ASSERTED_LOCAL', () => {
    expect(parseContract('build-revision', buildRow()).registrationClaim).toBe('USER_ASSERTED_LOCAL');
    expect(
      codeOf(() => parseContract('build-revision', { ...buildRow(), registrationClaim: 'CI_ATTESTED' })),
    ).toBe('RS_SCHEMA_INVALID');
  });

  it('fails closed on unknown fields, unknown major, newer minor, missing version, and unknown kind', () => {
    expect(codeOf(() => parseContract('build-revision', { ...buildRow(), attested: true }))).toBe(
      'RS_SCHEMA_INVALID',
    );
    expect(codeOf(() => parseContract('build-revision', { ...buildRow(), schemaVersion: '2.0' }))).toBe(
      'RS_SCHEMA_VERSION_UNSUPPORTED',
    );
    expect(codeOf(() => parseContract('build-revision', { ...buildRow(), schemaVersion: '1.1' }))).toBe(
      'RS_SCHEMA_VERSION_UNSUPPORTED',
    );
    const { schemaVersion: _v, ...noVersion } = buildRow();
    expect(codeOf(() => parseContract('build-revision', noVersion))).toBe('RS_SCHEMA_VERSION_UNSUPPORTED');
    expect(codeOf(() => parseContract('nope' as never, buildRow()))).toBe('RS_UNKNOWN_CONTRACT_KIND');
  });

  it('every registered contract declares a schema version', () => {
    for (const [kind, entry] of Object.entries(CONTRACTS)) {
      expect(entry.version, kind).toMatch(/^\d+\.\d+$/);
    }
  });

  it('keeps verdict, lifecycle, and enforcement as separate closed axes', () => {
    expect(VERDICTS).not.toContain('COMPLETED');
    expect(EXECUTION_LIFECYCLES).not.toContain('PASS');
    expect(VERDICTS).not.toContain('NOT_VISIBLE');
    expect(ENFORCEMENT_MODES).not.toContain('BLOCKING');
    const gateEval = {
      schemaVersion: '1.0',
      gateEvaluationId: uuidFor('ge'),
      gateRunId: uuidFor('gr'),
      decision: 'PASS',
      decisionDigest: digestFor('d'),
      artifactReady: false,
      enforcementMode: 'REQUIRED_CHECK_UNVERIFIED',
      caseResultDigests: [],
    };
    expect(parseContract('gate-evaluation', gateEval).artifactReady).toBe(false);
    expect(codeOf(() => parseContract('gate-evaluation', { ...gateEval, enforcementMode: 'BLOCKING' }))).toBe(
      'RS_SCHEMA_INVALID',
    );
  });

  it('requires an interceptor for intercept coverage bases', () => {
    const policy = {
      schemaVersion: '1.0',
      policyId: uuidFor('p'),
      buildRevisionId: uuidFor('b'),
      artifactDigest: digestFor('a'),
      selectedAttestationId: null,
      scenarioRevisionId: uuidFor('s'),
      manifestDigest: digestFor('m'),
      requiredSinkClasses: ['fulfilment'],
      interceptorProfileDigest: null,
      callsiteInventoryDigest: null,
      basis: 'INDEPENDENT_BOUNDARY_INTERCEPT',
      policyDigest: digestFor('pd'),
    };
    expect(codeOf(() => parseContract('effect-coverage-policy', policy))).toBe('RS_SCHEMA_INVALID');
    expect(
      codeOf(() => parseContract('effect-coverage-policy', { ...policy, basis: 'DECLARED_HOOKS_ONLY' })),
    ).toBe('NO_ERROR');
  });
});

describe('shared execution lifecycle', () => {
  it('allows only the documented transitions and freezes terminal states', () => {
    expect(codeOf(() => assertTransition('GATE_RUN', 'DRAFT', 'VALIDATING'))).toBe('NO_ERROR');
    expect(codeOf(() => assertTransition('GATE_RUN', 'DRAFT', 'RUNNING'))).toBe(
      'RS_LIFECYCLE_TRANSITION_INVALID',
    );
    expect(codeOf(() => assertTransition('SESSION', 'COMPLETED', 'RUNNING'))).toBe('RS_TERMINAL_IMMUTABLE');
    expect(codeOf(() => assertTransition('CASE_RUN', 'ABORTED', 'READY'))).toBe('RS_TERMINAL_IMMUTABLE');
    expect(codeOf(() => assertTransition('CASE_RUN', 'RECOVERY_REQUIRED', 'RUNNING'))).toBe('NO_ERROR');
    for (const [from] of allowedTransitions('CASE_RUN')) {
      expect(['COMPLETED', 'ABORTED', 'ERROR']).not.toContain(from);
    }
  });
});

describe('oneclick-v0 protocol profile', () => {
  it('pins the exact SDK and records base-URL configurability', () => {
    expect(ONECLICK_SDK_PIN.version).toBe('0.1.26');
    expect(ONECLICK_SDK_PIN.baseUrlConfigurable).toBe(true);
    expect(ONECLICK_PROFILE.integrityDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ONECLICK_PROFILE.routeSchemaDigest).not.toBe(ONECLICK_PROFILE.statusSchemaDigest);
  });

  it('enumerates exactly the seven raw statuses and preserves unknown values as UNKNOWN', () => {
    expect([...RAW_PROVIDER_STATUSES].sort()).toEqual(
      [
        'FAILED',
        'INCOMPLETE_DEPOSIT',
        'KNOWN_DEPOSIT_TX',
        'PENDING_DEPOSIT',
        'PROCESSING',
        'REFUNDED',
        'SUCCESS',
      ].sort(),
    );
    expect(normalizeRawStatus('SUCCESS').fact).toBe('SUCCESS_REPORTED');
    const unknown = normalizeRawStatus('SETTLED_MAYBE');
    expect(unknown).toEqual({ rawStatus: 'SETTLED_MAYBE', known: false, fact: 'UNKNOWN', terminal: false });
    expect(foldOutcomes(['PROCESSING', 'SETTLED_MAYBE']).unknownObserved).toBe(true);
  });

  it('rejects unsupported routes with a typed local denial', () => {
    expect(resolveProfileRoute('POST', '/v0/quote').phases).toContain('QUOTE_REQUEST');
    expect(codeOf(() => resolveProfileRoute('POST', '/v0/submit-intent'))).toBe('RS_UNSUPPORTED_ROUTE');
    expect(codeOf(() => resolveProfileRoute('DELETE', '/v0/quote'))).toBe('RS_UNSUPPORTED_ROUTE');
  });

  it('never accepts a deposit address as request-known and fails closed on unknown fields', () => {
    expect(codeOf(() => validateQuoteRequest(quoteRequest({ depositAddress: 'x' })))).toBe(
      'RS_DEPOSIT_ADDRESS_NOT_REQUEST_KNOWN',
    );
    expect(codeOf(() => validateQuoteRequest(quoteRequest({ surprise: 1 })))).toBe(
      'RS_UNKNOWN_MATERIAL_FIELD',
    );
    expect(codeOf(() => validateQuoteRequest(quoteRequest({ amount: '1.5' })))).toBe('RS_MATERIAL_INVALID');
  });

  it('finalizes only a complete matching response and binds commit material to it', () => {
    const req = quoteRequest();
    const bound = validateQuoteRequest(req);
    const fin = validateQuoteFinalization(bound, quoteResponse(req));
    expect(fin.depositAddress).toBe('deposit.sim');
    expect(validateQuoteFinalization(bound, quoteResponse(req)).finalizationDigest).toBe(
      fin.finalizationDigest,
    );
    const { minAmountOut: _m, ...partialQuote } = quoteResponse(req)['quote'] as Record<string, unknown>;
    expect(
      codeOf(() => validateQuoteFinalization(bound, { ...quoteResponse(req), quote: partialQuote })),
    ).toBe('RS_PARTIAL_FINALIZATION');
    expect(
      codeOf(() => validateQuoteFinalization(bound, quoteResponse(req, { depositAddress: undefined }))),
    ).not.toBe('NO_ERROR');
    expect(codeOf(() => validateQuoteFinalization(bound, quoteResponse(quoteRequest({ amount: '2' }))))).toBe(
      'RS_FINALIZATION_REQUEST_MISMATCH',
    );
    expect(codeOf(() => validateQuoteFinalization(bound, quoteResponse(req, { bonus: 'x' })))).toBe(
      'RS_UNKNOWN_MATERIAL_FIELD',
    );
    const commit = validateCommit(fin, { txHash: '0xabc', depositAddress: 'deposit.sim' });
    expect(commit.quoteFinalizationDigest).toBe(fin.finalizationDigest);
    expect(codeOf(() => validateCommit(null, { txHash: '0xabc', depositAddress: 'deposit.sim' }))).toBe(
      'RS_COMMIT_WITHOUT_FINALIZATION',
    );
    expect(codeOf(() => validateCommit(fin, { txHash: '0xabc', depositAddress: 'other' }))).toBe(
      'RS_COMMIT_MATERIAL_MISMATCH',
    );
    expect(validateStatusQuery(fin, { depositAddress: 'deposit.sim' }).depositAddress).toBe('deposit.sim');
    expect(codeOf(() => validateStatusQuery(fin, { depositAddress: 'elsewhere' }))).toBe(
      'RS_IDENTITY_MISMATCH',
    );
  });

  it('strips every RouteSpec-local and credential header before an upstream boundary', () => {
    const stripped = stripForUpstream({
      'Content-Type': 'application/json',
      Authorization: 'Bearer canary',
      'X-RouteSpec-Case-Token': 'canary',
      'x-routespec-session': 's',
      Cookie: 'c',
    });
    expect(stripped).toEqual({ 'Content-Type': 'application/json' });
  });
});

describe('dependency boundary', () => {
  it('contracts sources import only zod, node:crypto, and their own modules', () => {
    const root = fileURLToPath(new URL('../src', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts')) files.push(full);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const imports = [...readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1] as string);
      for (const spec of imports) {
        expect(
          spec === 'zod' || spec === 'node:crypto' || spec.startsWith('./') || spec.startsWith('../'),
          `${file}: ${spec}`,
        ).toBe(true);
      }
    }
  });
});
