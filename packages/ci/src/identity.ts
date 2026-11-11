/**
 * Build identity measured by the CI step itself (FR-01, INV-12).
 *
 * Every digest here is computed from bytes the action reads: the configured artifact files (in
 * configured order), the dependency lockfile, the effect manifest, the client launch module, and
 * the reviewed CI configuration. The commit comes from the workspace checkout (`git rev-parse`
 * with fixed arguments, no shell) and must equal the commit the CI runner reports; a mismatch
 * is stale workflow metadata. The resulting build row stays `USER_ASSERTED_LOCAL`: measuring
 * bytes inside the job does not make the job a trust root.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { RouteSpecError, digestValue } from '@routespec/contracts';
import type { CiConfig } from './config.ts';
import { resolveInside } from './config.ts';
import type { CiContext } from './context.ts';

export interface MeasuredIdentity {
  readonly commitSha: string;
  readonly repositoryLocator: string;
  readonly dirtyTreeDigest: string | null;
  readonly artifactDigest: string;
  readonly lockDigest: string;
  readonly toolchainDigest: string;
  readonly manifestDigest: string;
  readonly launchRecipeDigest: string;
  readonly configurationDigest: string;
  readonly ciWorkflowRunId: string | null;
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Artifact digest: SHA-256 over the concatenated bytes of the configured files, in order. */
export function artifactDigest(workspace: string, files: readonly string[]): string {
  return sha256(
    Buffer.concat(
      files.map((f, i) => readFileSync(resolveInside(workspace, f, `subject.artifactFiles.${i}`))),
    ),
  );
}

function git(workspace: string, args: readonly string[]): string {
  try {
    return execFileSync('git', ['-C', workspace, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
      env: { PATH: process.env['PATH'] ?? '', SystemRoot: process.env['SystemRoot'] ?? '' },
    });
  } catch {
    throw new RouteSpecError('RS_IDENTITY_MISMATCH', 'The workspace is not a readable git checkout.', {
      details: { reason: 'WORKSPACE_NOT_A_CHECKOUT' },
    });
  }
}

export function measureIdentity(
  workspace: string,
  configPath: string,
  config: CiConfig,
  ctx: CiContext,
): MeasuredIdentity {
  const head = git(workspace, ['rev-parse', 'HEAD']).trim();
  if (!/^[0-9a-f]{40}$/.test(head)) {
    throw new RouteSpecError('RS_IDENTITY_MISMATCH', 'The workspace HEAD is not a commit.', {
      details: { reason: 'WORKSPACE_HEAD_INVALID' },
    });
  }
  const status = git(workspace, ['status', '--porcelain=v1', '--untracked-files=no']);
  const id = ctx.identity;
  if (id !== null) {
    const missing = (
      [
        ['repository', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/],
        ['commitSha', /^[0-9a-f]{40}$/],
        ['ref', /^refs\/\S+$/],
        ['workflowRef', /^\S+@\S+$/],
        ['runId', /^\d{1,20}$/],
        ['runAttempt', /^\d{1,6}$/],
      ] as const
    ).filter(([k, re]) => !re.test(id[k]));
    if (missing.length > 0) {
      throw new RouteSpecError('RS_IDENTITY_MISMATCH', 'The CI run identity is incomplete.', {
        details: { reason: 'CI_IDENTITY_INCOMPLETE', field: missing[0]?.[0] ?? 'unknown' },
      });
    }
    if (id.commitSha !== head) {
      throw new RouteSpecError(
        'RS_IDENTITY_MISMATCH',
        'The commit reported by the CI runner differs from the checked-out workspace (stale workflow metadata).',
        { details: { reason: 'STALE_WORKFLOW_METADATA' } },
      );
    }
    const pin = config.pinnedIdentity;
    const pinned: Array<[string, string | undefined, string | null]> = [
      ['repository', pin?.repository, id.repository],
      ['repositoryId', pin?.repositoryId, id.repositoryId],
      ['workflowRef', pin?.workflowRef, id.workflowRef],
    ];
    for (const [field, expected, actual] of pinned) {
      if (expected !== undefined && expected !== actual) {
        throw new RouteSpecError(
          'RS_IDENTITY_MISMATCH',
          'The CI run identity differs from the pinned identity.',
          {
            details: { reason: 'PINNED_IDENTITY_MISMATCH', field },
          },
        );
      }
    }
  }
  const artifact = artifactDigest(workspace, config.subject.artifactFiles);
  if (
    config.subject.expectedArtifactDigest !== undefined &&
    config.subject.expectedArtifactDigest !== artifact
  ) {
    throw new RouteSpecError(
      'RS_IDENTITY_MISMATCH',
      'The measured artifact differs from the pinned artifact digest.',
      {
        details: { reason: 'ARTIFACT_DIGEST_MISMATCH' },
      },
    );
  }
  const file = (p: string, field: string) => sha256(readFileSync(resolveInside(workspace, p, field)));
  return {
    commitSha: head,
    repositoryLocator: id !== null ? `github:${id.repository}` : 'git+file:workspace',
    dirtyTreeDigest: status.trim() === '' ? null : digestValue('routespec.ci-dirty-tree/1', status),
    artifactDigest: artifact,
    lockDigest: file(config.subject.lockFile, 'subject.lockFile'),
    toolchainDigest: digestValue('routespec.ci-toolchain/1', {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    }),
    manifestDigest: file(config.subject.manifestFile, 'subject.manifestFile'),
    launchRecipeDigest: digestValue('routespec.ci-launch-recipe/1', {
      clientModule: file(config.subject.clientModule, 'subject.clientModule'),
      mode: config.gate.mode,
    }),
    configurationDigest: file(configPath, 'config'),
    ciWorkflowRunId: id !== null ? `${id.runId}/${id.runAttempt}` : null,
  };
}
