# ADR-0026 — Console visual system: Swiss/minimal engineering console

- Status: accepted
- Date: 2026-11-13
- Module: M45 console polish (UI-SPEC 4, 5, 6.2, 6.3, 7, 8; amends nothing in ADR-0008/0014)

## Context

The console already followed UI-SPEC 5 in its tokens, but the rendered result read as unfinished:
status badges in dense tables wrapped one character per line (`F/A/I/L`), the revision matrix
was several screens tall, page sections ran into each other because loaded resources lost the
page rhythm, a navigation toggle with no effect showed on desktop, the mobile header hid the
project name, and controls, notices, and tables each used slightly different weights and
spacing. A judge watching a demo video sees these defects before any of the evidence.

We checked the direction against a public UI/UX rules dataset (product, style, palette, and
font-pairing tables plus a pre-delivery checklist) rather than inventing one:

- Product row "Developer Tool / IDE" recommends Minimalism & Swiss Style with a dark mode and a
  blue focus colour. That matches UI-SPEC 5 ("Swiss/minimal engineering console").
- Font pairing "Developer Mono" is IBM Plex Sans with JetBrains Mono, which is what UI-SPEC 5.1
  asks for. Both are already bundled from `@fontsource` and served same-origin, so the strict
  CSP (`font-src 'self'`) needs no exception and no font CDN.
- Rules applied from the checklist: badges stay whole on one line and disclose overflow; colour
  is never the only signal; one icon family and one stroke weight; 4/8 px spacing tiers; tokens
  only; contrast checked in both themes; reduced motion gives the final state immediately.

## Decision

1. **Semantic tokens only.** `tokens.css` adds the missing roles instead of local colours:
   `--border-subtle` (row dividers), per-tone `--*-border` for badges and notices,
   `--selected-text`/`--selected-border`, `--surface-hover`, `--scrim`, a weight scale,
   `--space-5`, `--icon-sm/md`, `--control-height-sm`, `--layer-raised`, and `--nav-width`.
   Existing token values that tests pin (`--radius-*`, `--focus-width`, `--space-2`,
   `--text-dense`) are unchanged. The selected/active colour moves from indigo to blue so action
   and selection share one hue, while green stays reserved for PASS.
2. **Contrast.** Text pairs are AA in both themes (for example secondary text `#475569` on
   `#F8FAFC` is 7.2:1; selected text `#1E40AF` on `#EFF6FF` is 8.0:1; dark selected text
   `#DBEAFE` on `#172554` is above 12:1). Control borders use `#7C8AA0` (3.5:1 on white, 3.7:1
   on the dark surface) so form fields keep a 3:1 boundary. Axe runs in every e2e suite.
3. **Dense data.** Badges are 24 px tall, 13 px medium labels, tone-tinted borders. Inside tables
   badges, record names, and digests do not wrap; the labelled, keyboard-focusable scroll region
   absorbs the width, and the revision matrix keeps its row header sticky on horizontal scroll.
   Row headers put the identifier on its own line. Headers are sentence case (no text transform,
   so the accessible name equals the visible text).
4. **Rhythm.** A loaded resource is a flex column with the page gap (32 px desktop, 24 px below
   1024 px), so notices, the status group, and sections no longer touch. The "Refreshing" hint
   is absolutely positioned and reserves no layout. Page headers end with a rule; sections are
   separated by rules, not cards (UI-SPEC 5.3: no every-section card layout).
5. **Shell.** A small decorative product mark (inline SVG, `aria-hidden`) beside the name; the
   navigation toggle exists only where navigation collapses (768-1023 px); on phones the local
   badge and toggle are hidden and the project selector takes the full first row.
6. **Motion.** Only colour transitions on hover (120 ms) and a transform-only 8 px drawer entrance
   that is skipped under `prefers-reduced-motion`. No pulse, no gradient, no glass, no glow.

## Consequences

- The revision matrix scrolls horizontally at 1440 px instead of growing vertically; every
  column keeps its header and the region is labelled "scrolls horizontally".
- No behaviour, route, copy asserted by tests, role, label, or `data-*` hook changed. The only
  markup changes are the brand mark, a header divider, a `resource` class on the existing
  resource wrapper, and a `table-matrix` class on the revision matrix.
- `e2e-real/support/service.ts` accepts an optional `ROUTESPEC_REAL_PORT` so the real service can
  be started on a fixed loopback port for screenshots and demo recording; tests still use an
  ephemeral port.
