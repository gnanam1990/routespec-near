/**
 * Migration 003 — networkless proxy and independent interceptor channel support (M02).
 *
 * Purely additive (T-028): only new tables, triggers, and indexes. No existing table is
 * altered, so every row written under an earlier schema keeps its exact shape and digest.
 *
 * - `interceptor_channels`: per registered interceptor instance, the digest of the private
 *   channel key handed to the separately launched interceptor over its inherited pipe (the key
 *   itself is never stored), its policy/manifest/gate binding, the honest containment class,
 *   and the peer process id. Immutable.
 * - `interceptor_teardowns`: one immutable teardown record (`TEARDOWN`, `CHANNEL_LOST`, or
 *   `CASE_TERMINAL`).
 * - `boundary_observation_frames`: effect type, interceptor profile and call-site inventory
 *   digests, and the authenticated frame digest that makes exact duplicates idempotent.
 * - `evidence_recipients`: recipient binding for evidence predicates (digest only).
 */
const immutable = (table: string) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;`;

export const MIGRATION_003_SQL = `
CREATE TABLE interceptor_channels (
  interceptor_instance_id TEXT PRIMARY KEY REFERENCES effect_interceptor_instances(interceptor_instance_id),
  channel_key_digest TEXT NOT NULL UNIQUE,
  gate_run_id TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  containment TEXT NOT NULL CHECK (containment IN ('PROCESS_TREE_ENFORCED','DECLARED_HOOKS_ONLY')),
  peer_pid INTEGER NOT NULL CHECK (peer_pid > 0),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE interceptor_teardowns (
  interceptor_instance_id TEXT PRIMARY KEY REFERENCES effect_interceptor_instances(interceptor_instance_id),
  reason TEXT NOT NULL CHECK (reason IN ('TEARDOWN','CHANNEL_LOST','CASE_TERMINAL')),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE boundary_observation_frames (
  observation_id TEXT PRIMARY KEY REFERENCES effect_boundary_observations(observation_id),
  effect_type TEXT NOT NULL,
  interceptor_profile_digest TEXT NOT NULL,
  callsite_inventory_digest TEXT,
  frame_digest TEXT NOT NULL
) STRICT;

CREATE TABLE evidence_recipients (
  evidence_id TEXT PRIMARY KEY REFERENCES evidence_items(evidence_id),
  recipient_digest TEXT NOT NULL
) STRICT;

CREATE INDEX protected_effect_observations_by_key
  ON protected_effect_observations(session_id, idempotency_key_digest);
CREATE INDEX effect_boundary_observations_by_case
  ON effect_boundary_observations(case_run_id, sequence);
${['interceptor_channels', 'interceptor_teardowns', 'boundary_observation_frames', 'evidence_recipients'].map(immutable).join('\n')}
`;
