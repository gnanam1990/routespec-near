/**
 * Where swap records come from (M50).
 *
 * `TransactionSource` is the importer's only view of the outside: list a page, look one swap up
 * again, tell the time, wait. Two implementations exist: `ExplorerHttpSource` (client.ts), which
 * reads the service over HTTPS, and `RecordingSource` here, which answers from a recording file.
 *
 * A recording file is always a documented-shape fixture: hand-authored from the public API
 * document, not captured from the service. The importer never writes raw records to disk, so
 * there is no such thing as a recording of real data, and a corpus built from a file can never
 * be labelled as observed on mainnet.
 */
import { readFileSync, statSync } from 'node:fs';
import { RouteSpecError, z } from '@routespec/contracts';
import {
  EXPLORER_API_SPEC,
  EXPLORER_STATUSES,
  isIsoInstant,
  type TransactionsQuery,
} from './explorer-shape.ts';

export type SourceKind = 'INTENTS_EXPLORER_API' | 'DOCUMENTED_SHAPE_FIXTURE';

export interface TransactionSource {
  readonly kind: SourceKind;
  nowMs(): number;
  /** Wait before a second look. A recording moves to its next observation instead. */
  wait(ms: number): Promise<void>;
  /** One page of raw, unvalidated records. */
  listPage(query: TransactionsQuery): Promise<unknown[]>;
  /** Raw records for one deposit address (and memo), any status. */
  lookup(depositAddress: string, depositMemo: string | null): Promise<unknown[]>;
  /** Requests answered 429 and retried so far (0 for a recording). */
  rateLimitedCount(): number;
}

export const ExplorerRecording = z
  .object({
    recordingKind: z.literal('DOCUMENTED_SHAPE_FIXTURE'),
    note: z.string().max(1024),
    apiSpecDigest: z.literal(EXPLORER_API_SPEC.sha256),
    observations: z
      .array(
        z
          .object({
            observedAt: z.string().refine(isIsoInstant, 'expected an ISO 8601 UTC instant'),
            transactions: z.array(z.unknown()).max(100_000),
          })
          .strict(),
      )
      .min(1)
      .max(2),
  })
  .strict();
export type ExplorerRecording = z.infer<typeof ExplorerRecording>;

const MAX_RECORDING_BYTES = 32 * 1024 * 1024;

function field(record: unknown, key: string): unknown {
  return record !== null && typeof record === 'object' && !Array.isArray(record)
    ? (record as Record<string, unknown>)[key]
    : undefined;
}

export class RecordingSource implements TransactionSource {
  readonly kind = 'DOCUMENTED_SHAPE_FIXTURE' as const;
  private readonly recording: ExplorerRecording;
  private observation = 0;

  constructor(recording: unknown) {
    const parsed = ExplorerRecording.safeParse(recording);
    if (!parsed.success) {
      throw new RouteSpecError(
        'RS_SCHEMA_INVALID',
        'Recording is not a documented-shape fixture recording.',
        {
          details: { issues: parsed.error.issues.length },
        },
      );
    }
    this.recording = parsed.data;
  }

  static fromFile(path: string): RecordingSource {
    let text: string;
    try {
      if (statSync(path).size > MAX_RECORDING_BYTES) {
        throw new RouteSpecError('RS_CLI_USAGE', 'Recording file exceeds the size limit.');
      }
      text = readFileSync(path, 'utf8');
    } catch (error) {
      if (error instanceof RouteSpecError) throw error;
      throw new RouteSpecError('RS_CLI_USAGE', 'Recording file not found or not readable.');
    }
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new RouteSpecError('RS_SCHEMA_INVALID', 'Recording file is not valid JSON.');
    }
    return new RecordingSource(doc);
  }

  private current(): ExplorerRecording['observations'][number] {
    return this.recording.observations[this.observation] as ExplorerRecording['observations'][number];
  }

  nowMs(): number {
    return Date.parse(this.current().observedAt);
  }

  async wait(): Promise<void> {
    if (this.observation < this.recording.observations.length - 1) this.observation++;
  }

  rateLimitedCount(): number {
    return 0;
  }

  /** The documented filters and cursor, applied to the recorded list in its recorded order. */
  async listPage(query: TransactionsQuery): Promise<unknown[]> {
    const start = query.startTimestamp === null ? null : Date.parse(query.startTimestamp) / 1000;
    const end = query.endTimestamp === null ? null : Date.parse(query.endTimestamp) / 1000;
    let rows = this.current().transactions.filter((t) => {
      const status = field(t, 'status');
      // A record with a documented status outside the query is not returned, as by the service.
      // Anything the recording cannot interpret is passed on, so the importer has to reject it.
      if ((EXPLORER_STATUSES as readonly unknown[]).includes(status)) {
        if (!(query.statuses as readonly unknown[]).includes(status)) return false;
      }
      const created = field(t, 'createdAtTimestamp');
      if (typeof created === 'number') {
        if (start !== null && !(created > start)) return false;
        if (end !== null && !(created < end)) return false;
      }
      return true;
    });
    if (query.cursor !== null) {
      const cursor = query.cursor;
      const at = rows.findIndex(
        (t) =>
          field(t, 'depositAddress') === cursor.depositAddress &&
          (field(t, 'depositMemo') ?? null) === cursor.depositMemo,
      );
      rows = at === -1 ? [] : rows.slice(at + 1);
    }
    return rows.slice(0, query.numberOfTransactions);
  }

  async lookup(depositAddress: string, depositMemo: string | null): Promise<unknown[]> {
    return this.current().transactions.filter(
      (t) =>
        field(t, 'depositAddress') === depositAddress && (field(t, 'depositMemo') ?? null) === depositMemo,
    );
  }
}
