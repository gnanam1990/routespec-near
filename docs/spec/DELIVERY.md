# RouteSpec Delivery Runbook

Status: **SPECIFICATION_ONLY**  
Product/runtime verification: **NOT_RUN**  
Customer demand: **UNPROVEN**

This runbook describes the intended engineering-delivery process. It does not prove that a repository, branch, pull request, deployment, public post, or hackathon submission exists.

## Repository boundary

- Proposed owner: `gnanam1990`
- Proposed repository: `gnanam1990/routespec-near`
- Proposed visibility: **private**
- Sibling submission: `Dockside`
- The two projects must use separate repositories, issue histories, branches, commits, pull requests, deployments, demos, and submission records.
- Shared research or generic templates must be disclosed. Project-specific implementation and judging claims must remain independent.

Repository existence, owner access, visibility, default branch, protection rules, secrets, and remote state must be verified immediately before any remote action.

## Authorization gates

The coding agent may work locally without additional approval. It must stop and request explicit user authorization before any of the following:

1. creating or changing a remote repository;
2. pushing any branch, tag, commit, or release;
3. opening, updating, closing, approving, or merging a pull request;
4. changing repository visibility or collaborator access;
5. creating or changing a deployment, domain, cloud resource, paid service, or secret;
6. using a live dry-provider probe or any external credential; funded operations remain prohibited;
7. publishing source, documentation, screenshots, video, or a public demo;
8. posting to X or another social platform;
9. submitting or editing the hackathon entry;
10. accepting terms, signing a wallet message, registering an account, or spending money.

Authorization for one gate does not imply authorization for another. A request to prepare a PR does not authorize opening it; CI success does not authorize merge or deploy.

## Local delivery sequence

1. Verify the local checkout, exact base SHA, working-tree state, toolchain, and required environment variables without printing secret values.
2. Create one focused local branch per module or coherent change. Suggested pattern: `feat/module-slug`, `fix/issue-slug`, or `docs/artifact-slug`.
3. Implement only the module acceptance criteria and tests assigned to that branch.
4. Run formatting, static checks, unit tests, integration tests, and the relevant end-to-end/failure-path check.
5. Update `BUILD-STATUS.md` with exact commands, observed results, commit SHA, known gaps, and evidence links.
6. Create focused commits. Do not combine unrelated refactors, formatting sweeps, generated artifacts, secrets, or project-sibling code.
7. Prepare a PR body using `templates/PR-BODY.md`, but do not open the PR without authorization.
8. Review the complete diff against the module contract and `templates/REVIEW-CHECKLIST.md`.
9. After explicit authorization, push the branch and open the PR. Record the remote branch and PR URL.
10. Treat CI and review as evidence, not merge authorization. Merge only after a separate explicit user instruction.

## Commit discipline

Use focused Conventional Commit messages, for example:

- `feat(journal): add durable operation transitions`
- `feat(binding): persist project operation-key digest`
- `test(recovery): cover late terminal-state reconciliation`
- `docs(demo): add reproducible judge path`

Every commit must build on its declared parent, avoid unrelated user changes, and leave the repository in an explainable state. Never rewrite shared history or force-push without a separately explicit instruction.

## Pull-request evidence

Each PR must state:

- exact base and head SHAs;
- module and user outcome;
- implementation boundary and exclusions;
- test commands and actual results;
- real, sandbox/testnet, seeded, and mocked dependencies;
- screenshots or traces only when produced from the running build;
- failure and recovery behavior;
- security, privacy, and fund-handling implications;
- unresolved gates and rollback plan;
- whether any content is shared with the sibling project.
- independent gate decision, `artifactReady`, and `enforcementMode`;
- exact repository, head SHA, dirty-tree digest, built-artifact digest, and workflow run used for any enforcement claim.

## Merge discipline

- Prefer reviewed, non-interactive merges through the hosting platform.
- Rebase or update the branch only after checking for new upstream changes and preserving user work.
- Require resolved review findings. RouteSpec v2 discloses only `LOCAL_ADVISORY`, `CI_CHECK`, or `REQUIRED_CHECK_UNVERIFIED`; it has no repository-settings verification adapter, accepts no caller-supplied protection state as proof, never claims blocking, and authorizes no external configuration.
- Do not treat an approval, green CI, scheduled deadline, or prior instruction as standing merge permission.
- After authorized merge, verify the resulting merge commit/default-branch SHA and rerun the proportionate smoke test.

## Event boundary

Official submission deadline recorded for this pack: **2026-11-14T23:59:00Z**. Re-verify the official rules immediately before any consequential event action. The deadline does not relax authorization, evidence, security, or truthful-status requirements.

