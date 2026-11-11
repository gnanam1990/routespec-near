# RouteSpec Deployment Runbook

Status: **SPECIFICATION_ONLY**  
Deployment status: **NOT_RUN**  
Production readiness: **NOT_PROVEN**

## Proposed environments

| Environment | Purpose | Real value allowed | Current proof state |
|---|---|---:|---|
| Local | Development, deterministic tests, fault injection | No | NOT_RUN |
| CI | Repeatable checks and build artifacts | No | NOT_RUN |
| Networkless scenario runtime | Local proxy schedule/barriers, replay, invariant, and report tests | No | NOT_RUN |
| CI runner | Release-gate action against immutable scenario revisions using the actual tested client | No | NOT_RUN |
| Local control service | Mandatory loopback project/revision/build matrix, cases, and evidence UI | No provider JWT or raw capture | NOT_RUN |
| Live dry adapter | Separately launched official 1Click schema and dry quote compatibility | No transfer | NOT_RUN |
| Hosted collaboration | Future/excluded from the critical DAG | Not applicable | NOT_SPECIFIED |

## Mandatory authorization

Do not create or mutate any hosting project, database, domain, DNS record, cloud resource, paid subscription, secret, testnet account, mainnet account, or deployment without explicit user authorization for that exact action and destination.

Live dry-provider access, credential use, public URL publication, and repository visibility changes are distinct authorization gates. Wallet signing and real-fund transfer are not deployment options in RouteSpec.

## Pre-deployment evidence

Before requesting deployment authorization, record:

- repository and exact commit SHA;
- clean working tree and dependency lockfile state;
- environment target and account/organization;
- required secrets by name, never their values;
- build, unit, integration, end-to-end, security, and failure-path results;
- database migration and rollback behavior;
- fund limits and network IDs;
- observability, alerting, rate limiting, retry, and idempotency behavior;
- known limitations and whether the sibling project shares any infrastructure.

Critical-path `WORKING_LOCAL` behavior must satisfy RP-01 through RP-06 and RP-08: clean installation, separately trust-root-attested pinned official client and interceptor artifacts, real HTTP through the networkless proxy, complete declared process-tree/sink interception against a no-effect canary, isolated case/token/client/interceptor lifecycles, phased durable operation/effect journal, deterministic failure, fenced read-only recovery, installed trace quarantine/promotion into a new corpus, corrected-client rerun with a fresh interceptor, CLI/API/UI/CI parity, and reproducible evidence. Subject hooks, inventory alone, declared-hooks-only, seeded, or mocked behavior cannot support the claim. RP-07 is separate optional compatibility evidence.

RouteSpec's critical proof does not require a funded swap. SIMULATE/REPLAY run in the networkless product with no provider credentials; the client uses case-bound authentication and all local/provider headers are stripped before any live boundary. The deterministic scenario executes through the full proxy/journal/evaluator path; it is not prerecorded. Separately, an explicitly authorized real dry probe may establish only `OFFICIAL_ENDPOINT_COMPATIBLE`; its absence or failure does not invalidate `WORKING_LOCAL`. RouteSpec no-egress evidence covers its own processes unless process-tree isolation is additionally proven.

## Deployment procedure

1. Refresh the remote/default-branch state and verify the authorized commit.
2. Confirm the exact target, visibility, network, region, billing context, and secret destination.
3. Obtain explicit authorization.
4. Deploy without exposing credentials or private endpoints in logs.
5. Capture immutable deployment evidence: commit, build identifier, URL or contract address, network, timestamp, and configuration hash where available.
6. Run RP-01 through RP-06 and RP-08 for local delivery plus smoke, identity/token, loading, failure, disconnected, and recovery checks from the installed artifact. Run RP-07 only for a separately requested compatibility claim.
7. RouteSpec does not require a smart contract. Do not add an on-chain anchor unless a separate decision record proves it changes an essential trust property.
8. For services, verify health, durable storage, migrations, queues, retries, rate limits, and rollback.
9. Record results in `BUILD-STATUS.md`. A reachable URL alone is not product verification.

## Live-provider and fund controls

For every environment:

- no real funds, wallet signing, committed quote, deposit submission, transfer, withdrawal, or contract mutation;
- no unrestricted signing authority or production customer data;
- no claim that simulated, replayed, or dry-probe behavior is settlement;
- live traffic limited to pinned origins and exact read/dry schemas in the isolated dry-probe adapter.

If a team later wants a funded validation, it must be designed and reviewed as a different product boundary; this build pack does not authorize or specify it.

## Rollback and incident handling

- Define the last known-good artifact and rollback command before deployment.
- Never repair state manually without recording the cause, exact mutation, authorization, and verification.
- Freeze new economic actions when outcome is unknown; reconcile authoritative state before retrying.
- Preserve logs and evidence without leaking secrets or personal data.

## Event boundary

Submission deadline recorded for planning: **2026-11-14T23:59:00Z**. Recheck the official source before deployment or submission. Deadline pressure does not authorize deployment, publication, mainnet use, or reduced security.

