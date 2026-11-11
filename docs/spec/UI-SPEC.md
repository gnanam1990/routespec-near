---
project: RouteSpec
version: 2.0.0
artifact_status: SPECIFICATION_ONLY
product_runtime_status: NOT_RUN
design_status: PROPOSED
updated_at: 2026-11-11
---

# UI specification

## 1. Experience objective

RouteSpec's console is an engineering evidence product, not a marketing dashboard. A user should answer four questions without reading raw logs first:

1. What is the release-check decision for this exact project, subject build/artifact, gate run, case set, and corpus, and what enforcement is actually claimed?
2. Which isolated case, run operation, phase, effect hook, and invariant blocked it?
3. What is proven, reported, missing, private, stale, or unsupported?
4. What safe action produces the next evidence?

The visual design is dense, calm, precise, and modern. Motion is subtle and optional. Status never relies on color alone.

## 2. Information architecture

### Primary navigation

1. **Releases** — project/revision/subject-build/gate-run/corpus matrix, decision, artifact readiness, enforcement mode, separate compatibility, regressions, and compare.
2. **Gate runs** — create/validate/start a corpus run; inspect isolated case runs, client/token lifecycle, recovery, and aggregation.
3. **Operations** — searchable logical jobs and scoped run-operation/evidence explorer.
4. **Regressions** — installed captures, quarantine, sanitization, mapping, review, immutable scenarios, new corpora, and corrected-client reruns.
5. **Safety & Settings** — network mode, official live-dry compatibility, provider connection state, redaction, retention, exports, and local data deletion.

The current project is visible in the persistent header. Project switching is explicit and cannot happen while a destructive confirmation dialog is open.

## 3. Page specifications

### 3.1 Releases

Default landing view for a configured project.

#### Header

- Project name and local-only badge.
- Integration and subject-build selectors displaying label plus shortened revision/artifact digest and attestation (`USER_ASSERTED_LOCAL`, `TRUSTED_LAUNCHER`, or `CI_ATTESTED`).
- Corpus revision selector with case count and digest.
- Primary action: `Run gate`.
- Secondary action: `Compare revisions`.

#### Gate summary

- Separate text/icon rows for execution lifecycle, verdict (`PASS`, `FAIL`, `REVIEW`, `NOT_RUN`), evidence sufficiency, subject-build attestation, effect coverage, `artifactReady`, enforcement mode, and official-endpoint compatibility. These axes never collapse into one badge or imply one another.
- Identity strip: repository, commit SHA, dirty-tree digest, subject `buildRevisionId`, artifact/effect-policy/manifest/call-site-inventory/interceptor-profile digests, subject and interceptor attestations, gate run, ordered case runs, fencing epochs, workflow run, app revision, corpus, evaluator, adapter, protocol profile, and configuration.
- Counts: passed, failed, review, unsupported-required, not run.
- Last evaluation time clearly separated from evidence observation time.
- Enforcement copy is limited to `Local advisory`, `CI check`, or `Required check — verification unavailable`. RouteSpec v2 never displays `Blocks release`, a lock icon, or branch-protection implication. `OFFICIAL_ENDPOINT_COMPATIBLE` appears only in its separate compatibility row.

#### Case matrix

Rows are immutable `CaseRun` records; columns show scenario, lineage role, build/artifact, client/interceptor/reset lifecycle, token state, fencing epoch, effect-coverage basis and finding, current/comparison result, severity, provenance, and required invariants. `Independent boundary`, `Inventory + boundary`, and `Declared hooks only — REVIEW` are explicit text, never a generic green coverage badge. Cells include text/code and icon, not a color-only dot. Keyboard users can enter a cell and open the same detail as pointer users. Baseline/corrected/replay cases remain visibly isolated even when their logical-job label matches.

#### Empty/loading/error states

- No revision: explain how to register one; no fake sample metrics.
- No corpus: link to regression library and describe required identity.
- Evaluation running: progress by completed cases with cancel/leave controls; do not fabricate percentage from elapsed time.
- Service disconnected: freeze displayed data, mark it stale, and offer reconnect.
- Partial result: label REVIEW and list incomplete cases.

### 3.2 Gate run and case workspace

#### Step 1 — Select identity

Choose project revision, mandatory subject build/artifact, immutable build attestation or user assertion, corpus, effect policy/manifest, optional trusted call-site inventory, reviewed interceptor profile when complete effect coverage is required, versioned actual-client adapter, protocol profile, evaluator, and bounded parallelism. The central run supports SIMULATE/REPLAY through the networkless scenario runtime only. A separate `Run official dry compatibility probe` action lives under Compatibility and states “No settlement is tested”; it never appears as a gate-run mode.

#### Step 2 — Preflight

Shows exact pinned SDK/schema/adapter, build/artifact/effect-policy/manifest/inventory/interceptor identity, attestation source/freshness/revocation, subject and interceptor challenge status, isolated ordered cases, required sink classes/hooks, process-tree/sandbox scope, reset strategy, bounded parallelism, local ports, loopback binding, resource budget, and preflight findings. Invalid identity, unsupported adapter, reused client, or insufficient resources block start. `DECLARED_HOOKS_ONLY`, unsupported analyzer constructs, incomplete interceptor scope, or unavailable interception may start only as an explicitly labelled diagnostic run whose complete-effect predicates will be REVIEW. Provider-token state is `NOT_REQUIRED` here.

#### Step 3 — Connect client

For the selected case, displays proxy URL, non-secret session/case IDs, one-time `X-RouteSpec-Case-Token`, stable `X-RouteSpec-Logical-Job`, unique transport request ID, adapter/fencing headers, official SDK base-URL example, client-instance identity, expiry, and subject/interceptor launcher checklists. It explains that RouteSpec assigns the run-operation identity and that retries within this case reuse it while other builds/cases never do. The interceptor's private IPC credential is never shown to the subject, browser, or case-token holder. Provider `Authorization` and all RouteSpec headers are stripped before a live upstream boundary. The clear case token disappears after acknowledgement/expiry and is never available in history.

#### Step 4 — Live trace

Shows gate/case/session/build identity, proxy virtual time, timer canonicality, expected next phase, logical-job/run-operation correlation, quote-finalization and commit-binding status, received exchanges, required sinks/hooks, subject reports, independent boundary observations, inventory/interceptor/process-tree coverage, token/epoch state, and safety denials. Source labels and columns prevent self-report from appearing as independent coverage. External wall-timer evidence is labelled noncanonical REVIEW unless clock/transport injection is active. User can cancel a case; cancellation revokes its token and produces incomplete REVIEW, never PASS.

#### Step 5 — Evaluation

Shows deterministic case evaluation and gate aggregation separately. A crash/restart presents `Reconcile existing operation`, which revokes the stale token, increments the epoch, and issues read-only recovery; no generic mutation Retry is present. Optional explanation is visually separated and labelled non-authoritative.

### 3.3 Operation explorer

#### Summary rail

- Masked logical-job and run-operation IDs plus exact binding digest; typed baseline/correction/replay/promotion lineage is visible without implying shared mutable state.
- Exact project/build/artifact/gate/case/session/adapter/effect-policy/manifest/inventory/interceptor/fencing identity, visually distinct from transport request IDs.
- Four ordered phase groups: immutable quote-request fields (including deposit type but no assigned deposit address); atomic quote finalization (quote/correlation identity, returned constraints, response-assigned deposit address, extensions); one-time commit binding (method/route, body/material digest, finalized quote, deposit address, transaction/signed-material digest); and read-only reconciliation. Partial, changed, concurrent, second-commit, and stale-epoch conflicts render as rejected findings without overwriting the original binding.
- Provider reported outcome and independently evaluated outcome shown side by side.
- Attempt count and uncertainty state.

#### Timeline

A vertical ordered timeline combines client request, proxy response/drop/barrier, quote/commit/reconciliation phases, provider observation, required sinks/hooks, subject reports, independently intercepted boundary observations, token revocation/epoch recovery, scenario ground truth, evidence, and invariant evaluation. Each event has build/gate/case/session/run identity, sequence, virtual and wall time, timer canonicality, source, evidence class, evidence scope/reason, and expansion control. Raw provider facts, normalized facts, subject reports, independent boundary observations, inventory/interceptor coverage findings, and separate live-probe results are separate tabs.

The timeline has a table fallback always available. Focus/keyboard interaction reveals the same data as hover. Streaming updates can be paused. Reduced-motion users see instant stable updates.

#### Invariant panel

Each `INV-*` row shows status text, applicability, facts, evidence IDs, missing predicates, and remediation code. The user can filter failures/review without losing hidden-count context.

#### Evidence drawer

Shows mandatory build/artifact/attestation/gate/case/session/scenario/effect-policy/manifest/inventory/interceptor/epoch identity plus provenance, subject, observation/collection time, class, scope, reason, freshness, digest, and exclusion/redaction. `SIMULATED_GROUND_TRUTH` uses the exact phrase “proven within scenario.” `SUBJECT_REPORTED` says “reported by subject; does not prove coverage.” Independent boundary observations name the interceptor profile, sandbox/process-tree scope, supported sink class, and attestation freshness. Sensitive locator reveal is a local explicit action and is never captured in exports by default.

### 3.4 Regression library

#### Quarantine queue

Displays source type (`Installed artifact capture` or `User file`), exact source build/gate/case/session when installed, sanitized name, digest, size, current state (`CAPTURED_UNTRUSTED`, `QUARANTINED`, `SANITIZED`, `MAPPED`, `REPLAY_VERIFIED`, `REVIEWED`, `PROMOTED`, or `REJECTED`), secret/nondeterminism/unresolved-material findings, and expiry. No trace content is rendered as HTML.

#### Review workbench

Side-by-side sanitized source events and proposed normalized phase/effect events. The user must resolve source identity, run-operation phase binding, expected outcome, forbidden behavior, required effect coverage, evidence limits, provenance, redaction, and deterministic replay before promotion. Secret-bearing, nondeterministic, unresolved, identity-mismatched, or unreviewed content has no Promote action. A focusable error summary links to every unresolved field.

#### Scenario lineage

Shows capture -> quarantine -> sanitize -> map -> replay verification -> review -> promoted immutable scenario -> new corpus -> corrected installed-client gate run. Each node shows digest and identity; promotion never edits prior corpus membership. A replay-only PASS is visibly insufficient until the corrected installed client completes the promoted case through the normal path.

### 3.5 Safety & Settings

- Current bind address and port.
- Supported modes; committed live mode shown as UNSUPPORTED, not a disabled future upsell.
- Runtime split: networkless scenario proxy versus separately launched live-dry adapter.
- Provider credential state: `NOT_REQUIRED`, `OPTIONAL_ABSENT`, `PRESENT_IN_MEMORY`, or `EXPIRED`; never value or fingerprint that could expose it.
- Upstream origin and allowlisted routes.
- Retention and local storage estimates.
- Export privacy policy and recent local export manifests.
- Deletion dry-run with affected record categories and confirmation digest.
- Build/toolchain/protocol-profile/evaluator versions.
- Subject-build attestation, effect policy/manifest, call-site-inventory provenance, interceptor trust/process-tree scope, and declared-hooks-only limitations.
- Separate official-endpoint compatibility records (`NOT_RUN`, `UNKNOWN`, `INCOMPATIBLE`, `OFFICIAL_ENDPOINT_COMPATIBLE`) and the real dry-probe authorization/expiry state.

## 4. Status language

| Axis/value | Visual treatment | Required text behavior |
|---|---|---|
| PASS | check icon, restrained green | “All required cases passed for these exact revisions.” |
| FAIL | x icon, red | Name violated invariant and operation/case. |
| REVIEW | pause/inspection icon, amber | Name missing, contradictory, private, stale, or unsupported evidence. |
| NOT_RUN | hollow circle, neutral | “No complete evaluation exists.” |
| UNKNOWN evidence class | question icon, neutral/amber | Explain which required fact is absent; verdict remains separate. |
| PRIVATE_NOT_VISIBLE / NOT_VISIBLE evidence | eye-off icon, purple/neutral | State the authorization/privacy boundary and show REVIEW when required. |
| UNSUPPORTED | slash icon, neutral | State that the current profile cannot evaluate it. |
| STALE | clock icon, amber | Show observation time and freshness rule. |
| artifactReady | package/check icon, neutral | Show artifact readiness independently from verdict. |
| buildAttestation | identity/shield icon, neutral | Distinguish user-asserted local from trusted-launcher or CI-attested; never call a user assertion verified. |
| effectCoverage | boundary/inspection icon, neutral or amber | Distinguish independent boundary, trusted inventory plus boundary, and declared hooks only; self-report or inventory alone never appears complete. |
| enforcementMode | shield/check icon, neutral | State local advisory, CI check, or required-check-unverified; never say blocking. |
| compatibilityStatus | link/check icon, neutral | State official dry compatibility separately from the local gate and never imply settlement. |

Do not use celebratory animation for PASS or alarming flashing for FAIL.

## 5. Professional design system

The selected direction is a Swiss/minimal engineering console: dense enough for incident work, quiet enough for sustained use, and visibly evidence-led. It is not a marketing page placed around a table. The interface uses one grid, one icon language, one typography system, a restrained elevation scale, and one primary action per task context. Implementation must validate rendered contrast and behavior rather than copying proposed tokens blindly.

### 5.1 Typography

- UI and prose: IBM Plex Sans, locally bundled when licensing and package review permit, followed by a documented system sans fallback.
- Code, digests, amounts, timestamps, event codes, and aligned numeric data: JetBrains Mono, locally bundled when permitted, followed by a documented system monospace fallback.
- Body: 16 px, line height 1.5. Dense table cells: 14 px minimum. Labels: 13 px minimum and never used for essential prose.
- Heading scale: 28/34, 22/28, 18/24, and 16/22 CSS px. Page titles use sentence case, not oversized hero typography.
- Monetary and timing columns use tabular figures. Long digests wrap or truncate with a keyboard-accessible reveal/copy action; full values never depend on hover.
- Font loading reserves metrics and uses `font-display: swap` or an equivalent local strategy; no invisible text or layout-changing late font swap.

### 5.2 Semantic color tokens

Interactive accent and outcome colors are deliberately different: blue indicates an available action, while green is reserved for proven PASS/success state. Components consume semantic tokens rather than raw hex values.

```text
light.background          #F8FAFC
light.surface             #FFFFFF
light.surface-subtle      #F1F5F9
light.border              #CBD5E1
light.text-primary        #0F172A
light.text-secondary      #475569
light.action              #1D4ED8
light.action-on           #FFFFFF
light.focus               #1D4ED8

dark.background           #0B1220
dark.surface              #111827
dark.surface-raised       #182235
dark.border               #475569
dark.text-primary         #F8FAFC
dark.text-secondary       #CBD5E1
dark.action               #60A5FA
dark.action-on            #07111F
dark.focus                #93C5FD

status.pass.text          #166534
status.pass.surface       #DCFCE7
status.fail.text          #991B1B
status.fail.surface       #FEE2E2
status.review.text        #92400E
status.review.surface     #FEF3C7
status.private.text       #6D28D9
status.private.surface    #EDE9FE
status.neutral.text       #475569
status.neutral.surface    #F1F5F9
```

Every foreground/background/state combination must be checked in both themes at WCAG 2.2 AA. A badge always includes icon, text, and where relevant an explanatory reason. No color token alone changes business meaning.

### 5.3 Geometry, spacing, and elevation

- 4 px base grid; standard spacing 4, 8, 12, 16, 24, 32, and 48 px.
- Control height is 36–40 px on pointer-dense layouts and at least 44 px on touch layouts. Adjacent touch targets keep at least 8 px separation.
- Radius scale: 4 px for tags, 6 px for controls, 8 px for cards/dialogs. Do not use large pill cards or randomly mixed radii.
- Border is the primary grouping device. Shadows are limited to overlay levels: `none`, `popover`, and `modal`; ordinary data cards do not each float.
- Content width follows task: prose stays within 72 characters; evidence tables use the available viewport. Nested cards are replaced by labelled sections and dividers.
- Layer tokens are fixed for base, sticky navigation, popover, dialog, and critical toast; arbitrary z-index values are prohibited.

### 5.4 Motion and feedback

- Pointer/keyboard feedback begins within 100 ms. Local transitions use 120–180 ms with enter slower than exit.
- Only opacity and transform may animate in ordinary interactions; avoid width/height animation and layout thrashing.
- Timeline insertion may fade and move no more than 8 px. There is no ambient pulse, parallax, confetti, auto-rotating content, or decorative loading loop.
- `prefers-reduced-motion` produces the final stable state immediately. Streaming timelines include pause/resume without changing the recorded session.
- Operations longer than 1 second show stage-based progress or a layout-reserving skeleton; indeterminate spinners never imply economic progress.

### 5.5 Iconography and copy

- Use one reviewed SVG stroke-icon set with consistent size and stroke weight. No emoji, mixed icon packs, or decorative illustrations inside operational views.
- Decorative icons are hidden from assistive technology; icon-only controls have an accessible name, tooltip, visible focus, and state when applicable.
- Labels use domain language (`Run gate`, `Review evidence`, `Promote regression`) instead of vague `Continue`, `Magic`, or `Analyze` copy.
- Destructive and trust-changing actions use a visible text label in confirmation contexts and state the exact scope, identity, and recoverability.

### 5.6 Prohibited vibe-code patterns

- no purple/pink AI gradients, glassmorphism, glowing borders, fake terminal chrome, animated background grids, or decorative blockchain imagery;
- no fabricated KPI cards, placeholder charts, hard-coded PASS states, or random trend percentages;
- no every-section card layout, oversized rounded containers, excessive badges, or three competing primary buttons;
- no browser-computed verdict, optimistic economic state, or toast-only failure;
- no raw JSON as the default experience when a structured task view exists, while retaining a safe escaped raw-data inspector for experts;
- no component-local colors, spacing, shadows, or status wording outside the shared design tokens and content map.

## 6. Component and interaction contracts

### 6.1 Application shell

The shell owns project context, primary navigation, local-service connectivity, current mode, and global stale/disconnected state. A context switch asks for confirmation only when it would discard unsaved local form input; it never silently changes a running session. Breadcrumbs represent actual route hierarchy and browser Back restores the prior view/filter without losing persisted work.

### 6.2 Status axis group

`Execution state`, `Verdict`, `Evidence`, `Subject identity`, `Effect coverage`, `Artifact`, `Enforcement`, and `Official compatibility` are eight labelled rows in a single reusable component. It accepts typed API values only. Each row has an accessible definition and timestamp/freshness disclosure. At every viewport these rows remain separately named and visible; compact layouts may shorten secondary descriptions behind an operable details control but can never hide or merge the lifecycle, verdict, evidence, coverage, artifact, enforcement, or compatibility axes into one badge.

### 6.3 Data grids and timelines

Tables use semantic headers, row identity, sortable-column state, stable cursor pagination, and a visible result count. Virtualization must preserve focus and screen-reader position; if that cannot be proven, use pagination. Row actions are available from keyboard and pointer without hover. Timeline and graph views always have an equivalent ordered table; filtering announces the resulting count without moving focus.

### 6.4 Forms and mutations

Every mutation originates from a native form or semantic control, carries an idempotency key and expected revision where the API requires them, disables only the submitted action while pending, and renders the authoritative persisted result returned by the service. Validation on blur complements, but never replaces, submit validation. Failed submit moves focus to a linked error summary while preserving every valid input. Conflict responses show the changed identity and offer reload/compare; they never overwrite newer state.

### 6.5 Drawers, dialogs, and notifications

Evidence detail uses a route-addressable drawer on wide screens and a full-screen page/sheet on small screens. Dialogs are reserved for bounded decisions, have a heading and visible Cancel, trap focus, close with Escape when safe, and restore focus. Toasts acknowledge noncritical completion only; failures, REVIEW reasons, policy denial, and recovery instructions remain in the page.

### 6.6 Recovery contract

Every recoverable failure names the failed stage, last authoritative persisted state, exact build/gate/case/session/epoch, whether retry is read-only or mutating, the idempotency behavior, and the safe next action. `Retry mutation` is absent while an outcome is unknown. The only recovery action revokes the stale token, increments the epoch, and issues a reconciliation-only token; a second commit is never offered. A disconnected client freezes last-known content with a stale banner and never turns missing updates into FAIL or PASS.

## 7. Responsive behavior

Required verification widths: 375, 768, 1024, and 1440 CSS px.

### 375 px

- Single column.
- Bottom or compact menu with no more than five primary destinations.
- Identity strip becomes labelled key/value rows.
- Timeline remains vertical; evidence opens as full-screen sheet with predictable Back.
- Tables switch to cards only when column identity remains explicit; otherwise horizontal table scrolling is contained and labelled.

### 768 px

- Collapsible navigation.
- Session steps use vertical rail.
- Operation summary stacks above timeline.

### 1024 px and above

- Persistent navigation.
- Operation page uses summary rail, timeline, and invariant panel in a resizable but keyboard-operable layout.
- Maximum readable text width applies to prose; evidence tables use available width.

No page may create body-level horizontal scrolling. Browser zoom must remain enabled.

## 8. Accessibility

- All functionality is keyboard operable in logical order.
- Browser zoom to 200 percent retains every core action and status without two-dimensional page scrolling.
- Skip link targets main content.
- Focus is always visible and not hidden by sticky UI; use at least a 2 CSS px high-contrast indicator.
- Dialog focus is trapped, titled, and restored to the invoking control.
- Failed forms use a focusable error summary at the top plus inline `aria-describedby` errors.
- Dynamic status changes use appropriate polite/assertive live regions without repeatedly announcing streaming noise.
- Charts/timelines have visible table and concise text alternatives.
- Hover-only detail is prohibited.
- Pointer targets meet WCAG 2.2 AA sizing or a documented spacing exception; touch layouts use at least 44×44 CSS px targets.
- Every timestamp states timezone; relative time is accompanied by exact time.
- Copy actions announce success without moving focus.
- Destructive deletion confirmation states scope and recoverability.
- Automated checks are supplemented by keyboard and screen-reader manual tests.

## 9. Required UI states

Every data-bearing component shall define and test:

- loading;
- empty/unconfigured;
- success;
- fail;
- review/partial;
- unattested or artifact-identity mismatch;
- case queued, bounded-parallelism waiting, cancelled, aborted, crash-recovery required, and reconciliation-only;
- token expired/revoked/reused, concurrent-client conflict, and reset/teardown incomplete;
- effect-policy/manifest missing or mismatched; trusted inventory stale/forged/unsupported; interceptor unavailable, stale, wrong process tree, wrong sink, disconnected, missing teardown, or bypass detected; and `DECLARED_HOOKS_ONLY` diagnostic REVIEW;
- capture quarantined, secret-blocked, nondeterministic, unresolved, awaiting review, and promotion conflict;
- official compatibility unknown/incompatible while local result remains available;
- stale;
- disconnected/offline;
- retrying with bounded attempt information;
- permission denied;
- unsupported profile/schema;
- secret/privacy scan blocked;
- resource limit exceeded;
- not run.

Skeletons reserve layout and never imply values. A retry control explains whether the action is read-only; no UI control can bypass safe-mode policy.

## 10. UI acceptance checks

- A fresh user can register a subject build/effect policy/manifest, see separate build, inventory, and interceptor trust boundaries, configure a bounded GateRun, and start an isolated case without opening raw logs.
- A FAIL result can be traced from gate run -> case run -> logical job/run operation/phase -> attempt -> evidence/effect coverage -> invariant in at most four navigational actions.
- A REVIEW due to private evidence cannot be mistaken for PASS at any viewport; NOT_VISIBLE never appears as a verdict.
- Provider-reported status and evaluated outcome are both visible and never collapsed.
- Scenario evidence says “proven within scenario,” and provider facts never collapse into live-probe results.
- A PASS decision remains visible if artifact generation fails, while artifactReady becomes false; no circular gate is presented.
- Changing revision/corpus visibly invalidates the prior gate display for the new selection.
- Changing build/artifact, gate/case, adapter, effect policy/manifest/inventory/interceptor, or fencing identity visibly invalidates prior evidence for the new selection.
- A copied case token, concurrent client, changed/second commit, or stale-epoch request yields an authoritative conflict with no optimistic mutation.
- Crash recovery shows token revocation and the new read-only epoch; the UI exposes no second-mutation action.
- `DECLARED_HOOKS_ONLY`, missing/forged/stale inventory or interceptor, unsupported dynamic calls, incomplete process-tree/sink coverage, and unobserved required sinks remain REVIEW; subject reports and inventory alone are never shown as independent runtime proof.
- Keyboard-only users can create a gate run, inspect a failure, capture/quarantine/review/promote an installed trace into a new corpus, inspect the corrected-client rerun, and plan an export.
- `WORKING_LOCAL` can be shown with RP-07 not run; `OFFICIAL_ENDPOINT_COMPATIBLE` is shown only after the separate real dry probe and never changes the local verdict.
- Error summaries receive focus and link to invalid controls.
- Status tables remain understandable in monochrome.
- Light and dark themes pass automated contrast checks plus manual review for focus, disabled, selected, hover, pressed, and high-contrast states.
- At 200 percent zoom, core journeys remain operable without body-level horizontal scroll or obscured focus.
- 10,000-event sessions use pagination/virtualization and retain table fallback.
- Input feedback begins within 100 ms, ordinary user actions do not block interaction beyond 200 ms on documented reference hardware, and route changes keep cumulative layout shift below 0.1.
- Credential values never render in DOM, browser storage, accessible name, clipboard history controlled by the app, or screenshots produced by the product.

