# ADR-0035 — Console redesign: the inspection docket

- Status: accepted
- Date: 2026-11-13
- Module: M62 console redesign (UI-SPEC 4, 5, 6.2, 6.3, 7, 8, 9; builds on ADR-0026, changes no
  behaviour from ADR-0008/0014)

## Context

ADR-0026 made the console correct and consistent, but every screen still read as one long
column of identical rows: the eight status axes took a full viewport each, the counts were a
list of numbers, and nothing on screen said that RouteSpec is a chain of evidence from a release
down to an invariant. Judges see the console in a demo video and through the static demo link;
the decision and its reason need to be visible in the first screen, without changing the sealed
specification, the copy tests assert, or any route, role, label, or `data-*` hook.

The UI-SPEC constraints were treated as fixed: Swiss/minimal, IBM Plex Sans and JetBrains Mono
served same-origin, the semantic palette, radius 4/6/8, transform/opacity motion only, no KPI
cards, no gradients/glass/glow, no celebratory PASS, eight axes never merged.

Alternatives considered: a large verdict banner above the status group (rejected: it duplicates
the verdict badge and reads as celebration/alarm, UI-SPEC 4); a card dashboard with metric tiles
(rejected: UI-SPEC 5.6 forbids KPI cards and every-section cards).

## Decision

The console reads as an inspection docket:

1. **Instrument band.** The header is the same ink panel (`--chrome-*` tokens, the spec's dark
   values) in both themes. Controls inside it re-read the shared semantic tokens locally, so
   badges, selects and focus rings keep the one component system and the AA pairs already
   checked for the dark theme.
2. **Evidence-chain navigation.** Releases, Gate runs, Operations and Regressions carry their
   chain position (`01`–`04`, `aria-hidden`, the link name is unchanged) and are joined by a
   rail through the icon column; Safety & Settings sits apart. The phone bottom bar is unchanged.
3. **Axis ledger.** The eight axes stay eight `dt`/`dd` pairs in source order, laid out as a
   hairline grid by a container query: execution state and verdict on the first line with the
   persisted verdict reason at body size, then evidence, subject identity, effect coverage and
   artifact, then enforcement and official compatibility. Each cell has a 2 px tone rule that
   repeats its badge (`data-tone`, additive). Phones keep the compact name + badge + details
   control row. The case-run page uses the same ledger for its four case axes.
4. **Case tally.** Persisted counts get a proportional strip (SVG geometry, so the strict CSP
   needs no inline style), `aria-hidden` because every count stays written out beside it; it is
   hidden in forced-colours mode. It is drawn from API counts only; nothing is computed.
5. **Verdict edges and rails.** Table rows whose verdict badge is FAIL, REVIEW or PASS get a
   3 px left edge in that tone (CSS `:has`, so no markup change); the timeline, the four phase
   cards (numbered with CSS counters hidden from assistive technology) and the scenario lineage
   share one rail language.
6. **Motion.** Page headers and loaded sections settle 6 px over 160 ms and the tally fills over
   180 ms: transform only, no opacity, so text has full contrast from the first frame and axe
   never sees a faded state. Under `prefers-reduced-motion` the animations are removed.
7. **Touch targets.** On phones the 44 px control size is restated after the control rules (it was
   shadowed by the cascade) and digest reveal/copy controls get 44 px; the header wraps rather
   than exceeding a 320 px viewport.

No dependency was added; the existing native primitives and two CSS keyframes cover the design.

## Consequences

- Pinned tokens (`--radius-*`, `--focus-width`, `--space-2`, `--text-dense`) and badge geometry
  are unchanged; all colours stay in `tokens.css` (the source guardrail test enforces it).
- Markup changes are additive: `data-tone` on axis rows, `nav-chain`/`nav-aside` list classes and
  an `aria-hidden` step number, `summary-side`/`summary-block` wrappers, a `case-axes` class, and
  the `CaseTally` SVG. On the gate-run page Counts now precede Bounded parallelism.
- The Gate summary is full width; its supporting facts flow into as many columns as fit.
- Coherence with the verify page (ADR-0034): both surfaces now present a decision as a ledger of
  separately named checks in the UI-SPEC tokens and type pair; the console keeps its own
  stylesheet and shares no CSS file with `apps/verify`, so neither redesign changes the other.
