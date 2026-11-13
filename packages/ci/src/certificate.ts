/**
 * The certificate step (M47, ADR-0028): after a gate step that decided PASS in a trusted job,
 * sign the certificate of the staged evidence bundle and submit it to the registry contract.
 *
 *   routespec-ci certificate --bundle <file> --journal <dir> --decision <gate decision>
 *     --project-key <key> --registry <account> (--network testnet|mainnet | --rpc <url>)
 *     [--trusted-refs refs/heads/main,...]
 *
 * This is a separate step with its own process, never part of the gate step: the gate step
 * loads the integrator's client module and must not hold a signer secret. The step reads
 *
 *   ROUTESPEC_ATTESTER_KEY          the attester's Ed25519 secret (PEM or ed25519:<base58>)
 *   ROUTESPEC_NEAR_SIGNER_ACCOUNT   the NEAR account that pays gas
 *   ROUTESPEC_NEAR_SIGNER_KEY       that account's key (ed25519:<base58>)
 *
 * and does nothing (exit 0) when the decision is not PASS, when the job is not trusted, or when
 * no signer is configured. A partly configured signer is a configuration error. The trust of the
 * job is read from the runner environment, not from an input. Secret values are removed from the
 * environment before anything else runs and are never printed or written.
 */
import { appendFileSync } from 'node:fs';
import { RouteSpecError } from '@routespec/contracts';
import { CERTIFICATE_ENV, exitCodeForError, runCli } from '@routespec/cli';
import { DEFAULT_TRUSTED_REFS, isTrusted, readCiContext, type CiTrust } from './context.ts';

export const CERTIFICATE_RESULT_SCHEMA = 'routespec.ci-certificate/1' as const;

export type CertificateStepStatus =
  | 'PUBLISHED'
  | 'ALREADY_PUBLISHED'
  | 'SKIPPED_DECISION_NOT_PASS'
  | 'SKIPPED_UNTRUSTED_CONTEXT'
  | 'SKIPPED_NO_SIGNER'
  | 'FAILED';

export interface CertificateStepResult {
  readonly schema: typeof CERTIFICATE_RESULT_SCHEMA;
  readonly exitCode: number;
  readonly status: CertificateStepStatus;
  readonly trust: CiTrust;
  readonly decision: string;
  readonly registry: string | null;
  readonly bundleDigest: string | null;
  readonly attester: string | null;
  readonly certificateId: number | null;
  readonly transactionHash: string | null;
  readonly findings: readonly string[];
  readonly error: { readonly code: string; readonly details: Record<string, string> } | null;
}

export interface CertificateStepOptions {
  /** The runner environment. The signer secrets are removed from it in place. */
  readonly env: Record<string, string | undefined>;
  readonly flags: Readonly<Record<string, string | boolean>>;
  readonly stderr: (line: string) => void;
}

const FLAGS = new Set([
  'bundle',
  'journal',
  'decision',
  'project-key',
  'registry',
  'network',
  'rpc',
  'trusted-refs',
]);
const SECRET_NAMES = [CERTIFICATE_ENV.attesterKey, CERTIFICATE_ENV.nearAccount, CERTIFICATE_ENV.nearKey];

function flag(flags: Readonly<Record<string, string | boolean>>, name: string): string | null {
  const v = flags[name];
  return typeof v === 'string' && v !== '' ? v : null;
}

export async function runCertificateStep(options: CertificateStepOptions): Promise<CertificateStepResult> {
  // 1. The secrets leave the environment first; they are kept only in this function's scope.
  const secrets: Record<string, string> = {};
  for (const name of SECRET_NAMES) {
    const v = options.env[name];
    if (typeof v === 'string' && v !== '') secrets[name] = v;
    delete options.env[name];
  }
  const findings: string[] = [];
  const decision = flag(options.flags, 'decision') ?? 'NONE';
  const registry = flag(options.flags, 'registry');
  let trust: CiTrust = 'UNTRUSTED';
  const done = (
    status: CertificateStepStatus,
    exitCode: number,
    extra: Partial<CertificateStepResult> = {},
  ): CertificateStepResult => ({
    schema: CERTIFICATE_RESULT_SCHEMA,
    exitCode,
    status,
    trust,
    decision,
    registry,
    bundleDigest: null,
    attester: null,
    certificateId: null,
    transactionHash: null,
    findings,
    error: null,
    ...extra,
  });
  try {
    for (const k of Object.keys(options.flags)) {
      if (!FLAGS.has(k)) {
        throw new RouteSpecError('RS_CLI_USAGE', 'Unknown certificate step input.', {
          details: { flag: k.slice(0, 64) },
        });
      }
    }
    const refs = flag(options.flags, 'trusted-refs');
    const trustedRefs = refs === null ? DEFAULT_TRUSTED_REFS : refs.split(',').map((r) => r.trim());
    if (trustedRefs.some((r) => !/^refs\/(?:heads|tags)\/[^\s]{1,200}$/.test(r))) {
      throw new RouteSpecError('RS_CLI_USAGE', 'Trusted refs must be refs/heads/... or refs/tags/....');
    }
    const ctx = readCiContext(options.env, { trustedRefs });
    trust = ctx.trust;
    const configured = Object.keys(secrets).length;

    // 2. Nothing to do: every skip is an exit 0 that says why.
    if (decision !== 'PASS') return done('SKIPPED_DECISION_NOT_PASS', 0);
    if (!isTrusted(ctx)) {
      if (configured > 0) findings.push('SIGNER_SECRET_PRESENT_IN_UNTRUSTED_JOB');
      return done('SKIPPED_UNTRUSTED_CONTEXT', 0);
    }
    if (configured === 0) return done('SKIPPED_NO_SIGNER', 0);
    if (configured !== SECRET_NAMES.length) {
      throw new RouteSpecError('RS_SCHEMA_INVALID', 'The certificate signer is only partly configured.', {
        details: { missing: SECRET_NAMES.filter((n) => !(n in secrets)).join(',') },
      });
    }
    const required = (name: string): string => {
      const v = flag(options.flags, name);
      if (v === null) {
        throw new RouteSpecError('RS_CLI_USAGE', 'A certificate step input is missing.', {
          details: { flag: name },
        });
      }
      return v;
    };
    const network = flag(options.flags, 'network');
    const rpc = flag(options.flags, 'rpc');

    // 3. Sign and submit through the real CLI command. `--expect-verdict PASS` makes the command
    // read the decision from the verified bundle itself, whatever the input said.
    let stdout = '';
    const exitCode = await runCli(
      [
        'certificate',
        'publish',
        '--data',
        required('journal'),
        '--bundle',
        required('bundle'),
        '--project-key',
        required('project-key'),
        '--registry',
        required('registry'),
        ...(network === null ? [] : ['--network', network]),
        ...(rpc === null ? [] : ['--rpc', rpc]),
        '--expect-verdict',
        'PASS',
        '--submit',
      ],
      { stdout: (t) => (stdout += t), stderr: options.stderr, env: secrets },
    );
    const json = JSON.parse(stdout) as Record<string, unknown>;
    if (exitCode !== 0) {
      const e = (json['error'] ?? {}) as { code?: string; details?: Record<string, unknown> };
      return done('FAILED', exitCode, {
        error: {
          code: e.code ?? 'RS_INTERNAL',
          details: Object.fromEntries(
            Object.entries(e.details ?? {}).map(([k, v]) => [k, String(v).slice(0, 120)]),
          ),
        },
      });
    }
    const certificate = (json['certificate'] ?? {}) as { bundle_digest?: string };
    return done(json['alreadyPublished'] === true ? 'ALREADY_PUBLISHED' : 'PUBLISHED', 0, {
      bundleDigest: certificate.bundle_digest ?? null,
      attester: typeof json['attester'] === 'string' ? json['attester'] : null,
      certificateId: typeof json['certificateId'] === 'number' ? json['certificateId'] : null,
      transactionHash: typeof json['transactionHash'] === 'string' ? json['transactionHash'] : null,
    });
  } catch (e) {
    return done('FAILED', exitCodeForError(e), {
      error:
        e instanceof RouteSpecError
          ? {
              code: e.code,
              details: Object.fromEntries(Object.entries(e.details).map(([k, v]) => [k, String(v)])),
            }
          : { code: 'RS_INTERNAL', details: {} },
    });
  }
}

const SAFE_VALUE = /^[A-Za-z0-9_.:/@+-]{0,200}$/;

/** Step outputs and summary: closed enum values, digests, identifiers. Never a secret. */
export function writeCertificateGithubFiles(
  result: CertificateStepResult,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const pairs: Array<[string, string]> = [
    ['certificate-status', result.status],
    ['certificate-id', result.certificateId === null ? '' : String(result.certificateId)],
    ['certificate-transaction', result.transactionHash ?? ''],
    ['certificate-attester', result.attester ?? ''],
    ['certificate-bundle-digest', result.bundleDigest ?? ''],
  ];
  const out = env['GITHUB_OUTPUT'];
  if (out) {
    appendFileSync(
      out,
      `${pairs.map(([k, v]) => `${k}=${SAFE_VALUE.test(v) ? v : 'UNPRINTABLE'}`).join('\n')}\n`,
      'utf8',
    );
  }
  const summary = env['GITHUB_STEP_SUMMARY'];
  if (summary) {
    const rows: Array<[string, string]> = [
      ['Status', result.status],
      ['Registry', result.registry ?? 'none'],
      ['Job trust', result.trust],
      ['Bundle digest', result.bundleDigest ?? 'n/a'],
      ['Attester', result.attester ?? 'n/a'],
      ['Certificate id', result.certificateId === null ? 'n/a' : String(result.certificateId)],
      ['Transaction', result.transactionHash ?? 'n/a'],
    ];
    const lines = [
      '## RouteSpec release certificate',
      '',
      '| Axis | Value |',
      '| --- | --- |',
      ...rows.map(([a, b]) => `| ${a} | ${(SAFE_VALUE.test(b) ? b : 'UNPRINTABLE').replace(/\|/g, '/')} |`),
      '',
      'A certificate records what an enrolled attester signed for one evidence bundle. It does not block a release and does not verify repository settings.',
    ];
    if (result.findings.length > 0)
      lines.push('', `Findings: ${result.findings.map((f) => `\`${f}\``).join(', ')}`);
    if (result.error) lines.push('', `Error: \`${result.error.code}\``);
    appendFileSync(summary, `${lines.join('\n')}\n`, 'utf8');
  }
}
