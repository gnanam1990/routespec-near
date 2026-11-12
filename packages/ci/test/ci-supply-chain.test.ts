/**
 * M10 supply-chain and workflow policy checks (NFR-10, NFR-11; M10 deliverables 4, 5, 7). Not an
 * owned canonical test: these are static checks over the committed workflow files plus a local
 * run of the repository's own self-gate configuration through the real action entry point.
 *
 * - Every third-party action is pinned to a full commit SHA; local actions are allowed.
 * - Workflows grant only `contents: read`, never trigger on pull_request_target or other
 *   privileged events, reference no secrets, keep expressions out of shell scripts, and check out
 *   without persisting credentials.
 * - The repository checks run on Linux, macOS, and Windows and rerun the T-027 and T-009
 *   canonical parity regressions.
 * - The upload step uploads only the staged directory with the staged retention.
 * - The SBOM is deterministic and lists the pinned official SDK.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CORE_SCENARIO_SOURCES, compileScenario, parseScenarioSource } from '@routespec/scenario';
import { buildSbom, loadCiConfig, parsePnpmLock } from '../src/index.ts';
import { ROOT, fixture, runCi, type Fixture } from './support/harness.ts';

type J = Record<string, unknown>;
const LIMITS = { maxSourceBytes: 256 * 1024, maxDepth: 32, maxAliases: 0, maxStringLength: 16 * 1024 };
const FILES = {
  action: '.github/actions/routespec-gate/action.yml',
  ci: '.github/workflows/ci.yml',
  gate: '.github/workflows/routespec-gate.yml',
  reusable: 'docs/ci/routespec-gate.reusable.example.yml',
};

function load(rel: string): { text: string; doc: J } {
  const text = readFileSync(join(ROOT, rel), 'utf8');
  return { text, doc: parseScenarioSource(text, 'yaml', LIMITS) as J };
}

function steps(doc: J): J[] {
  const runs = doc['runs'] as J | undefined;
  if (runs) return runs['steps'] as J[];
  return Object.values(doc['jobs'] as Record<string, J>).flatMap((j) => (j['steps'] as J[]) ?? []);
}

const fixtures: Fixture[] = [];
afterAll(() => fixtures.forEach((f) => f.cleanup()));

describe('M10 workflow and supply-chain policy', () => {
  it('pins every third-party action to a full commit SHA', () => {
    for (const rel of Object.values(FILES)) {
      for (const step of steps(load(rel).doc)) {
        const uses = step['uses'];
        if (typeof uses !== 'string') continue;
        if (uses.startsWith('./')) continue;
        expect(uses, rel).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?@[0-9a-f]{40}$/);
      }
    }
  });

  it('uses least privilege, safe triggers, no secrets, and no expressions inside scripts', () => {
    for (const rel of [FILES.ci, FILES.gate, FILES.reusable]) {
      const { text, doc } = load(rel);
      expect(doc['permissions'], rel).toEqual({ contents: 'read' });
      const on = Object.keys(doc['on'] as J);
      for (const banned of ['pull_request_target', 'workflow_run', 'issue_comment'])
        expect(on, rel).not.toContain(banned);
      expect(text, rel).not.toMatch(/\$\{\{[^}]*\bsecrets\b/);
      expect(text, rel).not.toMatch(/:\s*write\b/);
      for (const job of Object.values(doc['jobs'] as Record<string, J>))
        expect(job['permissions'], rel).toBeUndefined();
    }
    for (const rel of Object.values(FILES)) {
      for (const step of steps(load(rel).doc)) {
        if (typeof step['run'] === 'string')
          expect(step['run'], `${rel}: ${String(step['name'])}`).not.toContain('${{');
        if (String(step['uses'] ?? '').startsWith('actions/checkout@')) {
          expect((step['with'] as J)['persist-credentials'], rel).toBe(false);
        }
      }
    }
  });

  it('runs the checks and the canonical parity regressions on Linux, macOS, and Windows', () => {
    const { doc } = load(FILES.ci);
    const job = (doc['jobs'] as Record<string, J>)['check'] as J;
    const os = ((job['strategy'] as J)['matrix'] as J)['os'] as string[];
    expect(os.some((o) => o.startsWith('ubuntu-'))).toBe(true);
    expect(os.some((o) => o.startsWith('macos-'))).toBe(true);
    expect(os.some((o) => o.startsWith('windows-'))).toBe(true);
    const runs = steps(doc).map((s) => String(s['run'] ?? ''));
    expect(runs.some((r) => r.includes('pnpm install --frozen-lockfile'))).toBe(true);
    expect(runs.some((r) => r.includes('pnpm run check'))).toBe(true);
    expect(
      runs.some(
        (r) => r.includes('t027-canonical-result.test.ts') && r.includes('t009-replay-digest.test.ts'),
      ),
    ).toBe(true);
  });

  it('uploads only the staged directory with the staged, bounded retention', () => {
    for (const rel of [FILES.gate, FILES.reusable]) {
      const upload = steps(load(rel).doc).find((s) =>
        String(s['uses'] ?? '').startsWith('actions/upload-artifact@'),
      ) as J;
      const w = upload['with'] as J;
      expect(w['path'], rel).toBe('${{ steps.gate.outputs.upload-directory }}');
      expect(w['retention-days'], rel).toBe('${{ steps.gate.outputs.retention-days }}');
      expect(w['if-no-files-found'], rel).toBe('error');
    }
    const action = load(FILES.action);
    const run = steps(action.doc).find((s) => s['id'] === 'gate') as J;
    expect(run['env']).toMatchObject({ ROUTESPEC_CI_CONFIG: '${{ inputs.config }}' });
  });

  it('the self-gate configuration is valid and its scenario is the reviewed core scenario', () => {
    const config = loadCiConfig('.github/routespec/routespec.ci.json', ROOT);
    expect(config.gate.enforcement).toBe('CI_CHECK');
    // Same compiled scenario revision as the reviewed core source (formatting may differ).
    expect(
      compileScenario(readFileSync(join(ROOT, '.github/routespec/happy-path.yaml'), 'utf8')).revisionDigest,
    ).toBe(compileScenario(CORE_SCENARIO_SOURCES['happy-path'] as string).revisionDigest);
  });

  it('the self-gate configuration passes locally through the real action entry point', async () => {
    const f = fixture('m10-self');
    fixtures.push(f);
    const r = await runCi(
      [
        'run',
        '--config',
        '.github/routespec/routespec.ci.json',
        '--workspace',
        ROOT,
        '--work-dir',
        join(f.work, 'work'),
      ],
      {},
    );
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.json).toMatchObject({
      decision: 'PASS',
      conclusion: 'success',
      enforcement: { mode: 'LOCAL_ADVISORY' },
    });
  });

  it('produces a deterministic SBOM from the lockfile that lists the pinned official SDK', async () => {
    const lock = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8');
    const components = parsePnpmLock(lock);
    expect(components.length).toBeGreaterThan(50);
    expect(components).toContainEqual(
      expect.objectContaining({ name: '@defuse-protocol/one-click-sdk-typescript', version: '0.1.26' }),
    );
    const a = JSON.stringify(buildSbom(lock, { node: 'v22.23.1', pnpm: '10.34.9' }));
    const b = JSON.stringify(buildSbom(lock, { node: 'v22.23.1', pnpm: '10.34.9' }));
    expect(a).toBe(b);
    expect(a).not.toContain(ROOT.replace(/\\/g, '\\\\'));
    const sbom = JSON.parse(a) as J;
    expect(sbom).toMatchObject({ bomFormat: 'CycloneDX', specVersion: '1.5' });
    const zod = (sbom['components'] as J[]).find((c) => c['name'] === 'zod') as J;
    expect(zod['purl']).toBe('pkg:npm/zod@4.6.7');
    expect((zod['hashes'] as J[])[0]).toMatchObject({
      alg: 'SHA-512',
      content: expect.stringMatching(/^[0-9a-f]{128}$/),
    });
  });
});
