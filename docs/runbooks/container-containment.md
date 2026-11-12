# Runbook: container containment for subject clients (M14)

This runbook sets up a Linux container engine for RouteSpec's containment launcher and runs the
contained product journey. With it, the subject client's whole process tree runs in a container
that has no network (only a loopback tunnel to the RouteSpec proxy and the effect interceptor),
a read-only root filesystem, no capabilities, and a non-root user. Without it, RouteSpec still
works, but effect coverage stays `DECLARED_HOOKS_ONLY` and INV-04 stays REVIEW.

Decisions and limits: `docs/adr/0019-container-containment.md`. Evidence: `docs/status/M14.md`.

## What you need

- A Linux container engine that `docker version` reaches, with server OS `linux`.
  - On Linux: Docker Engine, with your user allowed to run `docker`.
  - On Windows: Docker Engine installed **inside a WSL 2 distribution** (Docker Desktop is not
    needed and is not used). The commands below assume the distribution `Ubuntu-24.04`.
- The pinned image present locally. RouteSpec never pulls an image:
  `node:22-bookworm-slim` by default (`--container-image` or `ROUTESPEC_CONTAINER_IMAGE` change it).
- Node 22.18 or later and pnpm 10 on the host, as for the rest of RouteSpec.

## One-time setup on Windows (WSL 2 + Docker Engine)

These are your own administrative actions; RouteSpec does not perform them.

1. Install WSL 2 and Ubuntu 24.04 (an elevated PowerShell, once): `wsl --install -d Ubuntu-24.04`.
   Reboot if asked, then open Ubuntu once to create your Linux user.
2. In Ubuntu, install Docker Engine from Docker's apt repository (see Docker's "Install Docker
   Engine on Ubuntu" page), for example:

   ```bash
   sudo apt-get update && sudo apt-get install -y ca-certificates curl
   sudo install -m 0755 -d /etc/apt/keyrings
   sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
   echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
     https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
     | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
   sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io
   ```

3. Make sure systemd runs in the distribution (`/etc/wsl.conf` with `[boot]` / `systemd=true`,
   then `wsl --shutdown` from Windows) so the Docker service starts with the distribution.
4. From Windows, check the engine and pull the image once:

   ```powershell
   wsl.exe -d Ubuntu-24.04 -u root --exec docker version --format '{{json .Server.Os}}'
   wsl.exe -d Ubuntu-24.04 -u root --exec docker pull node:22-bookworm-slim
   ```

   From Git Bash prefix these with `MSYS_NO_PATHCONV=1`.

Windows paths appear inside WSL as `/mnt/<drive>/...`. RouteSpec mounts the installed checkout
read-only at that same path inside the container, so pnpm's links keep working.

## Tell RouteSpec which engine command to use

`ROUTESPEC_CONTAINER_CLI` (or the service flag `--container-cli`) holds the engine command, best
as a JSON array:

| Host                     | Value                                                                  |
| ------------------------ | ---------------------------------------------------------------------- |
| Linux                    | `["docker"]`                                                           |
| Windows, Engine in WSL 2 | `["wsl.exe","-d","Ubuntu-24.04","-u","root","--exec","docker"]`        |
| Other engine CLI         | its argv, for example `["podman"]` (untested; must report `Os: linux`) |

For `wsl.exe` the command must end with `--exec <engine>`. A plain `--` separator is rewritten to
`--exec`, because `--` runs the command through the distribution's shell, which would expand `$`
and other characters inside arguments. Running the engine as `root` inside WSL only gives the
CLI access to the engine socket; the subject container itself always runs as uid 1000 with no
capabilities.

PowerShell:

```powershell
$env:ROUTESPEC_CONTAINER_CLI = '["wsl.exe","-d","Ubuntu-24.04","-u","root","--exec","docker"]'
```

## Run the containment tests

```bash
pnpm install --frozen-lockfile --offline
pnpm run build
pnpm run test:containment
```

- `packages/containment/runtime-test`: real escape attempts from inside the container (direct
  TCP/UDP egress over IPv4 and IPv6, DNS, the gateway and WSL host address, other loopback
  listeners, writes outside `/tmp`, execution from `/tmp`, `setuid`, a detached daemon in a new
  session, a process flood) plus a deliberately weak container that must not be reported as
  enforced.
- `packages/control-api/runtime-test`: the control service launching the corrected official
  client build confined, with attested case and interceptor launches; a swapped artifact; a
  revoked launcher principal.

Without a reachable engine or image every test is skipped and its note says why, for example
`NOT_RUN: CONTAINER_RUNTIME_ABSENT (ENOENT)` or `NOT_RUN: CONTAINER_IMAGE_ABSENT`. Skipped is not
passed: record it as NOT_RUN.

## Run the contained product journey

From a clean clone (the delivery suite does this for you, including the containment suite from
the clone):

```bash
pnpm run test:delivery          # M12 journey and the M14 contained journey
```

Or the journey alone, from an installed checkout with the console built:

```bash
pnpm run build:console
node --no-warnings packages/delivery/src/journey.ts --work <empty-dir> --out <journey.json> --contained
```

`ROUTESPEC_CONTAINMENT_EVIDENCE=<file>` makes the delivery suite write the contained evidence
record (install identity, containment suite tail, the whole journey record).

## Run the control service with containment yourself

```bash
node --no-warnings packages/control-api/src/main.ts --data <dir> \
  --subject-root <installed checkout> \
  --container-cli '["docker"]' --container-image node:22-bookworm-slim \
  --launcher packages/containment/src/attesting-launcher.ts --launcher-key <operator key file>
```

1. Create an Ed25519 key pair; keep the private key in an owner-only file (the service passes its
   path to the launcher and never reads it). Enroll the public key as a `LOCAL_LAUNCHER_KEY`
   principal whose `launcherArtifactDigest` is `launcherArtifactDigest(<launcher path>)` from
   `@routespec/containment` (entry script plus the containment and contracts sources). Enrollment
   needs the local confirmation code the service prints to its operator channel.
2. Register the build with `repositoryLocator: git+file:<path inside the subject root>`, the
   artifact's SHA-256, `toolchainDigest = containerToolchainDigest(<image id>)`, the lockfile's
   SHA-256, and `effectManifestDigest` = SHA-256 of `<artifact>.effects.json` (the declared hooks).
   Then `POST /launcher-challenges` with scope `BUILD_REGISTRATION`: the launcher measures those
   files and the image itself.
3. Register an interceptor profile (`PROCESS_TREE_ENFORCED`, the reviewed canary interceptor's
   artifact digest, the required sinks) and an `INDEPENDENT_BOUNDARY_INTERCEPT` policy per scenario
   (`casePolicies` on the gate run for corpora with several scenarios).
4. Start each case with `POST /case-runs/{id}/contained-start` naming the principal and the job.
   The case token goes to the subject only; poll `GET /case-runs/{id}/containment`; then
   `POST /case-runs/{id}/finish-input`.

## Troubleshooting

| Symptom                                           | Meaning and fix                                                                         |
| ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `NOT_RUN: CONTAINER_RUNTIME_ABSENT (ENOENT)`      | the engine command was not found: check `ROUTESPEC_CONTAINER_CLI`                       |
| `NOT_RUN: CONTAINER_RUNTIME_ABSENT (EXIT_1)`      | the engine did not answer: start Docker in the distribution (`systemctl status docker`) |
| `NOT_RUN: CONTAINER_IMAGE_ABSENT`                 | pull the pinned image once (step 4)                                                     |
| `RS_CONTAINMENT_UNAVAILABLE` from contained-start | the service has no `--subject-root`, or detection failed (reason in `details`)          |
| `RS_IDENTITY_MISMATCH` from contained-start       | the artifact on disk is not the registered artifact (rebuild or re-register)            |
| attestation `NOT_ATTESTED` in the case view       | no launcher for the principal (revoked, digest changed, or `--launcher` missing)        |
| containment `DECLARED_HOOKS_ONLY` with findings   | the engine record shows a weaker setting; the case stays REVIEW (read `findings`)       |
