# SEC RS-05 — Journal data directory and journal.db readable by other local users: status evidence

- Source: external security audit, finding RS-05 (LOW, confidentiality, multi-user POSIX hosts
  only). Re-confirmed with a failing test on the real code before any change.
- State: **FIXED** on `feat/routespec-m27-data-dir-permissions` (base `c588307`, `main` merged in
  before the final runs).
- ADR: none. No protocol or interface between components changed; this restores the stated
  control in SECURITY.md section 9 ("Data directory uses owner-only permissions where
  supported").

## Finding (verified)

Every CLI command with `needsData` opens the journal through `openStore`
(`packages/cli/src/commands.ts`), which called `mkdirSync(dataDir, { recursive: true })` with no
mode. `JournalDb.open` (`packages/store/src/database.ts`) then let `node:sqlite` create
`journal.db` with its default mode. Under the common 0022 umask the directory was 0755 and the
journal 0644, so any other OS account could read quote requests, deposit addresses, memos, gate
and audit records. The control service passed `mode: 0o700` to `mkdirSync`, but that mode only
applies to a directory the call creates; a directory first created by the CLI, or one that
already existed, stayed readable, and nothing ever tightened `journal.db` or its companions.

## Change

The decision is made once, in the store, and both entry points use it:

1. `ensurePrivateDataDir(dir)` (exported from `@routespec/store`) creates the directory with
   mode 0700 and, on POSIX, `chmod`s an existing one to 0700. `openStore` in the CLI and the
   control service startup (`packages/control-api/src/main.ts`) call it instead of `mkdirSync`.
2. `JournalDb.open` (writable mode) creates a missing journal file as 0600 before SQLite opens
   it, so the database never exists with the default mode, and `chmod`s `journal.db`, `-wal`,
   `-shm`, `-journal` and `.writer.lock` to 0600 before the open and again after WAL mode is
   set. The writer lock is created with mode 0600.
3. A `chmod` failure other than a missing file is refused with `RS_STORAGE_UNAVAILABLE`: the
   journal is not opened with permissions the platform could not tighten.

Read-only opens do not change file modes. On Windows there are no POSIX mode bits; the data
directory relies on the user-profile ACLs, as before.

## Test (red, green)

`packages/cli/test/sec-rs05-data-dir-permissions.test.ts`, run with umask 0022:

- `routespec project create --data <tmp>/fresh/data` through the real `runCli`: directory is
  0700, `journal.db` and its existing companions are 0600;
- an existing data directory chmodded to 0755 with `journal.db` at 0644 is tightened by the next
  CLI command;
- `ensurePrivateDataDir` tightens an existing 0755 directory (the service path);
- `RouteSpecStore.open` on a pre-existing 0644 journal file tightens it and its WAL/SHM/lock
  files.

The mode checks are POSIX only (`describe.skipIf(win32)`), so red and green were run on Linux:
the worktree's tracked and new files were copied into a throwaway `node:22-bookworm-slim`
container (`wsl.exe -d Ubuntu-24.04 -u root --exec docker ...`, non-root `node` user),
`pnpm install --frozen-lockfile` from the npm registry, then `umask 0022; pnpm exec vitest run`.

| Step                                                                                       | Exit | Result                                                                                                    |
| ------------------------------------------------------------------------------------------ | ---- | --------------------------------------------------------------------------------------------------------- |
| `vitest run packages/cli/test/sec-rs05-data-dir-permissions.test.ts` (Linux), before       | 1    | 4 failed (4): directory `755` (expected `700`) for the CLI-created and reused cases; helper did not exist |
| same plus `packages/store/test` and `packages/cli/test/t046-cli-exit-codes.test.ts`, after | 0    | 12 files, 61 passed                                                                                       |

## Full regression (Windows host, after `git merge main`)

Environment: `ROUTESPEC_TEST_PORT_BASE=9740`, `ROUTESPEC_DELIVERY_PORT=9745`, `FIXTURE_PORT=9748`
(ports 9740-9749),
`ROUTESPEC_CONTAINER_CLI='["wsl.exe","-d","Ubuntu-24.04","-u","root","--exec","docker"]'`.

| Command                     | Exit | Result                                                                                                |
| --------------------------- | ---- | ----------------------------------------------------------------------------------------------------- |
| `pnpm run check`            | 0    | typecheck, lint, format, 84 files passed / 1 skipped, 715 tests passed / 6 skipped; secret-scan clean |
| `pnpm run test:containment` | 0    | 4 files, 19 passed                                                                                    |
| `pnpm run test:delivery`    | 0    | 2 files, 21 passed (M12 uncontained 14, M14 contained journey 7)                                      |

Note: `main` (RS-04, then RS-06, then RS-02 and RS-07) was merged three times while this branch
was open; the table is the run on the final merge. Two earlier `pnpm run check` runs, taken while other suites kept the host CPU at
90-99%, had timing failures in `packages/cli` T-057 (60 s timeout) and T-025 (child killed
before its fault point); T-057 also timed out alone under that load. In a single Linux container
the fixed `database.ts` gave the same T-025 timings as the `main` baseline, and the final run
above passed. One intermediate `pnpm run test:delivery` (after the RS-06 merge, host under load)
had the M14 contained journey fail on a missing interceptor attestation; the same file passed on
the `main` commit and then on this branch when rerun, and the final full run above passed. On Linux, T-053 (`LOCAL_PATH` in the bundle manifest for
`/home/...` temp paths) and M14 export-kill fail on `main` as well; they are unrelated to this
change and are not part of the Windows suite result.

## Residual

- Windows has no POSIX modes; the protection there is the per-user profile ACL of the chosen data
  path. A data directory placed in a shared, ACL-open Windows folder is not tightened.
- Parent directories of the data directory are not changed. A user who points `--data` at a path
  inside a world-writable parent still gets an owner-only data directory, but the parent's own
  permissions are the operator's choice.
- Backups written by `backupVerified` (`VACUUM INTO`) and export files are outside this finding
  and were not changed here.
