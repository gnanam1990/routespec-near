/**
 * Migration 009 — interceptor profile review and release-evidence classification (M16).
 *
 * Purely additive (T-028): only new tables, triggers, and indexes.
 *
 * - `profile_reviewers`: reviewer principals, enrolled with an explicit local confirmation and
 *   their own Ed25519 public key. A reviewer key can never also be an enrolled launcher key
 *   (checked at enrollment in both directions). Immutable; revocation is a separate record.
 * - `profile_reviewer_revocations`: append-only, one per reviewer.
 * - `profile_review_challenges`: single-use, short-lived challenges. Each carries the exact
 *   canonical statement the reviewer signs; only `consumed_at_ms` may change, once.
 * - `interceptor_profile_reviews`: the signed, verified, immutable review of one registered
 *   profile. `interceptor_profiles.review_state` keeps the declared state at registration; the
 *   effective state is derived from these records and their revocations.
 * - `interceptor_profile_review_revocations`: append-only, one per review.
 * - `promotion_evidence_classes`: how a promotion may be used (RELEASE_EVIDENCE or
 *   DIAGNOSTIC_ONLY) and why a capture was not release evidence. Written in the promotion
 *   transaction; immutable. A promotion without a row (older journals) is UNCLASSIFIED and is
 *   never release evidence.
 */
const immutable = (table: string) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;`;

export const MIGRATION_009_SQL = `
CREATE TABLE profile_reviewers (
  reviewer_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'LOCAL_REVIEWER_KEY'),
  public_key_x TEXT NOT NULL,
  key_digest TEXT NOT NULL,
  valid_from_ms INTEGER NOT NULL,
  valid_until_ms INTEGER NOT NULL CHECK (valid_until_ms > valid_from_ms),
  plan_digest TEXT NOT NULL,
  confirmation_id TEXT NOT NULL,
  enrolled_at_ms INTEGER NOT NULL,
  UNIQUE (project_id, key_digest)
) STRICT;

CREATE TABLE profile_reviewer_revocations (
  revocation_id TEXT PRIMARY KEY,
  reviewer_id TEXT NOT NULL UNIQUE REFERENCES profile_reviewers(reviewer_id),
  reason_code TEXT NOT NULL,
  confirmation_id TEXT NOT NULL,
  revoked_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE profile_review_challenges (
  challenge_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  profile_id TEXT NOT NULL REFERENCES interceptor_profiles(profile_id),
  profile_digest TEXT NOT NULL,
  reviewer_id TEXT NOT NULL REFERENCES profile_reviewers(reviewer_id),
  decision TEXT NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  statement_json TEXT NOT NULL,
  statement_digest TEXT NOT NULL,
  issued_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  consumed_at_ms INTEGER
) STRICT;

CREATE TRIGGER profile_review_challenges_consume_once BEFORE UPDATE ON profile_review_challenges
WHEN OLD.consumed_at_ms IS NOT NULL
  OR NEW.challenge_id IS NOT OLD.challenge_id OR NEW.project_id IS NOT OLD.project_id
  OR NEW.profile_id IS NOT OLD.profile_id OR NEW.profile_digest IS NOT OLD.profile_digest
  OR NEW.reviewer_id IS NOT OLD.reviewer_id OR NEW.decision IS NOT OLD.decision
  OR NEW.statement_json IS NOT OLD.statement_json OR NEW.statement_digest IS NOT OLD.statement_digest
  OR NEW.issued_at_ms IS NOT OLD.issued_at_ms OR NEW.expires_at_ms IS NOT OLD.expires_at_ms
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;
CREATE TRIGGER profile_review_challenges_no_delete BEFORE DELETE ON profile_review_challenges
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;

CREATE TABLE interceptor_profile_reviews (
  review_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  profile_id TEXT NOT NULL REFERENCES interceptor_profiles(profile_id),
  profile_digest TEXT NOT NULL,
  reviewer_id TEXT NOT NULL REFERENCES profile_reviewers(reviewer_id),
  reviewer_key_digest TEXT NOT NULL,
  challenge_id TEXT NOT NULL UNIQUE REFERENCES profile_review_challenges(challenge_id),
  decision TEXT NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  checklist_json TEXT NOT NULL,
  statement_json TEXT NOT NULL,
  statement_digest TEXT NOT NULL,
  signature TEXT NOT NULL,
  review_digest TEXT NOT NULL UNIQUE,
  reviewed_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE interceptor_profile_review_revocations (
  revocation_id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL UNIQUE REFERENCES interceptor_profile_reviews(review_id),
  reason_code TEXT NOT NULL,
  confirmation_id TEXT NOT NULL,
  revoked_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE promotion_evidence_classes (
  promotion_id TEXT PRIMARY KEY REFERENCES import_promotions(promotion_id),
  import_id TEXT NOT NULL UNIQUE,
  scenario_revision_id TEXT NOT NULL UNIQUE REFERENCES scenario_revisions(scenario_revision_id),
  evidence_use TEXT NOT NULL CHECK (evidence_use IN ('RELEASE_EVIDENCE','DIAGNOSTIC_ONLY')),
  refusal_reasons_json TEXT NOT NULL,
  interceptor_profile_digest TEXT,
  interceptor_review_id TEXT,
  classification_digest TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  CHECK (evidence_use = 'DIAGNOSTIC_ONLY' OR refusal_reasons_json = '[]')
) STRICT;

CREATE INDEX interceptor_profile_reviews_by_profile ON interceptor_profile_reviews(project_id, profile_digest);
CREATE INDEX profile_reviewers_by_project ON profile_reviewers(project_id);
${[
  'profile_reviewers',
  'profile_reviewer_revocations',
  'interceptor_profile_reviews',
  'interceptor_profile_review_revocations',
  'promotion_evidence_classes',
]
  .map(immutable)
  .join('\n')}
`;
