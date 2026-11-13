/**
 * Test access to the documented-shape recording. It is authored by hand from the public
 * Intents Explorer OpenAPI document; every value in it is invented (see the file's `note`).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ExplorerRecording } from '../../src/index.ts';

export const FIXTURE_PATH = fileURLToPath(
  new URL('../../fixtures/explorer-documented-shape.json', import.meta.url),
);

export function fixtureDoc(): ExplorerRecording {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as ExplorerRecording;
}

/** Every free-form value of the raw records: strings that are not documented enum tokens, and large numbers. */
export function sensitiveStrings(records: ReadonlyArray<unknown>): string[] {
  const enumLike = /^(?:[A-Z][A-Z_]{2,40}|0)$/;
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      if (v.length >= 4 && !enumLike.test(v)) out.add(v);
    } else if (typeof v === 'number') {
      if (v > 100_000) out.add(String(v));
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === 'object') Object.values(v).forEach(walk);
  };
  records.forEach(walk);
  return [...out];
}

export const WINDOW = {
  startTimestamp: '2026-11-01T00:00:00.000Z',
  endTimestamp: '2026-11-14T00:00:00.000Z',
} as const;
