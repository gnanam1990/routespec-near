# ADR-0019 — Container containment of the subject client (M14)

- Status: accepted
- Date: 2026-11-12
- Module: M14 (follow-up on the M12 `WORKING_LOCAL` gaps; T-004, T-010, T-012, T-055, T-059;
  RP-01, RP-02, RP-03, RP-04, RP-06, RP-08)

## Context

M12 left `WORKING_LOCAL` blocked because INV-04 (complete effect coverage) could only be REVIEW:
no process-tree sandbox confined the subject client, no independent interceptor was launched in
the installed path, the standalone control service had no trust-rooted launcher path, and a gate
run carried one effect-coverage policy for every scenario. Docker Engine 29.1 is now available on
this host inside the WSL 2 distribution Ubuntu-24.04 (cgroup v2). Docker Desktop is not used.

## Decisions

1. **New package `@routespec/containment`.** The engine command is configuration
   (`ROUTESPEC_CONTAINER_CLI` or `--container-cli`, a JSON array; default `docker`). For
   `wsl.exe` the command must end in `--exec <engine>`; a `--` separator is rewritten to `--exec`
   because `--` passes through the distribution's shell and expands `$` inside arguments (observed
   here). Windows paths map to `/mnt/<drive>/...`. RouteSpec never pulls images.
2. **Detection, not assumption.** `detectContainerRuntime` asks the engine for its server version
   (must be `linux`) and inspects the pinned image locally. Otherwise the result is `ABSENT` with
   `CONTAINER_RUNTIME_ABSENT`, `CONTAINER_IMAGE_ABSENT`, or `CONTAINER_RUNTIME_UNSUPPORTED`.
   Runtime tests skip themselves with `NOT_RUN: <reason>`; they never pass or fail without an
   engine. The service answers `RS_CONTAINMENT_UNAVAILABLE` (503) with the reason.
3. **The container.** `docker run --rm -i --init --network none --read-only --cap-drop ALL
--security-opt no-new-privileges:true --pids-limit 128 --memory 512m --memory-swap 512m
--user 1000:1000 --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m`, the installed checkout mounted
   read-only at its own engine path (pnpm's absolute links keep working), the image run by its
   immutable id, `HOME=/tmp` only. The subject's whole process tree lives in the container's PID
   namespace and cgroup; `--init` reaps it and the engine ends every descendant when the shim
   exits.
4. **The only way out is a tunnel the launcher owns.** The in-container shim (`shim.mjs`, Node
   built-ins only) is the container's main process. It forks the subject and listens on fixed
   loopback ports inside the container. Each connection the subject opens there is framed over
   the shim's stdin/stdout (JSON lines, base64 payloads, so the WSL pipe never sees raw bytes) to
   the launcher, which connects it to the one host target configured for that port: the RouteSpec
   proxy (same port number, so the Host check holds) and the effect-interceptor sink. A port
   without a target refuses the connection. The subject's IPC messages travel the same channel.
   Nothing else can leave: there is no network interface but `lo`. Only the shim writes frames
   to this channel and every frame is bounded (amended by ADR-0023).
5. **Containment is verified, fail closed.** `verifyInspect` checks the engine's own record
   (network `none` and no other network, no published ports, read-only root, not privileged, all
   capabilities dropped and none added, no-new-privileges, no unconfined seccomp/AppArmor, no host
   PID/IPC/UTS/user/cgroup namespace, pids and memory limits, init, no devices, non-root user,
   only the expected read-only bind mount, no engine socket, only `/tmp` as tmpfs, the expected
   image id) and the shim's self-observation (`CapEff`/`CapPrm` zero, `NoNewPrivs` 1, non-root,
   only `lo`). Any finding makes the result `DECLARED_HOOKS_ONLY`; the self-observation can only
   add findings. The sandbox-scope digest covers the observed settings, container id, and tunnel
   ports.
6. **The control host launches contained cases** (`POST /case-runs/{id}/contained-start`,
   `--subject-root`). The artifact is the file named by the build's `git+file:` locator inside the
   subject root, and its SHA-256 must equal the registered artifact digest before anything starts.
   The execution token and any re-issued reconciliation-only token go to the subject over its
   private channel only; HTTP answers carry `token: null` and `tokenDelivery: CONTAINED_SUBJECT`.
   `GET /case-runs/{id}/containment` shows the live state and the journaled records.
7. **Trust-rooted launches.** The service may fork the reviewed attesting launcher
   (`--launcher`, `--launcher-key`) for an enrolled `LOCAL_LAUNCHER_KEY` principal whose
   `launcherArtifactDigest` equals the launcher's measured identity: a tree digest of the entry
   script plus every source file of the containment and contracts packages (third-party modules
   are covered by the lockfile digest). The operator's private key stays in an owner-only file
   the service never reads. The launcher measures for itself: the artifact and lockfile files, the
   declared effect file `<artifact>.effects.json`, the image id (toolchain digest), the reviewed
   interceptor artifact, and the container (its own `docker inspect`, verified with the same
   rules). `BUILD_REGISTRATION` bindings now carry the repository locator; `CASE_LAUNCH` and
   `EFFECT_INTERCEPTOR_LAUNCH` bindings of a contained launch also carry the sandbox-scope digest,
   which then becomes a required observed digest. The client-instance digest and the registered
   interceptor-profile digest are vouched as given (not observable from outside). A launcher that
   is missing, revoked, or refuses leaves the launch unattested; the case still runs and the kernel
   reports REVIEW.
8. **The interceptor binds when the subject reaches the sink.** An accepted-then-lost response
   advances the fencing epoch during the case, and an instance bound to the old epoch is stale.
   The interceptor is therefore launched (and attested) the first time the subject connects to
   the sink tunnel, at the then-current epoch; until then that tunnel has no target and nothing
   leaves. A later epoch change still makes it stale (REVIEW).
9. **Release only after accepted completion.** On the first ATTEMPTED frame the runner closes
   scenario input (ground truth is journaled under the current fence) and records a release
   authorization only if `effect_completion` or `destination_credit` evidence is PROVEN in the
   simulated ground-truth scope; then the interceptor releases to its no-effect canary. Otherwise
   every attempt stays BLOCKED. The kernel judges the cited evidence independently.
10. **Teardown evidence.** The subject tree is stopped, the engine must forget the container, and
    survivors are listed; a container that does not disappear is journaled as a
    `PROCESS_TREE_ESCAPE` coverage finding before the interceptor's orderly teardown. Migration 008
    adds the immutable `subject_containments` record.
11. **One policy per scenario.** Migration 008 adds `gate_run_case_policies`; a gate run may name
    `casePolicies` (scenario -> policy), validated like the gate's own policy, bound into the case
    session, and used by gate aggregation for that case. This closes ADR-0017 §12.
12. **Surfaces report coverage from kernel results.** The case, run-operation, and gate views say
    `COMPLETE` only when the latest INV-04 results of the scope are all PASS; otherwise
    `INCOMPLETE` with the kernel's missing predicates. Installed captures record the journaled
    containment; only a confined capture drops `PROCESS_TREE_NOT_CONFINED`.
13. **Subject builds perform their protected effect.** Given a sink, the baseline build fulfils
    right after submitting (whatever the outcome) and the corrected build only after SUCCESS,
    retrying while the boundary has not released. Without a sink they behave as before.

## Consequences and limits

- On this host the contained journey reaches: every subject case PROCESS_TREE_ENFORCED and
  attested, the corrected build PASS on every required predicate (INV-04 included) on both the
  base and the promoted scenario, gate decision PASS, lineage `CORRECTED_RUN_PASSED`, exported
  bundle verified with decision PASS (`docs/status/M14.md`).
- `WORKING_LOCAL` is still not claimed; the remaining unmet requirements are listed in
  `docs/status/M14.md` and `BUILD-STATUS.md`: a clean-checkout run on a real CI service (RP-05),
  refusal of declared-hooks-only or unconfined captures as release evidence (RP-08), and a review
  workflow for interceptor profiles (they stay `DECLARED_UNREVIEWED`).
- The launcher identity covers RouteSpec sources, not Node, the engine, WSL, or the kernel. The
  trust root is an operator key enrolled on the same machine, which is what `LOCAL_LAUNCHER_KEY`
  means; it is not an external authority.
- Network sinks are covered because the container has no other route; a subject effect through
  the proxy is impossible because the proxy serves only the protocol routes. Filesystem effects
  are limited to the container's ephemeral `/tmp`.
- Only one environment ran: Windows 11 host, Docker Engine 29.1.3 in WSL 2 (Ubuntu 24.04.5,
  kernel 6.18), image `node:22-bookworm-slim` (Node 22.23.5). Plain Linux Docker and other
  engines are supported by configuration but NOT_RUN.

## Invalidation

Revisit if the engine's inspect format changes, if rootless or user-namespaced engines are used
(the expectations would differ), if subjects need a network sink other than the interceptor, or
if an external attester (CI OIDC with a nonce-capable issuer) becomes available.
