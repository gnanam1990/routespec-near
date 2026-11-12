/**
 * CLI surfaces for interceptor profile review and release-evidence refusal (M16; RP-02, RP-06,
 * RP-08).
 *
 * - `profile review-status`: the effective review state of a registered profile and its review
 *   records (read only).
 * - `profile review-sign`: the reviewer's offline signing tool. It reads a review challenge
 *   (the statement the service issued) and the reviewer's own Ed25519 private key file, refuses
 *   a key that is not the one the statement names, and prints only the signature. It opens no
 *   data directory and sends nothing anywhere; the operator submits the signature to the service.
 * - `regression evidence`: why a capture is or is not release evidence.
 * - `regression promote`: promotion through the same workflow as the API, refusing a capture
 *   that is not release evidence unless `--diagnostic-only` is given (then ADVISORY only).
 */
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import {
  RouteSpecError,
  profileReviewSigningBytes,
  profileReviewStatementDigest,
  reviewerKeyDigest,
  type ProfileReviewStatement,
} from '@routespec/contracts';
import { classifyCaptureEvidence, promoteImport } from '@routespec/regressions';
import { ControlJournal, ImportJournal, ProfileReviewJournal, RouteSpecStore } from '@routespec/store';
import { usage, type CommandSpec, type ParsedArgs } from './args.ts';
import { EXIT, type ExitCode } from './exit.ts';

type Run = (
  args: ParsedArgs,
  ctx: {
    readonly dataDir: string | null;
    readonly stderr: (line: string) => void;
    readonly readSource: (file: string, maxBytes: number) => string;
    readonly withStore: <T>(fn: (store: RouteSpecStore) => Promise<T> | T) => Promise<T>;
  },
) => Promise<{ exitCode: ExitCode; result: Record<string, unknown> }>;

export interface ReviewCommand {
  readonly spec: CommandSpec;
  readonly needsData: boolean;
  readonly run: Run;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function arg(args: ParsedArgs, name: string, re: RegExp, what: string): string {
  const v = args.strings[name] as string;
  if (!re.test(v)) usage(`Flag must be ${what}.`, { flag: name });
  return v;
}

function isStatement(v: unknown): v is ProfileReviewStatement {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as Record<string, unknown>)['domain'] === 'routespec.interceptor-profile-review/1' &&
    typeof (v as Record<string, unknown>)['reviewerKeyDigest'] === 'string'
  );
}

export const REVIEW_COMMANDS: Readonly<Record<string, ReviewCommand>> = Object.freeze({
  'profile review-status': {
    needsData: true,
    spec: {
      flags: { project: { kind: 'string', required: true }, profile: { kind: 'string', required: true } },
    },
    run: (args, ctx) =>
      ctx.withStore((store) => {
        const projectId = arg(args, 'project', ID, 'a RouteSpec identifier');
        const profileDigest = arg(args, 'profile', DIGEST, 'a sha256: digest');
        const control = new ControlJournal(store);
        const profile = control.getInterceptorProfile(projectId, profileDigest);
        if (!profile) throw new RouteSpecError('RS_NOT_FOUND', 'Interceptor profile not found.');
        const reviews = new ProfileReviewJournal(control);
        const state = reviews.profileReviewState(projectId, profileDigest);
        return {
          exitCode: EXIT.PASS,
          result: {
            profileId: profile['profile_id'],
            profileDigest,
            declaredState: profile['review_state'],
            reviewState: state.state,
            effectiveReviewId: state.reviewId,
            reviews: reviews.listReviews(projectId, profileDigest).map((r) => ({
              reviewId: r['review_id'],
              reviewerId: r['reviewer_id'],
              decision: r['decision'],
              reviewDigest: r['review_digest'],
              revoked: r['revoked'] === 1,
              revocationReason: r['revocation_reason'] ?? null,
            })),
            independentHumanReview: 'NOT_ESTABLISHED_BY_RECORDS',
          },
        };
      }),
  },
  'profile review-sign': {
    needsData: false,
    spec: {
      flags: { challenge: { kind: 'string', required: true }, key: { kind: 'string', required: true } },
    },
    run: async (args, ctx) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(ctx.readSource(args.strings['challenge'] as string, 64 * 1024));
      } catch (error) {
        if (error instanceof RouteSpecError) throw error;
        usage('The challenge file is not JSON.');
      }
      const statement = isStatement(parsed)
        ? parsed
        : isStatement((parsed as Record<string, unknown> | null)?.['statement'])
          ? ((parsed as Record<string, unknown>)['statement'] as ProfileReviewStatement)
          : usage('The challenge file holds no review statement.');
      let privateKey;
      try {
        privateKey = createPrivateKey(ctx.readSource(args.strings['key'] as string, 16 * 1024));
      } catch (error) {
        if (error instanceof RouteSpecError) throw error;
        usage('The key file is not a private key.');
      }
      if (privateKey.asymmetricKeyType !== 'ed25519') usage('The reviewer key must be Ed25519.');
      const x = String(createPublicKey(privateKey).export({ format: 'jwk' }).x);
      if (reviewerKeyDigest(x) !== statement.reviewerKeyDigest) {
        throw new RouteSpecError(
          'RS_IDENTITY_MISMATCH',
          'This key is not the reviewer key the statement names; nothing was signed.',
        );
      }
      const signature = sign(null, profileReviewSigningBytes(statement), privateKey).toString('base64url');
      return {
        exitCode: EXIT.PASS,
        result: {
          challengeId: statement.challengeId,
          statementDigest: profileReviewStatementDigest(statement),
          decision: statement.decision,
          profileDigest: statement.profileDigest,
          signature,
          note: 'Submit this signature for the challenge; the private key never leaves this process.',
        },
      };
    },
  },
  'regression evidence': {
    needsData: true,
    spec: { flags: { import: { kind: 'string', required: true } } },
    run: (args, ctx) =>
      ctx.withStore((store) => {
        const importId = arg(args, 'import', ID, 'a RouteSpec identifier');
        const c = classifyCaptureEvidence(new ImportJournal(store), importId);
        return {
          exitCode: c.releaseEvidence ? EXIT.PASS : EXIT.REVIEW,
          result: { importId, ...c },
        };
      }),
  },
  'regression promote': {
    needsData: true,
    spec: {
      flags: {
        import: { kind: 'string', required: true },
        review: { kind: 'string', required: true },
        label: { kind: 'string', required: true },
        'base-corpus': { kind: 'string' },
        severity: { kind: 'string' },
        'gate-policy': { kind: 'string' },
        'diagnostic-only': { kind: 'boolean' },
        'idempotency-key': { kind: 'string' },
      },
    },
    run: (args, ctx) =>
      ctx.withStore((store) => {
        const importId = arg(args, 'import', ID, 'a RouteSpec identifier');
        const reviewId = arg(args, 'review', ID, 'a RouteSpec identifier');
        const base = args.strings['base-corpus'] ?? null;
        if (base !== null && !ID.test(base))
          usage('Flag must be a RouteSpec identifier.', { flag: 'base-corpus' });
        const label = args.strings['label'] as string;
        if (!/^[\x20-\x7e]{1,120}$/.test(label)) usage('Label must be 1-120 printable characters.');
        const severity = (args.strings['severity'] ?? 'HIGH').toUpperCase();
        if (!['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(severity)) usage('Unknown severity.');
        const diagnostic = args.booleans.has('diagnostic-only');
        const gatePolicy = (
          args.strings['gate-policy'] ?? (diagnostic ? 'ADVISORY' : 'REQUIRED')
        ).toUpperCase();
        if (gatePolicy !== 'REQUIRED' && gatePolicy !== 'ADVISORY')
          usage('Gate policy must be required or advisory.');
        const journal = new ImportJournal(store);
        const view = journal.getImport(importId);
        const promotion = promoteImport(journal, {
          importId,
          expectedRevision: view.revision,
          reviewId,
          baseCorpusRevisionId: base,
          corpusLabel: label,
          severity,
          gatePolicy,
          evidenceUse: diagnostic ? 'DIAGNOSTIC_ONLY' : 'RELEASE_EVIDENCE',
          idempotencyKey:
            args.strings['idempotency-key'] ??
            `cli.regression-promote.${importId}.${reviewId}.${diagnostic ? 'd' : 'r'}`,
        });
        if (diagnostic) {
          ctx.stderr(
            'routespec: promoted as DIAGNOSTIC_ONLY; this case can never be a required release case',
          );
        }
        return { exitCode: EXIT.PASS, result: { ...promotion } };
      }),
  },
});
