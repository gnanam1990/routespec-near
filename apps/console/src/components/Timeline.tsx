import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useConsole, useResource } from '../app/context.tsx';
import type { EventPage, TimelineEvent } from '../api/schemas.ts';
import { OPERATION_PHASES } from '@routespec/contracts/enums';
import {
  EVIDENCE_CLASS_CONTENT,
  EVIDENCE_REASON_TEXT,
  EVIDENCE_SCOPE_CONTENT,
} from '../content/status-content.ts';
import { Icon } from './Icon.tsx';
import { StatusBadge } from './Status.tsx';
import { formatUtc } from './Timestamp.tsx';
import { ResourceView } from './ui.tsx';

const PAGE_SIZES = [50, 100, 200] as const;
const POLL_MS = 2000;

const KIND_TEXT: Readonly<Record<TimelineEvent['kind'], string>> = {
  CLIENT_REQUEST: 'Client request',
  PROXY_RESPONSE: 'Proxy response',
  PROXY_DROP: 'Proxy response dropped',
  CONNECTION_BARRIER: 'Connection barrier',
  PHASE_BINDING: 'Phase binding',
  PROVIDER_OBSERVATION: 'Provider observation',
  REQUIRED_SINK: 'Required sink',
  SUBJECT_REPORT: 'Subject report',
  BOUNDARY_OBSERVATION: 'Independent boundary observation',
  TOKEN_LIFECYCLE: 'Token / epoch',
  GROUND_TRUTH: 'Scenario ground truth',
  EVIDENCE: 'Evidence',
  INVARIANT: 'Invariant evaluation',
  SAFETY_DENIAL: 'Safety denial',
};

const PHASE_TEXT: Readonly<Record<(typeof OPERATION_PHASES)[number], string>> = {
  QUOTE_REQUEST: 'Quote request',
  QUOTE_FINALIZATION: 'Quote finalization',
  COMMIT_MUTATION: 'Commit',
  READ_ONLY_RECONCILIATION: 'Read-only reconciliation',
};

function evidenceText(event: TimelineEvent): string {
  const parts: string[] = [];
  if (event.evidenceClass) parts.push(EVIDENCE_CLASS_CONTENT[event.evidenceClass].label);
  if (event.evidenceScope) parts.push(EVIDENCE_SCOPE_CONTENT[event.evidenceScope].label);
  for (const r of event.evidenceReasons) parts.push(EVIDENCE_REASON_TEXT[r]);
  return parts.length === 0 ? '—' : parts.join('; ');
}

/**
 * Sequence-paginated session timeline (UI-SPEC 3.3, 6.3; T-050, T-051). Pagination is used
 * instead of virtualization so focus and screen-reader position are always preserved. The
 * ordered table view is always available; live updates can be paused without changing the
 * recorded session.
 */
export function Timeline({
  sessionId,
  runOperationId,
}: {
  sessionId: string;
  runOperationId?: string | null;
}) {
  const { announce } = useConsole();
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZES)[number]>(100);
  const [phase, setPhase] = useState<string>('');
  const [view, setView] = useState<'timeline' | 'table'>('timeline');
  const [live, setLive] = useState(false);
  const cursor = cursors[cursors.length - 1] ?? null;
  const { state, reload } = useResource<EventPage>(
    (client, signal) =>
      client.listEvents(
        sessionId,
        { cursor, limit: pageSize, runOperationId: runOperationId ?? null, phase: phase || null },
        signal,
      ),
    [sessionId, runOperationId ?? null, cursor, pageSize, phase],
  );
  const tabsId = useId();
  const pageIndex = cursors.length - 1;
  const data = state.data;
  const firstShown = data && data.items.length > 0 ? pageIndex * pageSize + 1 : 0;
  const lastShown = data ? pageIndex * pageSize + data.items.length : 0;

  const lastAnnounced = useRef<string>('');
  useEffect(() => {
    if (state.status !== 'success') return;
    const message = `${state.data.total} events${phase ? ` in phase ${PHASE_TEXT[phase as (typeof OPERATION_PHASES)[number]]}` : ''}`;
    // Announce filter results, not every streaming refresh (UI-SPEC 8: no streaming noise).
    if (message !== lastAnnounced.current && !live) {
      lastAnnounced.current = message;
      announce(message);
    }
  }, [state, phase, live, announce]);

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(reload, POLL_MS);
    return () => window.clearInterval(timer);
  }, [live, reload]);

  const tableCaption = useMemo(
    () => `Session events ${firstShown}–${lastShown} of ${data?.total ?? 0}, ordered by sequence`,
    [firstShown, lastShown, data?.total],
  );

  return (
    <div className="timeline">
      <div className="toolbar" role="group" aria-label="Timeline controls">
        <div role="tablist" aria-label="Timeline view" className="segmented" id={tabsId}>
          {(['timeline', 'table'] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              id={`${tabsId}-${v}`}
              aria-selected={view === v}
              aria-controls={`${tabsId}-panel`}
              tabIndex={view === v ? 0 : -1}
              className="segmented-item"
              onClick={() => setView(v)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                  const next = v === 'timeline' ? 'table' : 'timeline';
                  setView(next);
                  document.getElementById(`${tabsId}-${next}`)?.focus();
                }
              }}
            >
              <Icon name={v === 'timeline' ? 'activity' : 'list'} /> {v === 'timeline' ? 'Timeline' : 'Table'}
            </button>
          ))}
        </div>
        <label className="inline-field">
          <span>Phase</span>
          <select
            value={phase}
            onChange={(event) => {
              setPhase(event.target.value);
              setCursors([null]);
            }}
          >
            <option value="">All phases</option>
            {OPERATION_PHASES.map((p) => (
              <option key={p} value={p}>
                {PHASE_TEXT[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="inline-field">
          <span>Page size</span>
          <select
            value={pageSize}
            onChange={(event) => {
              setPageSize(Number(event.target.value) as (typeof PAGE_SIZES)[number]);
              setCursors([null]);
            }}
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn" aria-pressed={live} onClick={() => setLive((v) => !v)}>
          <Icon name={live ? 'pause' : 'play'} /> {live ? 'Pause live updates' : 'Resume live updates'}
        </button>
      </div>
      <p className="small muted" data-testid="timeline-range">
        Showing {firstShown}–{lastShown} of {data?.total ?? 0} events. Live updates {live ? 'on' : 'paused'}.
      </p>
      <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${view}`}>
        <ResourceView state={state} label="session events" onRetry={reload} skeletonLines={8}>
          {(page) =>
            page.items.length === 0 ? (
              <p className="muted">No events match this filter.</p>
            ) : view === 'table' ? (
              <div
                className="table-scroll"
                role="region"
                aria-label="Events table (scrolls horizontally)"
                tabIndex={0}
              >
                <table className="table">
                  <caption className="visually-hidden">{tableCaption}</caption>
                  <thead>
                    <tr>
                      <th scope="col">Seq</th>
                      <th scope="col">Kind</th>
                      <th scope="col">Phase</th>
                      <th scope="col">Source</th>
                      <th scope="col">Evidence</th>
                      <th scope="col">Virtual ms</th>
                      <th scope="col">Wall time (UTC)</th>
                      <th scope="col">Timer</th>
                      <th scope="col">Summary</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((e) => (
                      <tr key={e.sequence}>
                        <td className="mono num">{e.sequence}</td>
                        <td>{KIND_TEXT[e.kind]}</td>
                        <td className="mono">{e.phase ?? '—'}</td>
                        <td>{e.source}</td>
                        <td>{evidenceText(e)}</td>
                        <td className="mono num">{e.virtualMs ?? '—'}</td>
                        <td className="mono">{formatUtc(e.wallTime)}</td>
                        <td>{e.timerCanonical ? 'Canonical' : 'Noncanonical — REVIEW'}</td>
                        <td>{e.summary}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <ol className="event-list" aria-label={tableCaption}>
                {page.items.map((e) => (
                  <li key={e.sequence} className="event">
                    <details>
                      <summary>
                        <span className="mono num">#{e.sequence}</span>
                        <span className="event-kind">{KIND_TEXT[e.kind]}</span>
                        <span className="event-summary">{e.summary}</span>
                        {!e.timerCanonical ? (
                          <StatusBadge
                            content={{
                              label: 'Noncanonical timer — REVIEW',
                              description: '',
                              icon: 'clock',
                              tone: 'review',
                            }}
                          />
                        ) : null}
                      </summary>
                      <dl className="kv compact">
                        <div className="kv-row">
                          <dt>Event code</dt>
                          <dd className="mono">{e.eventCode}</dd>
                        </div>
                        <div className="kv-row">
                          <dt>Phase</dt>
                          <dd className="mono">{e.phase ?? '—'}</dd>
                        </div>
                        <div className="kv-row">
                          <dt>Source</dt>
                          <dd>{e.source}</dd>
                        </div>
                        <div className="kv-row">
                          <dt>Evidence</dt>
                          <dd>{evidenceText(e)}</dd>
                        </div>
                        <div className="kv-row">
                          <dt>Virtual time</dt>
                          <dd className="mono">{e.virtualMs ?? '—'} ms</dd>
                        </div>
                        <div className="kv-row">
                          <dt>Wall time</dt>
                          <dd className="mono">{formatUtc(e.wallTime)}</dd>
                        </div>
                        <div className="kv-row">
                          <dt>Run operation</dt>
                          <dd className="mono">{e.runOperationId ?? '—'}</dd>
                        </div>
                      </dl>
                    </details>
                  </li>
                ))}
              </ol>
            )
          }
        </ResourceView>
      </div>
      <nav className="pager" aria-label="Timeline pages">
        <button
          type="button"
          className="btn"
          disabled={pageIndex === 0}
          onClick={() => setCursors((c) => c.slice(0, -1))}
        >
          Previous page
        </button>
        <span className="small">Page {pageIndex + 1}</span>
        <button
          type="button"
          className="btn"
          disabled={!data?.nextCursor}
          onClick={() => {
            const next = data?.nextCursor;
            if (next) setCursors((c) => [...c, next]);
          }}
        >
          Next page
        </button>
      </nav>
    </div>
  );
}
