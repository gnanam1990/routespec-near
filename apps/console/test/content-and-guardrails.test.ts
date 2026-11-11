import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EFFECT_COVERAGE_BASES,
  ENFORCEMENT_MODES,
  EVIDENCE_CLASSES,
  EVIDENCE_REASONS,
  EVIDENCE_SCOPES,
  EXECUTION_LIFECYCLES,
  IMPORT_STATES,
  SUBJECT_ATTESTATION_CLASSES,
  VERDICTS,
} from '@routespec/contracts/enums';
import {
  ATTESTATION_CONTENT,
  AXIS_NAMES,
  COMPATIBILITY_CONTENT,
  COVERAGE_BASIS_CONTENT,
  ENFORCEMENT_CONTENT,
  EVIDENCE_CLASS_CONTENT,
  EVIDENCE_REASON_TEXT,
  EVIDENCE_SCOPE_CONTENT,
  IMPORT_STATE_CONTENT,
  LIFECYCLE_CONTENT,
  PROHIBITED_PHRASES,
  VERDICT_CONTENT,
  coverageContent,
  evidenceContent,
  type StatusContent,
} from '../src/content/status-content.ts';
import { validateGateRunForm, validateImportForm, emptyGateRunForm } from '../src/forms/validation.ts';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? sourceFiles(full) : [full];
  });
}

const allContent = (): StatusContent[] => [
  ...Object.values(LIFECYCLE_CONTENT),
  ...Object.values(VERDICT_CONTENT),
  ...Object.values(EVIDENCE_CLASS_CONTENT),
  ...Object.values(EVIDENCE_SCOPE_CONTENT),
  ...Object.values(ATTESTATION_CONTENT),
  ...Object.values(COVERAGE_BASIS_CONTENT),
  ...Object.values(ENFORCEMENT_CONTENT),
  ...Object.values(COMPATIBILITY_CONTENT),
  ...Object.values(IMPORT_STATE_CONTENT),
];

describe('status content map', () => {
  it('covers every closed contract value', () => {
    for (const v of EXECUTION_LIFECYCLES) expect(LIFECYCLE_CONTENT[v]).toBeDefined();
    for (const v of VERDICTS) expect(VERDICT_CONTENT[v]).toBeDefined();
    for (const v of EVIDENCE_CLASSES) expect(EVIDENCE_CLASS_CONTENT[v]).toBeDefined();
    for (const v of EVIDENCE_SCOPES) expect(EVIDENCE_SCOPE_CONTENT[v]).toBeDefined();
    for (const v of EVIDENCE_REASONS) expect(EVIDENCE_REASON_TEXT[v]).toBeDefined();
    for (const v of SUBJECT_ATTESTATION_CLASSES) expect(ATTESTATION_CONTENT[v]).toBeDefined();
    for (const v of EFFECT_COVERAGE_BASES) expect(COVERAGE_BASIS_CONTENT[v]).toBeDefined();
    for (const v of ENFORCEMENT_MODES) expect(ENFORCEMENT_CONTENT[v]).toBeDefined();
    for (const v of IMPORT_STATES) expect(IMPORT_STATE_CONTENT[v]).toBeDefined();
  });

  it('names the eight axes separately', () => {
    expect(AXIS_NAMES).toEqual([
      'Execution state',
      'Verdict',
      'Evidence',
      'Subject identity',
      'Effect coverage',
      'Artifact',
      'Enforcement',
      'Official compatibility',
    ]);
  });

  it('uses the required phrases', () => {
    expect(EVIDENCE_SCOPE_CONTENT.SIMULATED_GROUND_TRUTH.label).toBe('proven within scenario');
    expect(EVIDENCE_SCOPE_CONTENT.SUBJECT_REPORTED.label).toBe(
      'reported by subject; does not prove coverage',
    );
    expect(COVERAGE_BASIS_CONTENT.DECLARED_HOOKS_ONLY.label).toBe('Declared hooks only — REVIEW');
    expect(COVERAGE_BASIS_CONTENT.INDEPENDENT_BOUNDARY_INTERCEPT.label).toBe('Independent boundary');
    expect(COVERAGE_BASIS_CONTENT.TRUSTED_BUILD_INVENTORY_PLUS_INTERCEPT.label).toBe('Inventory + boundary');
    expect(ENFORCEMENT_CONTENT.REQUIRED_CHECK_UNVERIFIED.label).toBe(
      'Required check — verification unavailable',
    );
    expect(VERDICT_CONTENT.PASS.description).toBe('All required cases passed for these exact revisions.');
    expect(VERDICT_CONTENT.NOT_RUN.description).toBe('No complete evaluation exists.');
  });

  it('never claims release blocking', () => {
    for (const c of allContent()) {
      for (const phrase of PROHIBITED_PHRASES) {
        expect(c.label.includes(phrase) || c.description.includes(phrase)).toBe(false);
      }
      expect(/\bblock(s|ing)? (the )?release\b/i.test(`${c.label} ${c.description}`)).toBe(false);
    }
  });

  it('reserves the pass tone for the PASS verdict only', () => {
    const passTones = allContent().filter((c) => c.tone === 'pass');
    expect(passTones).toEqual([VERDICT_CONTENT.PASS]);
  });

  it('keeps private evidence visibly private and self-reports labelled', () => {
    expect(
      evidenceContent({ class: 'UNKNOWN', scope: 'PRIVATE_NOT_VISIBLE', reasons: ['NOT_VISIBLE'] }).tone,
    ).toBe('private');
    expect(evidenceContent({ class: 'REPORTED', scope: 'SUBJECT_REPORTED', reasons: [] }).label).toContain(
      'does not prove coverage',
    );
    expect(
      evidenceContent({ class: 'PROVEN', scope: 'SIMULATED_GROUND_TRUTH', reasons: [] }).label,
    ).toContain('proven within scenario');
  });

  it('shows incomplete or stale coverage as REVIEW', () => {
    const base = {
      missing: ['payout sink'],
      interceptorProfileId: 'i',
      interceptorFreshness: 'FRESH' as const,
      processTreeScope: null,
    };
    expect(
      coverageContent({ ...base, basis: 'INDEPENDENT_BOUNDARY_INTERCEPT', finding: 'INCOMPLETE' }).label,
    ).toContain('REVIEW');
    expect(
      coverageContent({
        ...base,
        basis: 'INDEPENDENT_BOUNDARY_INTERCEPT',
        finding: 'COMPLETE',
        interceptorFreshness: 'STALE',
      }).label,
    ).toContain('REVIEW');
    expect(coverageContent({ ...base, basis: null, finding: 'NOT_EVALUATED' }).tone).toBe('review');
  });
});

describe('source guardrails', () => {
  const files = sourceFiles(SRC);
  const read = (f: string) => readFileSync(f, 'utf8');
  // Code only: comments may name forbidden APIs while explaining why they are not used.
  const code = (f: string) =>
    read(f)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('keeps credentials out of browser storage', () => {
    for (const f of files) {
      const text = code(f);
      const rel = relative(SRC, f).replace(/\\/g, '/');
      expect(/sessionStorage|indexedDB|document\.cookie/.test(text), rel).toBe(false);
      if (rel !== 'app/theme.ts') expect(/localStorage/.test(text), rel).toBe(false);
    }
    // The single localStorage use stores only the theme preference.
    expect(read(join(SRC, 'app/theme.ts'))).toMatch(/const KEY = 'routespec\.console\.theme'/);
  });

  it('never renders raw HTML or uses component-local colors or z-index values', () => {
    for (const f of files) {
      const text = read(f);
      const rel = relative(SRC, f).replace(/\\/g, '/');
      expect(text.includes('dangerouslySetInnerHTML'), rel).toBe(false);
      expect(text.includes('innerHTML'), rel).toBe(false);
      if (rel !== 'styles/tokens.css') {
        expect(/#[0-9a-fA-F]{3,8}\b/.test(text.replace(/href=\{?`?#|`#\$\{/g, '')), rel).toBe(false);
        expect(/z-index:\s*\d/.test(text), rel).toBe(false);
      }
    }
  });

  it('has no emoji or decorative gradients', () => {
    for (const f of files) {
      const text = read(f);
      const rel = relative(SRC, f);
      expect(/\p{Extended_Pictographic}/u.test(text), rel).toBe(false);
      expect(/linear-gradient|radial-gradient|backdrop-filter/.test(text), rel).toBe(false);
    }
  });

  it('does not hard-code verdicts in page code', () => {
    for (const f of files.filter((x) => /pages[\\/]|components[\\/]/.test(x))) {
      const text = read(f);
      // Pages read verdicts from typed records; they never assign a literal verdict.
      expect(/verdict\s*[:=]\s*['"](PASS|FAIL|REVIEW)['"]/.test(text), relative(SRC, f)).toBe(false);
    }
  });
});

describe('form validation', () => {
  it('reports every invalid gate-run field and keeps valid input untouched', () => {
    const values = {
      ...emptyGateRunForm(),
      revisionId: 'rev-1',
      artifactDigest: 'sha256:abc',
      parallelism: '99',
    };
    const errors = validateGateRunForm(values);
    const fields = errors.map((e) => e.field);
    expect(fields).toContain('artifactDigest');
    expect(fields).toContain('parallelism');
    expect(fields).toContain('buildRevisionId');
    expect(fields).not.toContain('revisionId');
    expect(values.revisionId).toBe('rev-1');
  });

  it('requires an attestation id only when one is chosen', () => {
    const ok = {
      ...emptyGateRunForm(),
      revisionId: 'r',
      buildRevisionId: 'b',
      artifactDigest: `sha256:${'a'.repeat(64)}`,
      corpusRevisionId: 'c',
      effectManifestDigest: `sha256:${'b'.repeat(64)}`,
      effectCoveragePolicyDigest: `sha256:${'c'.repeat(64)}`,
      adapterRevision: 'a',
      evaluatorRevision: 'e',
      configurationDigest: `sha256:${'d'.repeat(64)}`,
    };
    expect(validateGateRunForm(ok)).toEqual([]);
    expect(validateGateRunForm({ ...ok, attestationChoice: 'ATTESTATION_ID' }).map((e) => e.field)).toEqual([
      'subjectAttestationId',
    ]);
  });

  it('validates trace imports without reading their content', () => {
    expect(
      validateImportForm({ fileName: '', sizeBytes: null, acknowledged: false }).map((e) => e.field),
    ).toEqual(['traceFile', 'acknowledged']);
    expect(
      validateImportForm({ fileName: 'a.exe', sizeBytes: 10, acknowledged: true }).map((e) => e.code),
    ).toEqual(['FILE_TYPE']);
    expect(
      validateImportForm({ fileName: 'a.json', sizeBytes: 3 * 1024 * 1024, acknowledged: true }).map(
        (e) => e.code,
      ),
    ).toEqual(['TOO_LARGE']);
    expect(validateImportForm({ fileName: 'a.yaml', sizeBytes: 10, acknowledged: true })).toEqual([]);
  });
});
