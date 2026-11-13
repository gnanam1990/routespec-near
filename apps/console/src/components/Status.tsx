import { useId, useState } from 'react';
import { Icon } from './Icon.tsx';
import { Timestamp } from './Timestamp.tsx';
import {
  AXIS_DEFINITIONS,
  LIFECYCLE_CONTENT,
  VERDICT_CONTENT,
  ENFORCEMENT_CONTENT,
  COMPATIBILITY_CONTENT,
  artifactContent,
  attestationContent,
  coverageContent,
  evidenceContent,
  type AxisName,
  type StatusContent,
} from '../content/status-content.ts';
import type { MatrixRow, StatusAxes } from '../api/schemas.ts';

type Counts = MatrixRow['counts'];

/** Icon + text badge. Meaning never depends on color; the tone only reinforces the text. */
export function StatusBadge({ content, code }: { content: StatusContent; code?: string }) {
  return (
    <span
      className={`badge tone-${content.tone}`}
      data-tone={content.tone}
      {...(code ? { 'data-code': code } : {})}
    >
      <Icon name={content.icon} />
      <span className="badge-label">{content.label}</span>
    </span>
  );
}

interface AxisRow {
  readonly axis: AxisName;
  readonly content: StatusContent;
  readonly code: string;
  readonly detail: string;
  readonly time?: { readonly label: string; readonly value: string | null } | undefined;
}

export function axisRows(axes: StatusAxes): AxisRow[] {
  const verdict = VERDICT_CONTENT[axes.verdict];
  return [
    {
      axis: 'Execution state',
      content: LIFECYCLE_CONTENT[axes.lifecycle],
      code: axes.lifecycle,
      detail: LIFECYCLE_CONTENT[axes.lifecycle].description,
    },
    {
      axis: 'Verdict',
      content: verdict,
      code: axes.verdict,
      // The reason is persisted server text naming the violated invariant / missing evidence.
      detail: axes.verdictReason ?? verdict.description,
      time: { label: 'Evaluated', value: axes.evaluatedAt },
    },
    {
      axis: 'Evidence',
      content: evidenceContent(axes.evidence),
      code: [axes.evidence.class, axes.evidence.scope ?? 'NO_SCOPE', ...axes.evidence.reasons].join(' '),
      detail: evidenceContent(axes.evidence).description,
      time: { label: 'Observed', value: axes.evidenceObservedAt },
    },
    {
      axis: 'Subject identity',
      content: attestationContent(axes.attestation),
      code: `${axes.attestation.class} ${axes.attestation.freshness}`,
      detail: attestationContent(axes.attestation).description,
      time: { label: 'Attested', value: axes.attestation.observedAt },
    },
    {
      axis: 'Effect coverage',
      content: coverageContent(axes.effectCoverage),
      code: `${axes.effectCoverage.basis ?? 'NO_BASIS'} ${axes.effectCoverage.finding}`,
      detail: coverageContent(axes.effectCoverage).description,
    },
    {
      axis: 'Artifact',
      content: artifactContent(axes.artifactReady),
      code: `artifactReady=${String(axes.artifactReady)}`,
      detail: artifactContent(axes.artifactReady).description,
    },
    {
      axis: 'Enforcement',
      content: ENFORCEMENT_CONTENT[axes.enforcementMode],
      code: axes.enforcementMode,
      detail: ENFORCEMENT_CONTENT[axes.enforcementMode].description,
    },
    {
      axis: 'Official compatibility',
      content: COMPATIBILITY_CONTENT[axes.officialCompatibility.status],
      code: axes.officialCompatibility.status,
      detail: COMPATIBILITY_CONTENT[axes.officialCompatibility.status].description,
      time: { label: 'Probed', value: axes.officialCompatibility.observedAt },
    },
  ];
}

/**
 * Eight separately named axes (UI-SPEC 6.2). Rows never merge at any width; compact layouts
 * only fold the secondary description behind an operable details control.
 */
export function StatusAxisGroup({ axes, title = 'Status' }: { axes: StatusAxes; title?: string }) {
  const headingId = useId();
  return (
    <section className="axis-group" aria-labelledby={headingId}>
      <h2 id={headingId} className="h3">
        {title}
      </h2>
      <dl className="axis-list">
        {axisRows(axes).map((row) => (
          <AxisItem key={row.axis} row={row} />
        ))}
      </dl>
    </section>
  );
}

function AxisItem({ row }: { row: AxisRow }) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  return (
    <div className="axis-row" data-axis={row.axis} data-tone={row.content.tone}>
      <dt className="axis-name">
        {row.axis}
        <span className="visually-hidden">: {AXIS_DEFINITIONS[row.axis]}</span>
      </dt>
      <dd className="axis-value">
        <StatusBadge content={row.content} code={row.code} />
        <button
          type="button"
          className="btn-icon axis-more"
          aria-expanded={open}
          aria-controls={detailId}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name="info" />
          <span className="visually-hidden">Details for {row.axis}</span>
        </button>
        <div id={detailId} className={`axis-detail${open ? ' is-open' : ''}`}>
          <span>{row.detail}</span>
          {row.time ? (
            <span className="axis-time">
              {row.time.label}: <Timestamp value={row.time.value} />
            </span>
          ) : null}
          <code className="axis-code">{row.code}</code>
        </div>
      </dd>
    </div>
  );
}

const TALLY_SEGMENTS = [
  { key: 'passed', tone: 'pass' },
  { key: 'failed', tone: 'fail' },
  { key: 'review', tone: 'review' },
  { key: 'unsupportedRequired', tone: 'private' },
  { key: 'notRun', tone: 'neutral' },
] as const;

/**
 * Proportional strip of persisted case counts. Purely a visual summary of the numbers listed
 * next to it (aria-hidden): every count is also written out as text, so nothing depends on
 * colour, and no percentage is invented. Drawn as SVG geometry so the strict CSP needs no
 * inline style.
 */
export function CaseTally({ counts }: { counts: Counts }) {
  const total = TALLY_SEGMENTS.reduce((sum, s) => sum + counts[s.key], 0);
  let x = 0;
  return (
    <svg
      className="tally"
      viewBox={`0 0 ${Math.max(total, 1)} 1`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect className="tally-track" x={0} y={0} width={Math.max(total, 1)} height={1} />
      <g className="tally-fill">
        {TALLY_SEGMENTS.map((s) => {
          const n = counts[s.key];
          const rect =
            n > 0 ? (
              <rect key={s.key} className={`tally-seg seg-${s.tone}`} x={x} y={0} width={n} height={1} />
            ) : null;
          x += n;
          return rect;
        })}
      </g>
    </svg>
  );
}
