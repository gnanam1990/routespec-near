# Reviewer kits

Self-contained briefings for people other than the repository owner. Each kit says what to look
at, the exact commands, what to check, and how to report. Hand a reviewer the kit and a commit SHA;
they should not need anything else from this repository's history.

| Kit                                                            | For                                   | Closes                                                                                  |
| -------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------- |
| [interceptor-profile-review.md](interceptor-profile-review.md) | an independent reviewer and the owner | the independent review of the canary interceptor profile (RP-02/RP-06, `WORKING_LOCAL`) |
| [security-review.md](security-review.md)                       | an external security reviewer         | the independent security review (`docs/spec/SECURITY.md` section 15)                    |
| [accessibility-review.md](accessibility-review.md)             | an accessibility reviewer             | the manual screen-reader and 200 percent zoom pass of the console (T-047 to T-052)      |

Ground rules for every kit:

- Reviewers never receive the control token, local confirmation codes, launcher keys, or any
  provider credential. The profile reviewer's private key never leaves their machine.
- No kit needs a provider account, a wallet, or funds, and none sends a request to the official
  endpoint.
- RouteSpec cannot establish that a reviewer is independent; the owner records who reviewed (by
  role), how independence was arranged, and the findings, in the status files each kit names.
- A review result is evidence about the reviewed commit only. Rerun the named suites on any later
  commit before relying on it.

The owner's overall checklist of what is left is `docs/USER-NEXT-STEPS.md`.
