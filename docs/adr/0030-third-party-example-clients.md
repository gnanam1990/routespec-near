# ADR-0030 — Third-party example clients: pinned, fetched, contained (M48)

- Status: accepted
- Date: 2026-11-13
- Module: M48 (official example clients). Builds on ADR-0002 (SDK pin), ADR-0007 (client
  adapter), ADR-0019 and ADR-0020 (container containment). Changes none of them.
- Numbering: 0027 to 0029 are left for modules built in parallel with this one.

## Context

Every client RouteSpec had run so far was written for RouteSpec. M48 runs example code published
by others. The specification pack does not describe this, so the decisions below go beyond it.
None of them changes the protocol profile, the kernel, the proxy, the adapter, or containment.

Third-party code is untrusted. It must never run on the host, and its bytes must be the bytes that
were reviewed.

## Decisions

1. **Nothing third-party is committed.** `examples/third-party/pins.json` names a repository, a
   full 40-character commit, the licence, the entry file, and every file that may be read, each
   with the SHA-256 of its git blob. The files are fetched on request into `.data/third-party/`
   (ignored by git). The licence file is always one of the pinned files, so the licence text
   travels with the fetched example.
2. **Licence and standing are rules in code.** A pin is refused unless its licence is one of
   `MIT`, `ISC`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `0BSD`, and its standing is
   `OFFICIAL` or `WELL_KNOWN` with a written note. A repository without a licence grant is not
   pinned, even when it is official and public. The reading of every candidate is recorded in
   `examples/third-party/README.md`.
3. **The fetch executes nothing.** `support/fetch.ts` fetches exactly the pinned commit into a
   throw-away bare repository, checks that the commit returned is the pinned one, refuses any
   entry that is not a regular file, reads each pinned file as a blob (no checkout, so no hooks,
   filters, or line-ending conversion), and compares its digest before writing it. It never runs
   an install, a build, or a script of the fetched repository, and it writes only the pinned files.
4. **Contained only.** `packages/delivery/src/third-party.ts` has no uncontained path: without an
   available container engine and image, or without verified files, it launches nothing and exits
   2 with `NOT_RUN`. Each adapter also refuses to load the example unless the process is inside a
   Linux container (`/.dockerenv` or `/run/.containerenv`). That check only stops an accident. The
   boundary is the M14 container: no network, read-only root, no capabilities, non-root, one
   tunnel to the RouteSpec proxy.
5. **A confined loader, not an install.** RouteSpec does not install a third-party dependency
   tree. `support/confined.ts` registers module hooks that serve only the pinned files (digest
   checked again as each is read), allow imports only between pinned files and of the bare
   specifiers listed in the pin, and refuse everything else, including Node built-ins. The hooks
   stay registered for the life of the subject process. TypeScript is translated with the
   repository's pinned compiler (`transpileModule`, one file at a time, no type check); the
   source text is not edited. Consequence: only
   examples whose imports RouteSpec already installs can be pinned. The loader is an identity
   control. It is not a sandbox: code in the process can still reach built-ins through
   `process`. The container is the sandbox.
6. **The SDK stays on the proxy.** An example normally assigns the hosted 1Click URL to
   `OpenAPI.BASE`. The adapter replaces that property with an accessor that keeps the RouteSpec
   proxy origin and records what the example tried to assign. This is the one behaviour of the
   example that is overridden, and every run record lists it (`baseAssignmentsIgnored`). Without
   it the example would address a host that the container cannot reach.
7. **Observation without interference.** The adapter wraps the static methods of the SDK's
   `OneClickService` only to record each call and its outcome, and returns the SDK's own promise
   unchanged. It records the first printed lines as text. A script-style example has no result to
   await, so the adapter treats the flow as finished when no SDK call has been in flight for 1.5
   seconds (limit: 120 seconds, then `TIMEOUT`). The outcome is reported as `SUBJECT_REPORTED`;
   no verdict depends on it.
8. **SDK version.** RouteSpec's adapter attaches only to the pinned SDK `0.1.26` (ADR-0002). A
   pinned example therefore runs with that version even when its own manifest names another one.
   The difference is recorded with the result.
9. **Declared effects.** The control API requires at least one declared effect hook per build. An
   example that performs no protected effect declares the canary sink as `OPTIONAL`. Its effect
   coverage is then reported as incomplete (the sink is never reached). That is the accurate
   state and it keeps the case from passing on effect coverage it never demonstrated.
10. **The profile is not widened for an example.** `GET /v0/tokens` stays outside the
    `oneclick-v0` profile. An example that needs it is recorded as not evaluable rather than made
    to pass.

## Consequences

- The first pinned example (`examples/basic-swap-flow.ts` of the official SDK repository) stops
  at its first call, the token list, and RouteSpec evaluates no invariant for it. That result is
  recorded as it is. Serving a read-only token list in the simulator would be a profile change
  and needs its own decision against the specification.
- The target of two to four repositories was not met: one repository satisfied every rule on
  2026-11-13. Adding another is a pin, an adapter of about sixty lines, and a notice file.
- The fetch needs the network once. Tests never fetch: the contained runtime test reports
  `NOT_RUN: THIRD_PARTY_SOURCES_ABSENT` when the files are not on disk.
