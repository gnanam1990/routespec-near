/**
 * Security fix (routespec vuln-0002): the high-confidence credential shapes (provider JWT,
 * case token `rsct_`, control token `rsctl_`) must be detected wherever they appear in a
 * string, including when a letter, digit or underscore sits immediately before them. A leading
 * word-boundary anchor let `x<jwt>`, `jwt_<jwt>` and `case_rsct_...` pass every detector layer.
 * Supplementary module test; it claims no canonical test ID.
 *
 * Synthetic values are assembled at runtime so the repository secret scan never sees them.
 */
import { describe, expect, it } from 'vitest';
import { Redactor } from '@routespec/proxy';
import { FindingSet, scanSecretsInString } from '@routespec/regressions';
import { Logger } from '@routespec/runner';
import { assertNoSecrets, persistedSecretRule } from '@routespec/store';

const seg = (c: string): string => c.repeat(16);
const jwt = ['eyJ' + seg('a'), 'eyJ' + seg('b'), seg('c')].join('.');
const caseTok = 'rsct' + '_' + 'A'.repeat(32);
const controlTok = 'rsctl' + '_' + 'B'.repeat(32);

const PREFIXES = ['', 'x', '7', '_', 'jwt_', 'case_'];
const variants = (v: string): string[] => PREFIXES.map((p) => p + v);

function storeRejects(v: string): boolean {
  try {
    assertNoSecrets({ customRecipientMsg: v });
    return false;
  } catch {
    return true;
  }
}

describe('credential shapes are detected regardless of the preceding character', () => {
  const redactor = new Redactor();

  for (const [name, base] of [
    ['jwt', jwt],
    ['case-token', caseTok],
    ['control-token', controlTok],
  ] as const) {
    for (const v of variants(base)) {
      const label = `${name} with prefix "${v.slice(0, v.length - base.length)}"`;

      it(`proxy redactor flags and redacts ${label}`, () => {
        expect(redactor.findIn({ customRecipientMsg: v }).length).toBeGreaterThan(0);
        expect(redactor.redactText(v)).not.toContain(base);
      });

      it(`store write guard rejects ${label}`, () => {
        expect(storeRejects(v)).toBe(true);
      });

      it(`runner log redacts ${label}`, () => {
        const lines: string[] = [];
        new Logger({ sink: (l) => lines.push(l) }).log({ level: 'info', code: 'T', details: { msg: v } });
        expect(lines.join('\n')).not.toContain(base);
      });
    }
  }

  for (const [name, base] of [
    ['case-token', caseTok],
    ['control-token', controlTok],
  ] as const) {
    for (const v of variants(base)) {
      it(`journal boundary refuses ${name} with prefix "${v.slice(0, v.length - base.length)}"`, () => {
        expect(persistedSecretRule(v)).not.toBeNull();
      });
    }
  }

  for (const [name, base] of [
    ['jwt', jwt],
    ['case-token', caseTok],
  ] as const) {
    for (const v of variants(base)) {
      it(`trace scan flags ${name} with prefix "${v.slice(0, v.length - base.length)}"`, () => {
        const findings = new FindingSet();
        scanSecretsInString(v, '$.msg', findings, []);
        expect(findings.rejecting).toBe(true);
      });
    }
  }

  it('ordinary identifiers and digests are not flagged', () => {
    for (const v of ['rsct', 'rsct_short', 'sha256:' + 'ab'.repeat(32), 'eyJ-not-a-jwt', 'parsct_x']) {
      expect(redactor.findIn({ v })).toEqual([]);
      expect(storeRejects(v)).toBe(false);
      expect(persistedSecretRule(v)).toBeNull();
    }
  });
});
