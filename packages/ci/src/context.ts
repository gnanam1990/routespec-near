/**
 * CI context and trust classification (FR-14, FR-17, NFR-03; SECURITY.md section 12).
 *
 * The context is read from the CI environment and the event payload file only. Nothing here
 * contacts a remote service. Trust is decided by fixed rules, fail-closed:
 *
 * | event                                         | trust          |
 * | --------------------------------------------- | -------------- |
 * | not running under GitHub Actions              | LOCAL          |
 * | push / workflow_dispatch / schedule / merge_group on a trusted ref | TRUSTED |
 * | the same events on any other ref              | UNTRUSTED      |
 * | pull_request from the same repository         | PULL_REQUEST   |
 * | pull_request from another repository (fork), or a payload that cannot prove otherwise | FORK |
 * | pull_request_target (base workflow with secrets running for head content) | FORK |
 * | every other event                             | UNTRUSTED      |
 *
 * Only LOCAL and TRUSTED may upload evidence bundles or extra files and be eligible for a
 * separately authorized live-dry probe. No context ever receives provider secrets from the
 * action: see `secrets.ts`.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';

export type CiProvider = 'GITHUB_ACTIONS' | 'LOCAL';
export type CiTrust = 'LOCAL' | 'TRUSTED' | 'PULL_REQUEST' | 'FORK' | 'UNTRUSTED';

export interface CiIdentity {
  readonly repository: string;
  readonly repositoryId: string | null;
  readonly commitSha: string;
  readonly ref: string;
  readonly workflowRef: string;
  readonly runId: string;
  readonly runAttempt: string;
}

export interface CiContext {
  readonly provider: CiProvider;
  readonly event: string;
  readonly trust: CiTrust;
  /** Present only under GitHub Actions; every field comes from the runner environment. */
  readonly identity: CiIdentity | null;
  /** The head repository of a pull request, when the payload names one. */
  readonly headRepository: string | null;
  readonly findings: readonly string[];
}

export const DEFAULT_TRUSTED_REFS: readonly string[] = Object.freeze(['refs/heads/main']);

const TRUSTED_EVENTS = new Set(['push', 'workflow_dispatch', 'schedule', 'merge_group']);
const MAX_EVENT_BYTES = 4 * 1024 * 1024;

function readEventPayload(path: string | undefined): Record<string, unknown> | null {
  if (path === undefined || path === '' || !existsSync(path)) return null;
  try {
    if (!statSync(path).isFile() || statSync(path).size > MAX_EVENT_BYTES) return null;
    const v = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function headOf(payload: Record<string, unknown> | null): { fullName: string | null; fork: boolean | null } {
  const repo = obj(obj(obj(payload?.['pull_request'])?.['head'])?.['repo']);
  if (!repo) return { fullName: null, fork: null };
  return {
    fullName: typeof repo['full_name'] === 'string' ? repo['full_name'] : null,
    fork: typeof repo['fork'] === 'boolean' ? repo['fork'] : null,
  };
}

/** Classify the CI context. `env` is the runner environment; nothing is mutated. */
export function readCiContext(
  env: Readonly<Record<string, string | undefined>>,
  options: { trustedRefs?: readonly string[] } = {},
): CiContext {
  if (env['GITHUB_ACTIONS'] !== 'true') {
    return {
      provider: 'LOCAL',
      event: 'local',
      trust: 'LOCAL',
      identity: null,
      headRepository: null,
      findings: [],
    };
  }
  const findings: string[] = [];
  const event = env['GITHUB_EVENT_NAME'] ?? '';
  const identity: CiIdentity = {
    repository: env['GITHUB_REPOSITORY'] ?? '',
    repositoryId: env['GITHUB_REPOSITORY_ID'] ?? null,
    commitSha: env['GITHUB_SHA'] ?? '',
    ref: env['GITHUB_REF'] ?? '',
    workflowRef: env['GITHUB_WORKFLOW_REF'] ?? '',
    runId: env['GITHUB_RUN_ID'] ?? '',
    runAttempt: env['GITHUB_RUN_ATTEMPT'] ?? '',
  };
  const trustedRefs = options.trustedRefs ?? DEFAULT_TRUSTED_REFS;
  let trust: CiTrust;
  let headRepository: string | null = null;
  if (TRUSTED_EVENTS.has(event)) {
    trust = trustedRefs.includes(identity.ref) ? 'TRUSTED' : 'UNTRUSTED';
    if (trust === 'UNTRUSTED') findings.push('REF_NOT_TRUSTED');
  } else if (event === 'pull_request') {
    const head = headOf(readEventPayload(env['GITHUB_EVENT_PATH']));
    headRepository = head.fullName;
    if (head.fullName === null || head.fork === null) {
      trust = 'FORK';
      findings.push('PULL_REQUEST_HEAD_UNPROVEN');
    } else if (head.fork || head.fullName !== identity.repository) {
      trust = 'FORK';
      findings.push('PULL_REQUEST_FROM_FORK');
    } else {
      trust = 'PULL_REQUEST';
    }
  } else if (event === 'pull_request_target') {
    trust = 'FORK';
    headRepository = headOf(readEventPayload(env['GITHUB_EVENT_PATH'])).fullName;
    findings.push('PULL_REQUEST_TARGET_UNTRUSTED');
  } else {
    trust = 'UNTRUSTED';
    findings.push('EVENT_NOT_TRUSTED');
  }
  return { provider: 'GITHUB_ACTIONS', event, trust, identity, headRepository, findings };
}

/** Whether this context may run reviewed privileged steps (bundles, extra uploads, live-dry eligibility). */
export function isTrusted(ctx: CiContext): boolean {
  return ctx.trust === 'TRUSTED' || ctx.trust === 'LOCAL';
}
