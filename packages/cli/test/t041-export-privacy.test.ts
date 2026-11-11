/**
 * T-041 — Export privacy scan blocks sensitive material. Covers FR-17, FR-18.
 *
 * A real gate evaluation (CLI, launcher, proxy, journal, kernel, installed subject) is exported.
 * Credential, authorization, cookie, private-key, signed-payload, author-machine-path, and
 * configured-secret canaries are seeded through operator attachments, and real journal
 * addresses are included on request. The plan is blocked (exit 6), reports categories and
 * locations without values, persists no content, and cannot be written. No canary value
 * appears on stdout, stderr, or in the journal database/WAL. Masked addresses pass; raw
 * addresses need an explicit acknowledgement.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planExport } from '@routespec/runner';
import { GateJournal, RouteSpecStore } from '@routespec/store';
import { runCliProcess, runGateWithSubjects, setupJournal, tempDir } from './support/product.ts';

// Secret-shaped canaries are assembled at run time so the repository itself holds none.
const PEM_BEGIN = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
const PEM_END = ['-----END ', 'PRIVATE KEY-----'].join('');
const CANARY = {
  jwt: ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ0MDQxY2FuYXJ5In0', 'c2lnbmF0dXJlY2FuYXJ5MDQx'].join('.'),
  bearer: 'canarybearerT041token',
  cookie: 'session=canary-cookie-T041',
  pem: 'MIIBcanaryT041privatekeymaterial',
  signed: `0x${'ab'.repeat(40)}cafe${'cd'.repeat(30)}`,
  configured: 'configured-canary-T041-value',
};

let tmp: ReturnType<typeof tempDir>;
let gateEvaluationId = '';
let files: { jwt: string; auth: string; cookie: string; key: string; signed: string; path: string };

beforeAll(async () => {
  tmp = tempDir();
  const j = setupJournal(tmp.dir, { scenarios: ['happy-path'], build: 'reconciling-client', label: 't041' });
  const r = await runGateWithSubjects(j);
  expect(r.exitCode).toBe(0);
  gateEvaluationId = (r.json?.['report'] as { gateEvaluationId: string }).gateEvaluationId;
  files = {
    jwt: join(tmp.dir, 'notes.txt'),
    auth: join(tmp.dir, 'auth.json'),
    cookie: join(tmp.dir, 'cookie.json'),
    key: join(tmp.dir, 'key.pem.txt'),
    signed: join(tmp.dir, 'signed.json'),
    path: join(tmp.dir, 'paths.txt'),
  };
  writeFileSync(files.jwt, `token from a support chat: ${CANARY.jwt}\n`);
  writeFileSync(files.auth, JSON.stringify({ headers: { authorization: `Bearer ${CANARY.bearer}` } }));
  writeFileSync(files.cookie, JSON.stringify({ headers: { cookie: CANARY.cookie } }));
  writeFileSync(files.key, `${PEM_BEGIN}\n${CANARY.pem}\n${PEM_END}\n`);
  writeFileSync(files.signed, JSON.stringify({ signedTransaction: CANARY.signed }));
  writeFileSync(files.path, `journal kept at ${tmp.dir}\n`);
});

afterAll(() => tmp?.cleanup());

function assertNoCanary(text: string, label: string): void {
  for (const [name, value] of Object.entries(CANARY))
    expect(text.includes(value), `${label}:${name}`).toBe(false);
}

function journalBytes(): string {
  return readdirSync(tmp.dir)
    .filter((f) => f.startsWith('journal.db'))
    .map((f) => readFileSync(join(tmp.dir, f)).toString('latin1'))
    .join('');
}

describe('T-041 — Export privacy scan blocks sensitive material', () => {
  it('seeded credential, cookie, private key, signed payload, address, and path findings block the export', async () => {
    const args = [
      'export',
      'plan',
      '--data',
      tmp.dir,
      '--gate-evaluation',
      gateEvaluationId,
      '--include-addresses',
    ];
    for (const f of Object.values(files)) args.push('--attach', f);
    const r = await runCliProcess(args);
    expect(r.exitCode).toBe(6);
    const out = r.json as {
      blocked: boolean;
      confirm: string | null;
      findings: Array<{ category: string; path: string; blocking: boolean }>;
      error: { code: string };
    };
    expect(out.error.code).toBe('RS_EXPORT_BLOCKED');
    expect(out.blocked).toBe(true);
    expect(out.confirm).toBeNull();
    const categories = new Set(out.findings.map((f) => f.category));
    for (const c of [
      'CREDENTIAL',
      'AUTHORIZATION_HEADER',
      'COOKIE',
      'PRIVATE_KEY',
      'SIGNED_PAYLOAD',
      'SENSITIVE_ADDRESS',
      'LOCAL_PATH',
    ]) {
      expect(categories.has(c), c).toBe(true);
    }
    // Locations name the entry and JSON path, never the value.
    expect(out.findings.find((f) => f.category === 'COOKIE')?.path).toMatch(
      /^attachments\/03-cookie\.json#\$\.headers\.cookie$/,
    );
    expect(out.findings.find((f) => f.category === 'SIGNED_PAYLOAD')?.path).toMatch(
      /^attachments\/05-signed\.json#/,
    );
    expect(
      out.findings.some(
        (f) => f.category === 'SENSITIVE_ADDRESS' && f.path.startsWith('cases/000/operations.json#'),
      ),
    ).toBe(true);
    expect(out.findings.every((f) => f.blocking)).toBe(true);
    assertNoCanary(r.stdout, 'stdout');
    assertNoCanary(r.stderr, 'stderr');
    expect(r.stderr).toContain('export blocked');

    // Nothing but safe metadata persisted; the blocked plan cannot be written.
    const exportId = (r.json as { exportId: string }).exportId;
    const store = RouteSpecStore.open({ path: join(tmp.dir, 'journal.db') });
    try {
      const plan = new GateJournal(store).getExportPlan(exportId);
      expect(plan).toMatchObject({
        blocked: true,
        bundleDigest: null,
        attachments: null,
        artifactReady: false,
        privacyScanResult: 'BLOCKED',
      });
      expect(plan.entries).toEqual([]);
    } finally {
      store.close();
    }
    assertNoCanary(journalBytes(), 'journal');
    const out2 = join(tmp.dir, 'blocked.tar');
    const w = await runCliProcess([
      'export',
      'write',
      '--data',
      tmp.dir,
      '--export',
      exportId,
      '--out',
      out2,
      '--confirm',
      'sha256:' + '0'.repeat(64),
    ]);
    expect(w.exitCode).toBe(6);
    expect((w.json?.['error'] as { code: string }).code).toBe('RS_EXPORT_BLOCKED');
    expect(existsSync(out2)).toBe(false);
  });

  it('each seeded category blocks on its own', async () => {
    const expectations: Array<[string, string]> = [
      [files.jwt, 'CREDENTIAL'],
      [files.auth, 'AUTHORIZATION_HEADER'],
      [files.cookie, 'COOKIE'],
      [files.key, 'PRIVATE_KEY'],
      [files.signed, 'SIGNED_PAYLOAD'],
      [files.path, 'LOCAL_PATH'],
    ];
    for (const [file, category] of expectations) {
      const r = await runCliProcess([
        'export',
        'plan',
        '--data',
        tmp.dir,
        '--gate-evaluation',
        gateEvaluationId,
        '--attach',
        file,
      ]);
      expect(r.exitCode, category).toBe(6);
      const findings = (r.json as { findings: Array<{ category: string }> }).findings;
      expect(
        findings.map((f) => f.category),
        category,
      ).toContain(category);
      assertNoCanary(r.stdout, category);
    }
  });

  it('a configured secret value held in memory is found without being stored', () => {
    const store = RouteSpecStore.open({ path: join(tmp.dir, 'journal.db') });
    try {
      const plan = planExport(store, gateEvaluationId, {
        idempotencyKey: 't041-configured-secret',
        attachments: [{ name: 'support.txt', content: `pasted: ${CANARY.configured}` }],
        configuredSecrets: [CANARY.configured],
      });
      expect(plan.blocked).toBe(true);
      expect(plan.findings.map((f) => f.category)).toContain('CREDENTIAL');
      expect(JSON.stringify(plan)).not.toContain(CANARY.configured);
    } finally {
      store.close();
    }
    assertNoCanary(journalBytes(), 'journal');
  });

  it('masked addresses pass by default; raw addresses need an explicit acknowledgement', async () => {
    const clean = await runCliProcess([
      'export',
      'plan',
      '--data',
      tmp.dir,
      '--gate-evaluation',
      gateEvaluationId,
    ]);
    expect(clean.exitCode).toBe(0);
    expect(clean.json).toMatchObject({ blocked: false, privacyScanResult: 'CLEAN', findings: [] });
    const raw = await runCliProcess([
      'export',
      'plan',
      '--data',
      tmp.dir,
      '--gate-evaluation',
      gateEvaluationId,
      '--include-addresses',
    ]);
    expect(raw.exitCode).toBe(6);
    expect(
      new Set((raw.json as { findings: Array<{ category: string }> }).findings.map((f) => f.category)),
    ).toEqual(new Set(['SENSITIVE_ADDRESS']));
    const ack = await runCliProcess([
      'export',
      'plan',
      '--data',
      tmp.dir,
      '--gate-evaluation',
      gateEvaluationId,
      '--include-addresses',
      '--acknowledge-addresses',
    ]);
    expect(ack.exitCode).toBe(0);
    expect(ack.json).toMatchObject({ blocked: false, privacyScanResult: 'ADDRESSES_ACKNOWLEDGED' });
    expect((ack.json as { findings: Array<{ blocking: boolean }> }).findings.every((f) => !f.blocking)).toBe(
      true,
    );
  });
});
