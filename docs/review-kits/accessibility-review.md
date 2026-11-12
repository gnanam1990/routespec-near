# Review kit: manual accessibility review of the console

For: an accessibility reviewer, ideally a daily screen-reader user or an experienced auditor, who
is not on the RouteSpec team. It is self-contained: setup, a checklist for screen readers and
200 percent zoom mapped to the canonical test IDs, and a result template.

Status today (`docs/status/M09.md`, `BUILD-STATUS.md`): the automated parts of T-047 to T-052 pass
in Chromium on Windows against the real control service (Playwright plus axe WCAG 2.2 AA in light
and dark). **Not run:** screen readers (NVDA, JAWS, VoiceOver), a manual high-contrast review,
Firefox and WebKit, touch devices, Linux and macOS. Automated checks cannot tell whether
announcements make sense to a person; that is what this review adds.

The requirements are in `docs/spec/UI-SPEC.md` sections 6 to 8 and 10 and in
`docs/spec/TEST-PLAN.md` section 9.

## 1. Set up a console with real records

No container engine, account, or network access is needed. From a clean checkout (Node 22.18 or
newer, pnpm 10):

```sh
pnpm install --frozen-lockfile
pnpm run build:console
node --no-warnings packages/delivery/src/journey.ts --work <work> --out <work>/journey.json --no-ui
node --no-warnings packages/control-api/src/main.ts --data <work>/data --console apps/console/dist --handoff stderr
```

The journey (a few minutes) runs the real pinned client through a gate run, a failing case, a
capture, a reviewed promotion, a corrected-client rerun, and an export, so every page has real
data. The last command prints, on stderr, a console URL of the form `http://127.0.0.1:<port>/#token=...`.
Open it in the browser under test; the token is removed from the address bar on load. The URL is
a credential for this local session: do not paste it into a report or a recording. Stop the
service with Ctrl+C when done.

Primary navigation (UI-SPEC section 2): **Releases**, **Gate runs**, **Operations**,
**Regressions**, **Safety & Settings**. Deep pages: a gate run, a case run, a run operation with
its evidence drawer, and an import (the regression review).

Suggested combinations, at least one per row:

| Platform | Screen reader     | Browser         |
| -------- | ----------------- | --------------- |
| Windows  | NVDA (current)    | Firefox, Chrome |
| Windows  | JAWS (if present) | Chrome, Edge    |
| macOS    | VoiceOver         | Safari          |

For zoom, use the browser's own zoom set to 200 percent on a 1280 px wide window (not a
responsive-design emulator), and repeat once with Windows High Contrast / forced colors on.

## 2. Checklist

Mark each item Pass, Fail (with a finding id), or Not tested. "SR" is a screen reader, "Z" is
200 percent zoom.

### A. Shell and navigation (T-048, T-052; UI-SPEC 6.1, 8)

| #   | Check                                                                                                         | Mode  | Test ID      |
| --- | ------------------------------------------------------------------------------------------------------------- | ----- | ------------ |
| A1  | First Tab reaches a skip link; activating it moves focus to the main content                                  | SR, Z | T-048        |
| A2  | Landmarks (banner, navigation, main) are announced and the current page is identified in the navigation       | SR    | T-048        |
| A3  | The current project is announced in the header; switching project is an explicit, labelled control            | SR    | T-048        |
| A4  | Every page has one level-1 heading and a logical heading order                                                | SR    | T-048        |
| A5  | At 200 percent, every navigation item and core action is reachable without horizontal page scrolling          | Z     | T-048, T-052 |
| A6  | Focus is always visible (at least a 2 px high-contrast ring) and never hidden under a sticky header or footer | Z     | T-048, T-052 |

### B. Status axes (T-047, T-050; UI-SPEC 4, 6.2)

| #   | Check                                                                                                                                                                                          | Mode  | Test ID      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------ |
| B1  | On a gate run, the eight axes (Execution state, Verdict, Evidence, Subject identity, Effect coverage, Artifact, Enforcement, Official compatibility) are read as eight separately named values | SR    | T-047        |
| B2  | PASS, FAIL, REVIEW, and NOT_RUN are distinguishable by text alone (no meaning by colour or icon only)                                                                                          | SR, Z | T-050        |
| B3  | Each axis definition and freshness disclosure can be opened by keyboard and is read                                                                                                            | SR    | T-047        |
| B4  | "Proven within scenario", "Declared hooks only — REVIEW", and "Not release evidence" are announced as text, not only styled                                                                    | SR    | T-047        |
| B5  | With forced colors / High Contrast on, every badge keeps its label and the focus ring stays visible                                                                                            | Z     | T-050, T-052 |
| B6  | Long digests can be revealed or copied by keyboard; a copy announces success without moving focus                                                                                              | SR    | T-047        |

### C. Tables, timeline, pagination (T-050, T-051; UI-SPEC 6.3)

| #   | Check                                                                                                                   | Mode  | Test ID |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ----- | ------- |
| C1  | The case table and the release matrix have column headers; moving by cell announces header and value                    | SR    | T-047   |
| C2  | The visible result count is announced                                                                                   | SR    | T-050   |
| C3  | The session timeline has a table view with the same events in the same order; switching views is a keyboard tab control | SR    | T-050   |
| C4  | Applying a phase filter announces the new count without moving focus                                                    | SR    | T-050   |
| C5  | "Pause" stops live updates; streaming does not flood the screen reader with repeated announcements                      | SR    | T-050   |
| C6  | "Next page" keeps focus on the pager while the next page loads, and the new first row is reachable                      | SR, Z | T-051   |
| C7  | At 200 percent, wide tables scroll inside their own region only, with no body-level horizontal scroll                   | Z     | T-052   |

### D. Forms and errors (T-049; UI-SPEC 6.4)

Use **Gate runs → New gate run** and the trace upload on **Regressions**.

| #   | Check                                                                                                   | Mode  | Test ID |
| --- | ------------------------------------------------------------------------------------------------------- | ----- | ------- |
| D1  | Submitting an empty or invalid form moves focus to an error summary, which is announced                 | SR    | T-049   |
| D2  | Each summary link moves focus to its field                                                              | SR    | T-049   |
| D3  | Each invalid field announces its own error (invalid state and description) when focused                 | SR    | T-049   |
| D4  | Valid input is kept after a failed submit; fixing a field and leaving it clears only that field's error | SR    | T-049   |
| D5  | A server rejection (for example an unknown corpus) is announced in the page, and nothing is created     | SR    | T-049   |
| D6  | A secret-bearing trace upload is refused and announced, and the secret value is never read back         | SR    | T-049   |
| D7  | Every control has a visible label that matches its accessible name                                      | SR, Z | T-049   |

### E. Dialogs, drawer, recovery (T-048; UI-SPEC 6.5, 6.6)

| #   | Check                                                                                                                                   | Mode  | Test ID      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------ |
| E1  | Opening evidence from a run operation moves focus into the drawer, which has a heading; Escape and Back close it and return focus       | SR, Z | T-048, T-052 |
| E2  | At 200 percent (narrow CSS width) the evidence opens as a full-screen sheet with a predictable Back                                     | Z     | T-052        |
| E3  | Confirmation dialogs (review decisions, promotion, export, reconciliation) are titled, trap focus, have a visible Cancel, restore focus | SR, Z | T-048        |
| E4  | A crashed or fenced case offers only the read-only reconciliation action, and the reason is read in the page (not only in a toast)      | SR    | T-047, T-048 |
| E5  | Losing the service shows a stale banner that is announced; data stays visible and is not turned into PASS or FAIL                       | SR    | T-047, T-050 |

### F. Full keyboard and screen-reader journey (T-048)

With the screen reader on and no pointer, then again at 200 percent zoom without a screen reader:

1. Create a gate run on the journey's corpus, validate it, and start it.
2. Open a case and read its verdict, evidence, and effect coverage.
3. Open a FAIL or REVIEW case, its run operation, an invariant, and an evidence item.
4. On **Regressions**, open the captured import: read why it is or is not release evidence, the
   mapping, the replay result, and the review decisions.
5. Open the corrected-client gate run and read its lineage.
6. On **Safety & Settings**, read the network mode, live-dry state, and the export plan.

Record any step that needed a pointer, lost focus, announced nothing, or announced something
misleading. (Mutating steps the journey already did, such as promotion, may be refused because the
record exists; reading the refusal is itself a check of D5.)

### G. Other WCAG 2.2 AA items worth a manual look

Reflow at 320 CSS px (400 percent on 1280 px), text spacing overrides, target size (24 px minimum,
44 px on touch), timestamps that state their timezone, motion respecting `prefers-reduced-motion`,
and no content that appears only on hover.

## 3. Automated suites (optional, for context)

The automated counterpart runs in Chromium against the real service:

```sh
pnpm --filter @routespec/console exec playwright install chromium   # once
pnpm run test:e2e:real                                              # all console tests
pnpm --filter @routespec/console e2e:real t048                      # one file by name
```

| Test ID | File (`apps/console/e2e-real/`)    | What it automates                                                                    |
| ------- | ---------------------------------- | ------------------------------------------------------------------------------------ |
| T-047   | `t047-status-parity.spec.ts`       | the axes and rows equal the API records; stale and invalid-token states              |
| T-048   | `t048-keyboard-journey.spec.ts`    | the keyboard journey at default size and at 200 percent, focus visible at every stop |
| T-049   | `t049-error-announcement.spec.ts`  | error summary role and focus, field association, kept input                          |
| T-050   | `t050-t051-timeline-dense.spec.ts` | monochrome, forced colors, reduced motion; list/table parity; filter count; pause    |
| T-051   | `t050-t051-timeline-dense.spec.ts` | dense pagination with stable focus and timing targets                                |
| T-052   | `t052-responsive.spec.ts`          | 375 / 768 / 1024 / 1440 px, themes, contexts, 200 percent journeys                   |
| (axe)   | `shell-real.spec.ts`               | axe WCAG 2.2 AA on every route in light and dark; CSP; token removal                 |

## 4. Result template

```text
Console accessibility review — RouteSpec
Reviewer role / organisation:
Commit reviewed:                 Date:
Environment:  OS ____  browser ____ (version)  screen reader ____ (version)
              zoom 200 % at ____ px window   forced colors: on/off
Checklist results:
  A1 __ A2 __ A3 __ A4 __ A5 __ A6 __
  B1 __ B2 __ B3 __ B4 __ B5 __ B6 __
  C1 __ C2 __ C3 __ C4 __ C5 __ C6 __ C7 __
  D1 __ D2 __ D3 __ D4 __ D5 __ D6 __ D7 __
  E1 __ E2 __ E3 __ E4 __ E5 __
  F (journey) steps needing help: ____
  G notes:

Findings (one block each):
  ID:            A11Y-<nn>
  Checklist item / Test ID:
  WCAG 2.2 criterion:
  Severity:      blocker | serious | moderate | minor
  Page / route and steps:
  Expected:
  Actual (what was announced or seen):
  Suggested fix:
```

## 5. After the review (owner)

Add the results to `docs/status/M09.md` (screen-reader and manual high-contrast rows, with the
environment), turn each finding into a fix with a regression test in `apps/console/e2e-real/`
where it can be automated, rerun `pnpm run test:e2e:real`, and update the M09 row of
`BUILD-STATUS.md`.
