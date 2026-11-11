/**
 * Structured, redacted local logs and metrics (TDD.md section 19). No telemetry leaves the
 * machine: the sink is a local function (stderr or a local file chosen by the caller).
 *
 * Log lines carry a level, a code, shortened identifiers, fencing epoch, and coded details only.
 * Every string detail is checked against high-confidence secret shapes and configured secret
 * values before formatting; a hit is replaced with `[REDACTED]` and counted.
 */
const SECRET_SHAPES: readonly RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\bBearer\s+\S{8,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\brsct_[A-Za-z0-9_-]{20,}/,
  /\brsctl_[A-Za-z0-9_-]{20,}/,
];

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  readonly level: LogLevel;
  readonly code: string;
  readonly gateRun?: string | null;
  readonly caseRun?: string | null;
  readonly session?: string | null;
  readonly epoch?: number | null;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
}

export function shortId(id: string | null | undefined): string | null {
  return id === null || id === undefined ? null : id.slice(0, 8);
}

export class Metrics {
  readonly #counters = new Map<string, number>();
  readonly #gauges = new Map<string, number>();

  increment(name: string, by = 1): void {
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + by);
  }

  gaugeMax(name: string, value: number): void {
    this.#gauges.set(name, Math.max(this.#gauges.get(name) ?? 0, value));
  }

  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of [...this.#counters, ...this.#gauges].sort(([a], [b]) => (a < b ? -1 : 1)))
      out[k] = v;
    return out;
  }
}

export class Logger {
  readonly #sink: (line: string) => void;
  readonly #secrets: string[];
  readonly metrics: Metrics;
  readonly #minLevel: number;

  constructor(
    options: {
      sink?: (line: string) => void;
      configuredSecrets?: readonly string[];
      metrics?: Metrics;
      level?: LogLevel;
    } = {},
  ) {
    this.#sink = options.sink ?? (() => undefined);
    this.#secrets = (options.configuredSecrets ?? []).filter((s) => s.length >= 6);
    this.metrics = options.metrics ?? new Metrics();
    this.#minLevel = ['debug', 'info', 'warn', 'error'].indexOf(options.level ?? 'info');
  }

  private safe(value: string | number | boolean | null): string | number | boolean | null {
    if (typeof value !== 'string') return value;
    if (SECRET_SHAPES.some((p) => p.test(value)) || this.#secrets.some((s) => value.includes(s))) {
      this.metrics.increment('log_redaction_hits');
      return '[REDACTED]';
    }
    return value.length > 256 ? `${value.slice(0, 256)}...` : value;
  }

  log(entry: LogEntry): void {
    if (['debug', 'info', 'warn', 'error'].indexOf(entry.level) < this.#minLevel) return;
    const details: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of Object.entries(entry.details ?? {})) details[k] = this.safe(v);
    const line = {
      ts: new Date().toISOString(),
      level: entry.level,
      code: /^[A-Za-z0-9_.:-]{1,64}$/.test(entry.code) ? entry.code : 'INVALID_LOG_CODE',
      gateRun: shortId(entry.gateRun),
      caseRun: shortId(entry.caseRun),
      session: shortId(entry.session),
      epoch: entry.epoch ?? null,
      details,
    };
    this.#sink(JSON.stringify(line));
  }

  info(code: string, entry: Omit<LogEntry, 'level' | 'code'> = {}): void {
    this.log({ ...entry, level: 'info', code });
  }

  warn(code: string, entry: Omit<LogEntry, 'level' | 'code'> = {}): void {
    this.log({ ...entry, level: 'warn', code });
  }

  error(code: string, entry: Omit<LogEntry, 'level' | 'code'> = {}): void {
    this.log({ ...entry, level: 'error', code });
  }
}
