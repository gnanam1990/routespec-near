/**
 * Which matrix row the Releases page Gate summary shows. Pure, so it is unit tested.
 *
 * The matrix API lists gate runs in creation order (oldest first). Without an explicit row
 * selection the summary shows the most recent gate run on the loaded page (the last row), and
 * the page labels which run that is.
 */
export type SummaryBasis = 'SELECTED' | 'MOST_RECENT' | 'MOST_RECENT_ON_PAGE';

export interface SummarySelection<R> {
  readonly row: R;
  readonly basis: SummaryBasis;
}

export function summarySelection<R>(
  rows: readonly R[],
  selectedKey: string | null,
  keyOf: (row: R) => string,
  morePages: boolean,
): SummarySelection<R> | null {
  if (selectedKey !== null) {
    const chosen = rows.find((r) => keyOf(r) === selectedKey);
    if (chosen !== undefined) return { row: chosen, basis: 'SELECTED' };
  }
  const latest = rows[rows.length - 1];
  if (latest === undefined) return null;
  return { row: latest, basis: morePages ? 'MOST_RECENT_ON_PAGE' : 'MOST_RECENT' };
}

export const SUMMARY_BASIS_TEXT: Readonly<Record<SummaryBasis, string>> = Object.freeze({
  SELECTED: 'Showing the gate run you selected in the matrix below.',
  MOST_RECENT: 'Showing the most recent gate run. Select a revision in the matrix below to see another.',
  MOST_RECENT_ON_PAGE:
    'Showing the most recent gate run on this page; more gate runs exist. Select a revision in the matrix below to see another.',
});
