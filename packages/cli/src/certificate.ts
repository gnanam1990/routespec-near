/**
 * CLI surfaces for on-chain release certificates (M47, ADR-0029).
 *
 * - `certificate keygen`: create an Ed25519 attester key file; prints only the public key.
 * - `certificate publish`: verify an evidence bundle, build the certificate for it (bundle
 *   digest, gate verdict, corpus digest, client artifact digest, commit, timestamp), sign it with
 *   the attester key, and either write the signed envelope (`--out`) or submit it to the registry
 *   contract (`--submit`). Only a bundle that verifies and is release evidence is certified.
 * - `certificate verify`: read the registry and aggregate the release decision for a bundle or a
 *   bundle digest (see `aggregateRelease`). Exit 0 only for PASS.
 * - `certificate revoke-check`: report whether the attesters of a bundle's certificates (or the
 *   named attester keys) are still enrolled.
 * - `certificate badge` (M49): write the shields.io endpoint JSON of the "RouteSpec Certified"
 *   badge for a bundle digest, a bundle, or a project's newest certificate. The status is the
 *   digest-only release decision (the same the verify page computes in a browser).
 *
 * These are the only RouteSpec commands that contact a network, and only a NEAR JSON-RPC
 * endpoint the operator names (`--network` or `--rpc`). Gate runs and evaluations stay
 * networkless. Secrets come from a key file or from the environment, never from a flag value;
 * they are never printed, logged, or written.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RouteSpecError } from '@routespec/contracts';
import { resolveInputFile, resolveOutputFile } from '@routespec/hardening';
import {
  aggregateRelease,
  badgeStatus,
  CERTIFICATE_POLICIES,
  CERTIFICATE_VERDICTS,
  generateSigner,
  isCommitId,
  isProjectKey,
  isPublicKeyText,
  isRegistryAccountId,
  isSmallOrderPublicKey,
  latestCertificate,
  MAX_PAGE,
  NEAR_NETWORKS,
  NearRpc,
  parsePublicKey,
  publicKeyText,
  RegistryClient,
  shieldsBadge,
  signCertificate,
  signerFromSecret,
  signerToPem,
  signingPayload,
  type AttesterState,
  type BadgeStatus,
  type CertificateFields,
  type CertificatePolicy,
  type CertificateVerdict,
  type Ed25519Signer,
  type NearNetwork,
  type OnchainCertificate,
} from '@routespec/registry';
import { verifyBundle, type BundleVerification } from '@routespec/runner';
import { GateJournal, ImportJournal, type RouteSpecStore } from '@routespec/store';
import { usage, type CommandSpec, type ParsedArgs } from './args.ts';
import { EXIT, type ExitCode } from './exit.ts';

type Run = (
  args: ParsedArgs,
  ctx: {
    readonly dataDir: string | null;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly stderr: (line: string) => void;
    readonly readSource: (file: string, maxBytes: number) => string;
    readonly withStore: <T>(fn: (store: RouteSpecStore) => Promise<T> | T) => Promise<T>;
  },
) => Promise<{ exitCode: ExitCode; result: Record<string, unknown> }>;

export interface CertificateCommand {
  readonly spec: CommandSpec;
  readonly needsData: boolean;
  readonly run: Run;
}

/** Environment variables the certificate commands read. Values are never echoed. */
export const CERTIFICATE_ENV = Object.freeze({
  attesterKey: 'ROUTESPEC_ATTESTER_KEY',
  nearAccount: 'ROUTESPEC_NEAR_SIGNER_ACCOUNT',
  nearKey: 'ROUTESPEC_NEAR_SIGNER_KEY',
} as const);

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MAX_KEY_FILE_BYTES = 16 * 1024;

const CHAIN_FLAGS = {
  registry: { kind: 'string', required: true },
  network: { kind: 'string' },
  rpc: { kind: 'string' },
  'code-hash': { kind: 'string' },
} as const;

function registryFromArgs(args: ParsedArgs): string {
  const registry = args.strings['registry'] as string;
  if (!isRegistryAccountId(registry)) usage('Flag must be a NEAR account id.', { flag: 'registry' });
  return registry;
}

/** The registry client for `--network` / `--rpc`; with a named network the chain id is checked. */
async function connect(
  args: ParsedArgs,
): Promise<{ client: RegistryClient; network: string | null; codeHash: string }> {
  const registry = registryFromArgs(args);
  const network = args.strings['network'] ?? null;
  const rpcFlag = args.strings['rpc'] ?? null;
  if (network !== null && !(network in NEAR_NETWORKS)) usage('Network must be testnet or mainnet.');
  if (network === null && rpcFlag === null) usage('Name the chain with --network or --rpc.');
  const known = network === null ? null : NEAR_NETWORKS[network as NearNetwork];
  const rpc = new NearRpc(rpcFlag ?? (known as { rpcUrl: string }).rpcUrl);
  if (known !== null) {
    const chainId = await rpc.chainId();
    if (chainId !== known.chainId) {
      throw new RouteSpecError('RS_IDENTITY_MISMATCH', 'The RPC endpoint serves a different network.', {
        details: { expected: known.chainId, got: chainId.slice(0, 32) },
      });
    }
  }
  const client = new RegistryClient(rpc, registry);
  const info = await client.info();
  if (info.contract !== 'routespec-registry' || info.payloadDomain !== 'routespec.certificate/1') {
    throw new RouteSpecError(
      'RS_REGISTRY_REJECTED',
      'The account is not a RouteSpec registry of this version.',
      {
        details: { reason: 'NOT_A_ROUTESPEC_REGISTRY' },
      },
    );
  }
  // The deployed code is identified by its hash. Compare it with the digest of the reproducible
  // build (`pnpm run registry:reproduce`); with --code-hash a different contract is refused.
  const codeHash = await rpc.codeHash(registry);
  const expectedHash = args.strings['code-hash'];
  if (expectedHash !== undefined && expectedHash !== codeHash) {
    throw new RouteSpecError(
      'RS_REGISTRY_REJECTED',
      'The registry account runs different code than expected.',
      {
        details: { reason: 'REGISTRY_CODE_HASH_MISMATCH', codeHash },
      },
    );
  }
  return { client, network, codeHash };
}

function secretFrom(
  args: ParsedArgs,
  ctx: Parameters<Run>[1],
  flag: string,
  envName: string,
  what: string,
): Ed25519Signer {
  const file = args.strings[flag];
  const fromEnv = ctx.env[envName];
  if (file !== undefined) return signerFromSecret(ctx.readSource(file, MAX_KEY_FILE_BYTES));
  if (fromEnv !== undefined && fromEnv !== '') return signerFromSecret(fromEnv);
  usage(`No ${what}: give --${flag} <file> or set ${envName}.`);
}

interface VerifiedBundle {
  readonly verification: BundleVerification;
  readonly manifest: Record<string, unknown>;
}

/** Verify a bundle in a throwaway directory and return its manifest. The directory is removed. */
function verifyInTemp(bundlePath: string): VerifiedBundle {
  const work = mkdtempSync(join(tmpdir(), 'routespec-certificate-'));
  try {
    const verification = verifyBundle(bundlePath, join(work, 'bundle'));
    let manifest: Record<string, unknown> = {};
    try {
      manifest = JSON.parse(readFileSync(join(work, 'bundle', 'manifest.json'), 'utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      manifest = {};
    }
    return { verification, manifest };
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function failedChecks(v: BundleVerification): string {
  return v.checks
    .filter((c) => !c.ok)
    .map((c) => c.name)
    .join(',')
    .slice(0, 200);
}

function text(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function bundleDigestFromArgs(args: ParsedArgs): string | null {
  const bundle = args.strings['bundle'];
  const digest = args.strings['digest'];
  if (bundle !== undefined && digest !== undefined) usage('Give --bundle or --digest, not both.');
  if (digest !== undefined) {
    if (!DIGEST.test(digest)) usage('Flag must be a sha256: digest.', { flag: 'digest' });
    return digest;
  }
  if (bundle === undefined) return null;
  const file = resolveInputFile(bundle, 'RS_EXPORT_PATH_INVALID', { followLinks: true });
  if (statSync(file).size > 256 * 1024 * 1024) usage('The bundle exceeds the size limit.');
  return `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
}

function attesterFlags(args: ParsedArgs): string[] {
  const keys = [...(args.multi['attester'] ?? [])];
  for (const k of keys) {
    if (!isPublicKeyText(k)) usage('Attester keys are written ed25519:<base58>.', { flag: 'attester' });
    if (isSmallOrderPublicKey(parsePublicKey(k))) {
      usage('That attester key is a small-order point; anyone can sign for it.', { flag: 'attester' });
    }
  }
  return [...new Set(keys)];
}

async function attesterStates(
  client: RegistryClient,
  keys: readonly string[],
): Promise<Record<string, AttesterState | null>> {
  const out: Record<string, AttesterState | null> = {};
  for (const key of [...new Set(keys)]) out[key] = await client.getAttester(key);
  return out;
}

/** How far back from a project's newest certificate `certificate badge --project-key` looks. */
const PROJECT_LOOKBACK = 200;
const CODE_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BADGE_LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,39}$/;
/** Registry read failures that `certificate badge --write-on-error` turns into an "unverified" badge. */
const BADGE_READ_ERRORS: readonly string[] = [
  'RS_REGISTRY_UNAVAILABLE',
  'RS_REGISTRY_REJECTED',
  'RS_IDENTITY_MISMATCH',
];

async function latestProjectCertificate(
  client: RegistryClient,
  project: string,
  trusted: readonly string[],
): Promise<{ certificate: OnchainCertificate | null; total: number }> {
  const total = await client.projectCertificateCount(project);
  for (let end = total; end > 0 && total - end < PROJECT_LOOKBACK; end -= MAX_PAGE) {
    const from = Math.max(0, end - MAX_PAGE);
    const found = latestCertificate(
      await client.certificatesByProject(project, from, end - from),
      project,
      trusted,
    );
    if (found !== null) return { certificate: found, total };
  }
  return { certificate: null, total };
}

function exitForDecision(decision: CertificateVerdict): ExitCode {
  if (decision === 'PASS') return EXIT.PASS;
  if (decision === 'FAIL') return EXIT.FAIL;
  return EXIT.REVIEW;
}

export const CERTIFICATE_COMMANDS: Readonly<Record<string, CertificateCommand>> = Object.freeze({
  'certificate keygen': {
    needsData: false,
    spec: { flags: { out: { kind: 'string', required: true } } },
    run: async (args) => {
      const out = resolveOutputFile(args.strings['out'] as string, 'RS_EXPORT_PATH_INVALID');
      if (out.exists) {
        throw new RouteSpecError(
          'RS_EXPORT_OVERWRITE_DENIED',
          'The key file already exists; nothing was written.',
        );
      }
      const signer = generateSigner();
      // `wx`: never replaces a file. Owner-only where the platform has file modes.
      writeFileSync(out.path, signerToPem(signer), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      return {
        exitCode: EXIT.PASS,
        result: {
          publicKey: publicKeyText(signer.publicKey),
          note: 'Keep the key file private. Give the public key to the registry owner for enrolment.',
        },
      };
    },
  },
  'certificate publish': {
    needsData: true,
    spec: {
      flags: {
        bundle: { kind: 'string', required: true },
        'project-key': { kind: 'string', required: true },
        'corpus-digest': { kind: 'string' },
        commit: { kind: 'string' },
        'attester-key': { kind: 'string' },
        out: { kind: 'string' },
        submit: { kind: 'boolean' },
        'expect-verdict': { kind: 'string' },
        'near-account': { kind: 'string' },
        'near-key': { kind: 'string' },
        ...CHAIN_FLAGS,
      },
    },
    run: async (args, ctx) => {
      const registry = registryFromArgs(args);
      const project = args.strings['project-key'] as string;
      if (!isProjectKey(project)) {
        usage('The project key is 1-96 characters of a-z 0-9 . _ / - and starts with a letter or digit.');
      }
      const submit = args.booleans.has('submit');
      const outFlag = args.strings['out'];
      const out = outFlag === undefined ? null : resolveOutputFile(outFlag, 'RS_EXPORT_PATH_INVALID');
      if (out?.exists) {
        throw new RouteSpecError(
          'RS_EXPORT_OVERWRITE_DENIED',
          'The envelope file already exists; nothing was written.',
        );
      }

      // 1. The bundle must verify and must be release evidence.
      const { verification, manifest } = verifyInTemp(args.strings['bundle'] as string);
      if (!verification.verified) {
        throw new RouteSpecError(
          'RS_BUNDLE_VERIFY_FAILED',
          'The bundle does not verify; nothing was signed.',
          {
            details: { failed: failedChecks(verification) },
          },
        );
      }
      if (manifest['evidenceUse'] !== 'RELEASE_EVIDENCE') {
        throw new RouteSpecError(
          'RS_CAPTURE_NOT_RELEASE_EVIDENCE',
          'Only a release-evidence bundle can be certified; this bundle is diagnostic only.',
        );
      }
      const identity = (manifest['identity'] ?? {}) as Record<string, unknown>;
      const decision = text(manifest['decision']);
      const artifactDigest = text(identity['artifactDigest']);
      if (
        decision === null ||
        !(CERTIFICATE_VERDICTS as readonly string[]).includes(decision) ||
        artifactDigest === null
      ) {
        throw new RouteSpecError(
          'RS_BUNDLE_VERIFY_FAILED',
          'The bundle manifest names no decision or artifact.',
        );
      }

      const expected = args.strings['expect-verdict'];
      if (expected !== undefined && !(CERTIFICATE_VERDICTS as readonly string[]).includes(expected)) {
        usage('The expected verdict must be PASS, FAIL, REVIEW or NOT_RUN.');
      }
      if (expected !== undefined && expected !== decision) {
        throw new RouteSpecError(
          'RS_IDENTITY_MISMATCH',
          'The bundle decision is not the expected verdict; nothing was signed.',
          { details: { expected, decision } },
        );
      }

      // 2. Corpus digest and commit: from the journal the bundle came from, or stated explicitly.
      let corpusDigest = args.strings['corpus-digest'] ?? null;
      let commit = args.strings['commit'] ?? null;
      let source: 'JOURNAL' | 'FLAGS' = 'FLAGS';
      if (ctx.dataDir !== null) {
        const recorded = await ctx.withStore((store) => {
          const gates = new GateJournal(store);
          const evaluation = gates.getGateEvaluation(String(manifest['gateEvaluationId']));
          if (
            evaluation.decisionDigest !== manifest['decisionDigest'] ||
            evaluation.decision !== decision ||
            evaluation.identityDigest !== manifest['identityDigest']
          ) {
            throw new RouteSpecError(
              'RS_IDENTITY_MISMATCH',
              'The bundle does not match the gate evaluation in this data directory.',
            );
          }
          const build = gates.getBuildRevision(String(identity['buildRevisionId']));
          const corpus = new ImportJournal(store).getCorpus(String(identity['corpusRevisionId']));
          return { corpusDigest: corpus.corpusDigest, commit: text(build?.['commit_sha']) };
        });
        for (const [flag, given, found] of [
          ['corpus-digest', corpusDigest, recorded.corpusDigest],
          ['commit', commit, recorded.commit],
        ] as const) {
          if (given !== null && given !== found) {
            throw new RouteSpecError('RS_IDENTITY_MISMATCH', 'A flag contradicts the journal record.', {
              details: { flag },
            });
          }
        }
        corpusDigest = recorded.corpusDigest;
        commit = recorded.commit;
        source = 'JOURNAL';
      }
      if (corpusDigest === null || !DIGEST.test(corpusDigest)) {
        usage('The corpus digest is needed: give --data (the journal of the gate run) or --corpus-digest.');
      }
      if (commit === null || !isCommitId(commit)) {
        usage('A full commit id (40 or 64 lowercase hex) is needed: give --data or --commit.');
      }

      // 3. Sign.
      const signer = secretFrom(args, ctx, 'attester-key', CERTIFICATE_ENV.attesterKey, 'attester key');
      const fields: CertificateFields = {
        registry,
        project,
        bundleDigest: verification.bundleDigest,
        verdict: decision,
        corpusDigest,
        artifactDigest,
        commit,
        timestampMs: Date.now(),
      };
      let signed = signCertificate(fields, signer);
      const result: Record<string, unknown> = {
        registry,
        gateEvaluationId: verification.gateEvaluationId,
        identitySource: source,
        submitted: false,
      };

      // 4. Submit, when asked. A certificate this attester already published for the bundle is
      // reported, not sent again (the registry would refuse it).
      if (submit) {
        const { client, network } = await connect(args);
        const account = args.strings['near-account'] ?? ctx.env[CERTIFICATE_ENV.nearAccount];
        if (account === undefined || !isRegistryAccountId(account)) {
          usage(`No NEAR account to pay gas: give --near-account or set ${CERTIFICATE_ENV.nearAccount}.`);
        }
        const caller = {
          accountId: account,
          signer: secretFrom(args, ctx, 'near-key', CERTIFICATE_ENV.nearKey, 'NEAR account key'),
        };
        const state = await client.getAttester(signed.attester);
        if (state === null || state.revoked) {
          throw new RouteSpecError(
            'RS_REGISTRY_REJECTED',
            'The attester key is not enrolled in the registry.',
            {
              details: { reason: state === null ? 'RSREG_ATTESTER_UNKNOWN' : 'RSREG_ATTESTER_REVOKED' },
            },
          );
        }
        const existing = (await client.certificatesByBundle(fields.bundleDigest)).certificates.find(
          (c) => c.attester === signed.attester,
        );
        if (existing !== undefined) {
          const same =
            existing.project === fields.project &&
            existing.verdict === fields.verdict &&
            existing.corpusDigest === fields.corpusDigest &&
            existing.artifactDigest === fields.artifactDigest &&
            existing.commit === fields.commit;
          if (!same) {
            throw new RouteSpecError(
              'RS_REGISTRY_REJECTED',
              'This attester already published a different certificate for the bundle.',
              { details: { reason: 'RSREG_ALREADY_PUBLISHED', certificateId: existing.id } },
            );
          }
          signed = {
            certificate: { ...signed.certificate, timestamp_ms: existing.timestampMs },
            attester: existing.attester,
            signature: existing.signature,
          };
          Object.assign(result, {
            submitted: false,
            alreadyPublished: true,
            certificateId: existing.id,
            network,
          });
        } else {
          const published = await client.publish(signed, caller);
          Object.assign(result, {
            submitted: true,
            alreadyPublished: false,
            certificateId: published.certificateId,
            transactionHash: published.transactionHash,
            network,
          });
        }
      }
      if (out !== null) {
        writeFileSync(out.path, `${JSON.stringify(signed, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
        result['envelopeWritten'] = true;
      }
      return {
        exitCode: EXIT.PASS,
        result: {
          ...result,
          ...signed,
          payloadDigest: `sha256:${createHash('sha256')
            .update(signingPayload({ ...fields, timestampMs: signed.certificate.timestamp_ms }))
            .digest('hex')}`,
          note: submit
            ? 'The certificate is in the registry log. Check it with certificate verify.'
            : 'Signed, not submitted. The envelope is the JSON argument object of the registry publish method.',
        },
      };
    },
  },
  'certificate verify': {
    needsData: false,
    spec: {
      flags: {
        bundle: { kind: 'string' },
        digest: { kind: 'string' },
        attester: { kind: 'multi' },
        policy: { kind: 'string' },
        'project-key': { kind: 'string' },
        ...CHAIN_FLAGS,
      },
    },
    run: async (args) => {
      const policyText = (args.strings['policy'] ?? 'require-onchain-attester')
        .toUpperCase()
        .replace(/-/g, '_');
      if (!(CERTIFICATE_POLICIES as readonly string[]).includes(policyText)) {
        usage('Policy must be require-onchain-attester or advisory.');
      }
      const policy = policyText as CertificatePolicy;
      const project = args.strings['project-key'] ?? null;
      if (project !== null && !isProjectKey(project)) usage('The project key is not valid.');
      const trustedAttesters = attesterFlags(args);
      const bundle = args.strings['bundle'];
      if (bundle === undefined && args.strings['digest'] === undefined) usage('Give --bundle or --digest.');
      if (bundle !== undefined && args.strings['digest'] !== undefined) {
        usage('Give --bundle or --digest, not both.');
      }

      let bundleDigest: string;
      let local: Parameters<typeof aggregateRelease>[0]['local'] = null;
      let bundleChecks: unknown = null;
      if (bundle !== undefined) {
        const { verification, manifest } = verifyInTemp(bundle);
        if (!verification.verified) {
          return {
            exitCode: EXIT.INTERNAL,
            result: {
              bundleDigest: verification.bundleDigest,
              checks: verification.checks,
              error: { code: 'RS_BUNDLE_VERIFY_FAILED' },
            },
          };
        }
        const decision = text(manifest['decision']);
        if (decision === null || !(CERTIFICATE_VERDICTS as readonly string[]).includes(decision)) {
          throw new RouteSpecError('RS_BUNDLE_VERIFY_FAILED', 'The bundle manifest names no decision.');
        }
        bundleDigest = verification.bundleDigest;
        local = {
          decision: decision as CertificateVerdict,
          artifactDigest: text(((manifest['identity'] ?? {}) as Record<string, unknown>)['artifactDigest']),
          // The bundle does not carry these two; they are attested values, compared only when
          // the caller pins a project key.
          corpusDigest: null,
          commit: null,
          project,
        };
        bundleChecks = {
          verified: true,
          entryCount: verification.entryCount,
          evidenceUse: manifest['evidenceUse'],
        };
      } else {
        bundleDigest = bundleDigestFromArgs(args) as string;
      }

      const { client, network, codeHash } = await connect(args);
      const info = await client.info();
      const { certificates, blockHeight } = await client.certificatesByBundle(bundleDigest);
      const attesters = await attesterStates(client, [
        ...certificates.map((c) => c.attester),
        ...trustedAttesters,
      ]);
      const filtered =
        local === null && project !== null ? certificates.filter((c) => c.project === project) : certificates;
      const release = aggregateRelease({
        registry: client.accountId,
        bundleDigest,
        local,
        certificates: filtered,
        attesters,
        policy,
        trustedAttesters,
      });
      const byId = new Map<number, OnchainCertificate>(certificates.map((c) => [c.id, c]));
      return {
        exitCode: exitForDecision(release.decision),
        result: {
          bundleDigest,
          bundle: bundleChecks,
          registry: {
            accountId: client.accountId,
            network,
            contract: info.contract,
            version: info.version,
            codeHash,
            ownerId: info.ownerId,
            readAtBlockHeight: blockHeight,
          },
          release: {
            decision: release.decision,
            policy: release.policy,
            localDecision: release.localDecision,
            acceptedCertificateIds: release.acceptedCertificateIds,
            findings: release.findings,
            trustedAttesters,
          },
          certificates: release.certificates.map((a) => ({ ...byId.get(a.id), assessment: a })),
          note: 'Signatures were verified locally. Enrolment and revocation are as reported by the RPC endpoint.',
        },
      };
    },
  },
  'certificate badge': {
    needsData: false,
    spec: {
      flags: {
        bundle: { kind: 'string' },
        digest: { kind: 'string' },
        'project-key': { kind: 'string' },
        attester: { kind: 'multi' },
        'known-code-hash': { kind: 'multi' },
        label: { kind: 'string' },
        out: { kind: 'string', required: true },
        'write-on-error': { kind: 'boolean' },
        ...CHAIN_FLAGS,
      },
    },
    run: async (args) => {
      const project = args.strings['project-key'] ?? null;
      const given = ['bundle', 'digest', 'project-key'].filter((f) => args.strings[f] !== undefined);
      if (given.length !== 1) usage('Give exactly one of --bundle, --digest, or --project-key.');
      if (project !== null && !isProjectKey(project)) usage('The project key is not valid.');
      const label = args.strings['label'] ?? 'RouteSpec';
      if (!BADGE_LABEL.test(label)) usage('The badge label is 1-40 letters, digits, spaces or . _ ( ) -.');
      const knownCodeHashes = [...new Set(args.multi['known-code-hash'] ?? [])];
      for (const h of knownCodeHashes) {
        if (!CODE_HASH.test(h))
          usage('A code hash is the base58 NEAR code hash.', { flag: 'known-code-hash' });
      }
      const trustedAttesters = attesterFlags(args);
      registryFromArgs(args);
      const out = resolveOutputFile(args.strings['out'] as string, 'RS_EXPORT_PATH_INVALID');
      if (out.exists) {
        throw new RouteSpecError(
          'RS_EXPORT_OVERWRITE_DENIED',
          'The badge file already exists; nothing was written.',
        );
      }
      let bundleDigest = bundleDigestFromArgs(args);

      let status: BadgeStatus;
      let detail: Record<string, unknown>;
      try {
        const { client, network, codeHash } = await connect(args);
        const codeHashKnown = knownCodeHashes.length === 0 ? null : knownCodeHashes.includes(codeHash);
        let certificateId: number | null = null;
        let projectCertificates: number | null = null;
        if (project !== null) {
          const latest = await latestProjectCertificate(client, project, trustedAttesters);
          projectCertificates = latest.total;
          bundleDigest = latest.certificate?.bundleDigest ?? null;
          certificateId = latest.certificate?.id ?? null;
        }
        let release: ReturnType<typeof aggregateRelease> | null = null;
        let readAtBlockHeight: number | null = null;
        if (bundleDigest !== null) {
          const { certificates, blockHeight } = await client.certificatesByBundle(bundleDigest);
          readAtBlockHeight = blockHeight;
          const attesters = await attesterStates(client, [
            ...certificates.map((c) => c.attester),
            ...trustedAttesters,
          ]);
          release = aggregateRelease({
            registry: client.accountId,
            bundleDigest,
            local: null,
            certificates,
            attesters,
            policy: 'REQUIRE_ONCHAIN_ATTESTER',
            trustedAttesters,
          });
        }
        // A project with no (pinned) certificate has nothing to verify: that is "no certificate",
        // not an unread registry.
        if (release !== null) status = badgeStatus(release, codeHashKnown);
        else status = codeHashKnown === false ? 'REGISTRY_CODE_UNKNOWN' : 'NO_CERTIFICATE';
        detail = {
          bundleDigest,
          project,
          projectCertificates,
          latestCertificateId: certificateId,
          registry: { accountId: client.accountId, network, codeHash, codeHashKnown, readAtBlockHeight },
          release:
            release === null
              ? null
              : {
                  decision: release.decision,
                  acceptedCertificateIds: release.acceptedCertificateIds,
                  findings: release.findings,
                  trustedAttesters,
                },
        };
      } catch (error) {
        if (
          !args.booleans.has('write-on-error') ||
          !(error instanceof RouteSpecError) ||
          !BADGE_READ_ERRORS.includes(error.code)
        ) {
          throw error;
        }
        status = 'UNVERIFIED';
        const reason = error.details['reason'];
        detail = {
          bundleDigest,
          project,
          error: { code: error.code, reason: typeof reason === 'string' ? reason.slice(0, 80) : null },
        };
      }
      const badge = shieldsBadge(status, label);
      writeFileSync(out.path, JSON.stringify(badge, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
      return {
        exitCode: EXIT.PASS,
        result: {
          status,
          badge,
          ...detail,
          badgeWritten: true,
          note: 'Digest-only status under require-onchain-attester; signatures were verified locally. Enrolment and revocation are as reported by the RPC endpoint.',
        },
      };
    },
  },
  'certificate revoke-check': {
    needsData: false,
    spec: {
      flags: {
        bundle: { kind: 'string' },
        digest: { kind: 'string' },
        attester: { kind: 'multi' },
        ...CHAIN_FLAGS,
      },
    },
    run: async (args) => {
      const bundleDigest = bundleDigestFromArgs(args);
      const named = attesterFlags(args);
      if (bundleDigest === null && named.length === 0) usage('Give --bundle, --digest, or --attester.');
      const { client, network, codeHash } = await connect(args);
      const found =
        bundleDigest === null
          ? null
          : await client.certificatesByBundle(bundleDigest).then((r) => r.certificates);
      const states = await attesterStates(client, [...(found ?? []).map((c) => c.attester), ...named]);
      const status = (key: string): 'ENROLLED' | 'REVOKED' | 'NOT_ENROLLED' => {
        const s = states[key] ?? null;
        return s === null ? 'NOT_ENROLLED' : s.revoked ? 'REVOKED' : 'ENROLLED';
      };
      const certificates = (found ?? []).map((c) => {
        const s = states[c.attester] ?? null;
        return {
          id: c.id,
          project: c.project,
          verdict: c.verdict,
          attester: c.attester,
          attesterStatus: status(c.attester),
          publishedAtMs: c.publishedAtMs,
          publishedBlockHeight: c.publishedBlockHeight,
          revokedAtMs: s?.revokedAtMs ?? null,
          revokedBlockHeight: s?.revokedBlockHeight ?? null,
          revocationReason: s?.revocationReason ?? null,
          publishedBeforeRevocation:
            s !== null && s.revokedBlockHeight !== null
              ? c.publishedBlockHeight < s.revokedBlockHeight
              : null,
        };
      });
      const attesters = Object.keys(states)
        .sort()
        .map((key) => ({
          attester: key,
          status: status(key),
          label: states[key]?.label ?? null,
          revokedAtMs: states[key]?.revokedAtMs ?? null,
          revocationReason: states[key]?.revocationReason ?? null,
          certificates: states[key]?.certificates ?? 0,
        }));
      const anyRevoked = attesters.some((a) => a.status !== 'ENROLLED');
      const overall =
        found !== null && found.length === 0 ? 'NO_CERTIFICATE' : anyRevoked ? 'REVOKED' : 'CLEAR';
      return {
        exitCode: overall === 'CLEAR' ? EXIT.PASS : EXIT.REVIEW,
        result: {
          status: overall,
          bundleDigest,
          registry: { accountId: client.accountId, network, codeHash },
          certificates,
          attesters,
          note: 'A revoked attester can publish nothing new. Whether its earlier certificates still count is the verifier policy: certificate verify treats them as not accepted.',
        },
      };
    },
  },
});
