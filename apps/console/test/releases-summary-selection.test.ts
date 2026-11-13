import { describe, expect, it } from 'vitest';
import { summarySelection } from '../src/pages/releases-selection.ts';

/**
 * Releases page Gate summary: which matrix row it shows. The matrix API lists gate runs in
 * creation order (oldest first), so the default must be the last row of the page, and the
 * summary must say which run it shows.
 */
const row = (gateRunId: string | null, revisionLabel = 'release-candidate-1') => ({
  revisionId: 'rev-1',
  buildRevisionId: `build-${gateRunId ?? 'none'}`,
  corpusRevisionId: 'corpus-1',
  gateRunId,
  revisionLabel,
});
const key = (r: ReturnType<typeof row>) =>
  `${r.revisionId}|${r.buildRevisionId}|${r.corpusRevisionId}|${r.gateRunId ?? 'none'}`;

describe('Releases Gate summary selection', () => {
  it('defaults to the most recent gate run (the last row in creation order), not the oldest', () => {
    const rows = [row('gr-1'), row('gr-2'), row('gr-3'), row('gr-4')];
    const s = summarySelection(rows, null, key, false);
    expect(s?.row.gateRunId).toBe('gr-4');
    expect(s?.basis).toBe('MOST_RECENT');
  });

  it('keeps an explicit row selection and labels it as selected', () => {
    const rows = [row('gr-1'), row('gr-2'), row('gr-3')];
    const s = summarySelection(rows, key(rows[0]!), key, false);
    expect(s?.row.gateRunId).toBe('gr-1');
    expect(s?.basis).toBe('SELECTED');
  });

  it('falls back to the most recent row when the selected key no longer exists', () => {
    const rows = [row('gr-1'), row('gr-2')];
    const s = summarySelection(rows, 'rev-1|gone|corpus-1|gr-9', key, false);
    expect(s?.row.gateRunId).toBe('gr-2');
    expect(s?.basis).toBe('MOST_RECENT');
  });

  it('says "on this page" when more rows exist beyond the loaded page', () => {
    const rows = [row('gr-1'), row('gr-2')];
    expect(summarySelection(rows, null, key, true)?.basis).toBe('MOST_RECENT_ON_PAGE');
  });

  it('has no summary for an empty matrix', () => {
    expect(summarySelection([], null, key, false)).toBeNull();
  });
});
