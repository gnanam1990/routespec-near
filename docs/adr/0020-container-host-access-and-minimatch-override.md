# ADR-0020 — Container-host access checks and the minimatch advisory (M17)

- Status: accepted
- Date: 2026-11-12
- Module: M17 (follow-up on the M11 T-036 NOT_RUN part and the M13 open advisory; T-036, RP-06,
  NFR-02, NFR-11)

## Context

M11 left the container-host part of T-036 NOT_RUN because this host had no container runtime.
M14 added Docker Engine 29.1.3 inside the WSL 2 distribution Ubuntu-24.04 and a containment
launcher that confines the subject client. T-036 asks that access be attempted from another
interface and from a container host, and that the default service be unavailable externally.

M13 left GHSA-g3hv-75wg-m249 (minimatch, moderate) open. Its only path was typescript-eslint
8.46.2 through `@typescript-eslint/typescript-estree` (minimatch 9.0.9). The advisory affects
minimatch `>=7.0.0 <11.0.1`. node-forge 1.4.2 (four advisories, dev only) is held by the
two-week cool-down until 2026-11-18 (ADR-0018).

## Decisions

1. **T-036 container-host part runs from three kinds of container on the real engine**
   (`packages/security-suite/runtime-test/t036-container-host-access.runtime.test.ts`, in
   `pnpm run test:containment`): the confined subject started by `ContainedSubject` exactly as a
   contained case is, an ordinary container on the default bridge network, and a container on the
   engine host's own network (`--network host`, which on Windows is the WSL 2 virtual machine).
   Each tries every RouteSpec listener port at every address of this host, of the engine host, the
   bridge gateway, the engine host's default gateway, its own loopback (`127.0.0.1`, `::1`,
   `localhost`) and host names (`host.docker.internal`, `gateway.docker.internal`, this host's
   name); the engine API ports 2375/2376 and sockets; WSL paths (`/run/WSL`, `/mnt/wsl`, `/init`,
   `/mnt/c/Windows/System32`); and running a Windows executable from the mounted checkout.
2. **Positive controls keep the negatives honest.** Every listener must answer on this host's
   loopback first. A control listener in a host-network container, bound to the engine host's
   non-loopback IPv4 addresses only (so WSL never forwards it to Windows loopback), must be
   reachable from the ordinary containers; the confined subject must get `ENETUNREACH`. The real
   proxy must answer the confined subject through its tunnel with a RouteSpec error code.
3. **Pass rules.** From the ordinary containers no attempt may connect to a RouteSpec listener.
   From the confined subject the only connections allowed are the two tunnel endpoints on its own
   loopback, and the launcher's tunnel counters must equal those connections plus the one HTTP
   request; every other network attempt must report no route (`ENETUNREACH`, `EHOSTUNREACH`,
   `EADDRNOTAVAIL`, `EAI_AGAIN`, `ENOTFOUND`; a refusal is allowed only on its own loopback). A
   timeout or a refusal elsewhere would mean packets left the container, and fails the test.
4. **Containment now requires an active seccomp filter in the self-observation**
   (`SELF_SECCOMP_NOT_FILTERED`). On this host WSL registers its Windows interop interpreter
   (`/init`) with binfmt flag `F`, so the kernel runs it inside containers too: executing a Windows
   `.exe` from the read-only checkout starts `/init`, which then fails on `socket(AF_VSOCK)` with
   EPERM from the engine's default seccomp profile (observed). An engine started without seccomp
   would not say so in `SecurityOpt`, so the engine record alone cannot prove the filter; the
   shim's own `/proc/self/status` (`Seccomp: 2`) must.
5. **Tunnel connections end with the subject side.** The T-036 run found that a subject closing a
   tunnel connection before the launcher's host-side connect completed left that connection open
   to its target after the subject and its container were gone, which kept the interceptor's
   orderly teardown waiting. The launcher now closes such a connection as soon as it is
   established, closes ended connections fully after flushing (the shim never keeps a half-open
   tunnel), and destroys every host-side socket it opened when the container exits
   (`packages/containment/runtime-test/m17-tunnel-teardown.runtime.test.ts`).
6. **The scenario proxy accepts an explicit loopback port** (`ScenarioProxyOptions.port`,
   integer 0-65535, default OS-assigned). The address stays 127.0.0.1. The runtime test uses the
   assigned 9350-9399 range for the control service (IPv4, IPv6) and the proxy. The canary
   interceptor and the live-dry adapter keep OS-assigned loopback ports: both are reviewed
   artifacts (the interceptor's artifact digest is pinned) and the assignment did not justify
   changing them.
7. **minimatch is overridden, not reached through a typescript-eslint upgrade.** No
   typescript-eslint release depends on a fixed minimatch: `typescript-estree` 8.46.0 to 8.56.0
   asks for `^9.0.4` or `^9.0.5`, and 8.56.1 to 8.72.2 (latest, 3 days old) for `^10.2.2`; both
   ranges are inside the advisory range. A scoped pnpm override in `package.json` maps `minimatch@>=7.0.0 <11.0.1` to
   `11.0.3` (published 2026-10-28T20:00Z, 14 days before this decision; 11.0.4 and later are
   newer than the cool-down). Its own dependencies are pinned to releases past the cool-down:
   `brace-expansion` 5.0.12 (2026-09-14; 5.0.13 is from 2026-11-11) and
   `@isaacs/nonrecursive-glob-match` 1.0.3 (2026-10-28T19:50Z; 1.1.0 is from 2026-11-05).
   minimatch 3.1.5 (through eslint) is outside the advisory range and unchanged. typescript-eslint
   stays at 8.46.2. A supplementary test checks the lockfile, the override, and that
   typescript-estree loads minimatch 11.0.3 and still matches globs as it calls them.
8. **pnpm `minimumReleaseAge` is not enabled.** Trying it (14 days) made `pnpm install` refuse the
   existing lockfile: `@rollup/rollup-win32-x64-msvc` 4.68.2 (via vite) was published
   2026-11-09. That entry has been in the lockfile since M00. A lockfile-wide cool-down would need
   that resolution revisited first; it is recorded as an open follow-up, not changed here.
9. **node-forge stays at 1.4.2 until 2026-11-18** (ADR-0018 rule unchanged).

## Consequences and limits

- T-036 is complete on this host for both parts: other interfaces (M11) and container hosts
  (M17). Ordinary containers reach the engine host's network but no RouteSpec listener. Attempts
  to this host's addresses time out from them (the WSL Hyper-V firewall drops them), and a
  host-network container reaches only the WSL VM's own loopback (WSL runs in `nat` networking
  mode here). The confined subject has no route at all except its two launcher-owned tunnels.
- In WSL `mirrored` networking mode, a host-network container's loopback would be this host's
  loopback. The test would then fail rather than pass. That mode was not run.
- Only one environment ran: Windows 11 host, Docker Engine 29.1.3 in WSL 2 (kernel 6.18.58.1, WSL
  3.0.5), image `node:22-bookworm-slim`. Plain Linux Docker, rootless engines, and other engines
  are NOT_RUN.
- The Windows-interop observation depends on WSL's binfmt registration. The product does not and
  cannot change it (no host setting is changed). The seccomp self-check makes a missing filter
  fail closed.

## Invalidation

Revisit if WSL networking is switched to `mirrored`, if the engine runs without its default
seccomp profile, if a typescript-eslint release depends on minimatch `>=11.0.1` (then drop the
override), or once a lockfile-wide release-age policy is adopted.
