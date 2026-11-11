/**
 * Seeded deterministic PRNG and proxy virtual clock (FR-06, NFR-01).
 *
 * The PRNG is sfc32 seeded from a domain-separated SHA-256 of the scenario seed. It uses only
 * 32-bit integer arithmetic (`>>>`, `|0`, `Math.imul`), so the sequence is identical on every
 * platform and JavaScript engine. `Math.random`, `Date.now`, and host timers are never used.
 *
 * The virtual clock is an integer millisecond counter that only the scenario advances. It is
 * bounded by the scenario's `maxVirtualDurationMs` budget.
 */
import { createHash } from 'node:crypto';
import { limitExceeded } from './budget.ts';

export class DeterministicPrng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  private draws = 0;

  constructor(seed: string, domain: string) {
    const h = createHash('sha256').update(`routespec.prng/1\u0000${domain}\u0000${seed}`, 'utf8').digest();
    this.a = h.readUInt32BE(0);
    this.b = h.readUInt32BE(4);
    this.c = h.readUInt32BE(8);
    this.d = h.readUInt32BE(12);
    for (let i = 0; i < 12; i++) this.nextUint32();
    this.draws = 0;
  }

  static fromState(state: PrngState): DeterministicPrng {
    const p = Object.create(DeterministicPrng.prototype) as DeterministicPrng;
    p.a = state.a;
    p.b = state.b;
    p.c = state.c;
    p.d = state.d;
    p.draws = state.draws;
    return p;
  }

  state(): PrngState {
    return { a: this.a, b: this.b, c: this.c, d: this.d, draws: this.draws };
  }

  nextUint32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    this.draws++;
    return t >>> 0;
  }

  /** Uniform integer in [0, bound) by rejection sampling (no modulo bias). */
  nextBelow(bound: number): number {
    if (!Number.isInteger(bound) || bound <= 0 || bound > 0x1_0000_0000) throw new RangeError('bad bound');
    const limit = Math.floor(0x1_0000_0000 / bound) * bound;
    for (;;) {
      const x = this.nextUint32();
      if (x < limit) return x % bound;
    }
  }

  hex(bytes: number): string {
    let out = '';
    while (out.length < bytes * 2) out += this.nextUint32().toString(16).padStart(8, '0');
    return out.slice(0, bytes * 2);
  }

  /** Fisher-Yates permutation driven by this PRNG. */
  permute<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.nextBelow(i + 1);
      const tmp = out[i] as T;
      out[i] = out[j] as T;
      out[j] = tmp;
    }
    return out;
  }

  get drawCount(): number {
    return this.draws;
  }
}

export interface PrngState {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly draws: number;
}

/** Integer virtual milliseconds; advanced only by scenario steps. */
export class VirtualClock {
  private t: number;
  private readonly start: number;
  private readonly maxDurationMs: number;

  constructor(startMs: number, maxDurationMs: number, current = startMs) {
    this.start = startMs;
    this.t = current;
    this.maxDurationMs = maxDurationMs;
  }

  nowMs(): number {
    return this.t;
  }

  elapsedMs(): number {
    return this.t - this.start;
  }

  advance(ms: number): number {
    if (!Number.isInteger(ms) || ms < 0)
      throw new RangeError('virtual advance must be a non-negative integer');
    const next = this.t + ms;
    if (next - this.start > this.maxDurationMs) {
      limitExceeded('maxVirtualDurationMs', next - this.start, this.maxDurationMs);
    }
    this.t = next;
    return this.t;
  }

  /** Fixed epoch for rendering virtual time in protocol timestamps. Never the host clock. */
  static readonly EPOCH_ISO_MS = Date.UTC(2026, 0, 1, 0, 0, 0, 0);

  isoAt(ms: number = this.t): string {
    return new Date(VirtualClock.EPOCH_ISO_MS + ms).toISOString();
  }
}
