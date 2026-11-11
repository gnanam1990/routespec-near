/**
 * Deterministic scenario runtime: proxy virtual clock, seeded schedule, response drops,
 * connection barriers, transport errors, provider status queue, and ground-truth events
 * (FR-06, NFR-01, TDD.md sections 6 and 8).
 *
 * Determinism contract: the ordered event log, every virtual timestamp, and every generated
 * protocol value are a pure function of (compiled plan, seed, ordered client request sequence,
 * ordered journal denials). Transport request IDs, session IDs, wall time, and host data never
 * enter the runtime. The runtime performs no I/O: no network, no file, no timer, no randomness
 * other than its seeded PRNG.
 *
 * Two-phase use by the proxy: `plan(request)` computes a decision against a copy of the state
 * without changing it; after the journal accepted the request the proxy calls `commit(plan)`,
 * or `deny(request, code)` if the journal refused it. A refused request therefore never consumes
 * a scenario step.
 */
import {
  RouteSpecError,
  digestValue,
  type Digest,
  type ErrorCode,
  type QuoteRequestMaterial,
} from '@routespec/contracts';
import type { CompiledGroundTruthEvent, CompiledMatch, CompiledPlan, CompiledStep } from './compile.ts';
import { DeterministicPrng, VirtualClock, type PrngState } from './determinism.ts';
import { REQUEST_STEP_TYPES, type ScenarioRoute } from './schema.ts';

export const RUNTIME_REVISION = 'routespec-scenario-runtime@1.0.0' as const;

export type RuntimeEventKind =
  | 'REQUEST_MATCHED'
  | 'RESPONSE_PLANNED'
  | 'RESPONSE_DROP_PLANNED'
  | 'BARRIER_HELD'
  | 'BARRIER_RELEASED'
  | 'BARRIER_ABANDONED'
  | 'TRANSPORT_ERROR_PLANNED'
  | 'VIRTUAL_DELAY'
  | 'PROVIDER_STATUS_QUEUED'
  | 'PROVIDER_STATUS_SERVED'
  | 'PROVIDER_STATUS_TRANSITION'
  | 'GROUND_TRUTH'
  | 'GROUND_TRUTH_DUPLICATE'
  | 'DUPLICATE_SKIPPED'
  | 'REORDER_APPLIED'
  | 'LATE_SUCCESS_SCHEDULED'
  | 'ASSERTION_PASSED'
  | 'ASSERTION_FAILED'
  | 'UNEXPECTED_REQUEST'
  | 'REQUEST_DENIED'
  | 'CLIENT_TIMER_NONCANONICAL'
  | 'UNCONSUMED_REQUEST_STEP'
  | 'SCENARIO_ENDED'
  | 'SCENARIO_FINISHED'
  | 'LIMIT_EXCEEDED';

export interface RuntimeEvent {
  readonly seq: number;
  readonly virtualMs: number;
  readonly kind: RuntimeEventKind;
  readonly stepId: string | null;
  readonly route: ScenarioRoute | null;
  readonly materialDigest: Digest | null;
  readonly rawStatus: string | null;
  readonly groundTruthEventId: string | null;
  readonly detail: string | null;
}

export interface ScenarioRequest {
  readonly route: ScenarioRoute;
  /** Validated profile material (quote request, commit body, or status query). */
  readonly material: unknown;
  /** Subject-supplied logical job key (quote route only); scopes generated quote identity. */
  readonly logicalJobKey?: string;
}

export type DecisionKind =
  | 'RESPOND'
  | 'DROP_AFTER_ACCEPT'
  | 'HOLD_BARRIER'
  | 'RESET_BEFORE_ACCEPT'
  | 'REJECT_UNEXPECTED';

export interface Decision {
  readonly kind: DecisionKind;
  readonly stepId: string | null;
  readonly virtualMs: number;
  /** Barrier step IDs released by this request's arrival; their held responses may now be written. */
  readonly releasedBarriers: readonly string[];
  /** Quote route: the complete deterministic quote response to finalize and (maybe) deliver. */
  readonly quoteResponse: QuoteResponseBody | null;
  /** Status route: the raw provider status to report. */
  readonly rawStatus: string | null;
  readonly rejectCode: ErrorCode | null;
}

export interface RuntimePlan {
  readonly request: ScenarioRequest;
  readonly decision: Decision;
  readonly next: RuntimeState;
}

export interface QuoteResponseBody {
  readonly correlationId: string;
  readonly timestamp: string;
  readonly signature: string;
  readonly quoteRequest: QuoteRequestMaterial;
  readonly quote: Record<string, unknown>;
}

interface QueuedStatus {
  readonly status: string;
  readonly notBeforeMs: number;
}

interface RuntimeState {
  readonly cursor: number;
  readonly nowMs: number;
  readonly prng: PrngState;
  readonly providerCurrent: string;
  readonly statusQueue: readonly QueuedStatus[];
  readonly lastGroundTruth: string | null;
  readonly lastStatus: string;
  readonly ended: boolean;
  readonly requests: number;
  readonly barriers: ReadonlyArray<{ readonly stepId: string; readonly releaseOn: ScenarioRoute | null }>;
  readonly events: readonly RuntimeEvent[];
  readonly seenMaterial: readonly string[];
  readonly quotes: ReadonlyArray<{ readonly key: string; readonly response: QuoteResponseBody }>;
  readonly canonicalTimer: boolean;
  readonly limitBreached: boolean;
}

export interface GroundTruthEmission {
  readonly seq: number;
  readonly virtualMs: number;
  readonly duplicate: boolean;
  readonly event: CompiledGroundTruthEvent;
}

export interface RuntimeSummary {
  readonly runtimeRevision: typeof RUNTIME_REVISION;
  readonly scenarioId: string;
  readonly events: readonly RuntimeEvent[];
  readonly eventLogDigest: Digest;
  readonly groundTruth: readonly GroundTruthEmission[];
  readonly providerStatusesServed: readonly string[];
  readonly canonicalTimer: boolean;
  readonly finalVirtualMs: number;
  readonly assertionsFailed: number;
  readonly unexpectedRequests: number;
  readonly limitBreached: boolean;
}

function materialDigest(route: ScenarioRoute, material: unknown): Digest {
  return digestValue('routespec.scenario.request/1', { route, material: material ?? null });
}

function matches(match: CompiledMatch, req: ScenarioRequest): boolean {
  if (match.route !== req.route) return false;
  const m = (req.material ?? {}) as Record<string, unknown>;
  for (const [key, expected] of Object.entries(match.fields)) {
    if (m[key] !== expected) return false;
  }
  return true;
}

/** Mutable working copy used inside one transition; never escapes. */
class Working {
  cursor: number;
  readonly clock: VirtualClock;
  readonly prng: DeterministicPrng;
  providerCurrent: string;
  statusQueue: QueuedStatus[];
  lastGroundTruth: string | null;
  lastStatus: string;
  ended: boolean;
  requests: number;
  barriers: Array<{ stepId: string; releaseOn: ScenarioRoute | null }>;
  events: RuntimeEvent[];
  seenMaterial: string[];
  quotes: Array<{ key: string; response: QuoteResponseBody }>;
  canonicalTimer: boolean;
  limitBreached: boolean;
  private readonly plan: CompiledPlan;

  constructor(plan: CompiledPlan, s: RuntimeState) {
    this.plan = plan;
    this.cursor = s.cursor;
    this.clock = new VirtualClock(
      plan.initialState.virtualStartMs,
      plan.resourceBudget.maxVirtualDurationMs,
      s.nowMs,
    );
    this.prng = DeterministicPrng.fromState(s.prng);
    this.providerCurrent = s.providerCurrent;
    this.statusQueue = [...s.statusQueue];
    this.lastGroundTruth = s.lastGroundTruth;
    this.lastStatus = s.lastStatus;
    this.ended = s.ended;
    this.requests = s.requests;
    this.barriers = s.barriers.map((b) => ({ ...b }));
    this.events = [...s.events];
    this.seenMaterial = [...s.seenMaterial];
    this.quotes = [...s.quotes];
    this.canonicalTimer = s.canonicalTimer;
    this.limitBreached = s.limitBreached;
  }

  freeze(): RuntimeState {
    return Object.freeze({
      cursor: this.cursor,
      nowMs: this.clock.nowMs(),
      prng: this.prng.state(),
      providerCurrent: this.providerCurrent,
      statusQueue: Object.freeze([...this.statusQueue]),
      lastGroundTruth: this.lastGroundTruth,
      lastStatus: this.lastStatus,
      ended: this.ended,
      requests: this.requests,
      barriers: Object.freeze(this.barriers.map((b) => Object.freeze({ ...b }))),
      events: Object.freeze([...this.events]),
      seenMaterial: Object.freeze([...this.seenMaterial]),
      quotes: Object.freeze([...this.quotes]),
      canonicalTimer: this.canonicalTimer,
      limitBreached: this.limitBreached,
    });
  }

  emit(kind: RuntimeEventKind, fields: Partial<Omit<RuntimeEvent, 'seq' | 'virtualMs' | 'kind'>> = {}): void {
    if (this.events.length >= this.plan.resourceBudget.maxEvents) {
      this.limitBreached = true;
      throw new RouteSpecError('RS_SCENARIO_LIMIT_EXCEEDED', 'Scenario event budget exhausted.', {
        details: { limit: 'maxEvents', cap: this.plan.resourceBudget.maxEvents },
      });
    }
    this.events.push(
      Object.freeze({
        seq: this.events.length,
        virtualMs: this.clock.nowMs(),
        kind,
        stepId: fields.stepId ?? null,
        route: fields.route ?? null,
        materialDigest: fields.materialDigest ?? null,
        rawStatus: fields.rawStatus ?? null,
        groundTruthEventId: fields.groundTruthEventId ?? null,
        detail: fields.detail ?? null,
      }),
    );
  }

  step(): CompiledStep | undefined {
    return this.plan.steps[this.cursor];
  }

  queue(
    status: string,
    stepId: string,
    notBeforeMs = this.clock.nowMs(),
    detail: string | null = null,
  ): void {
    this.statusQueue.push({ status, notBeforeMs });
    this.lastStatus = status;
    this.emit('PROVIDER_STATUS_QUEUED', { stepId, rawStatus: status, detail });
  }

  serveStatus(stepId: string | null, detail: string | null): string {
    const idx = this.statusQueue.findIndex((q) => q.notBeforeMs <= this.clock.nowMs());
    if (idx !== -1) {
      const [entry] = this.statusQueue.splice(idx, 1);
      this.providerCurrent = (entry as QueuedStatus).status;
    }
    this.emit('PROVIDER_STATUS_SERVED', { stepId, rawStatus: this.providerCurrent, route: 'STATUS', detail });
    return this.providerCurrent;
  }

  groundTruth(eventId: string, stepId: string, duplicate: boolean): void {
    this.lastGroundTruth = eventId;
    this.emit(duplicate ? 'GROUND_TRUTH_DUPLICATE' : 'GROUND_TRUTH', { stepId, groundTruthEventId: eventId });
  }

  /** Execute timeline steps at the cursor until the next request step (or the end). */
  runTimeline(req: ScenarioRequest | null): void {
    for (;;) {
      const st = this.step();
      if (!st || this.ended) {
        if (!st && !this.ended) {
          this.ended = true;
          this.emit('SCENARIO_ENDED', { detail: 'steps-exhausted' });
        }
        return;
      }
      if (REQUEST_STEP_TYPES.includes(st.type)) return;
      this.cursor++;
      switch (st.type) {
        case 'delay_virtual':
          this.clock.advance(st.ms);
          this.emit('VIRTUAL_DELAY', { stepId: st.id, detail: String(st.ms) });
          break;
        case 'provider_status':
          this.queue(st.status, st.id);
          break;
        case 'ground_truth':
          this.groundTruth(st.event, st.id, false);
          break;
        case 'assert_request':
          if (req && matches(st.match, req))
            this.emit('ASSERTION_PASSED', { stepId: st.id, route: req.route });
          else
            this.emit('ASSERTION_FAILED', {
              stepId: st.id,
              route: req?.route ?? null,
              detail: req ? 'mismatch' : 'no-request',
            });
          break;
        case 'duplicate':
          if (st.of === 'LAST_GROUND_TRUTH') {
            if (this.lastGroundTruth === null)
              this.emit('DUPLICATE_SKIPPED', { stepId: st.id, detail: 'no-ground-truth' });
            else this.groundTruth(this.lastGroundTruth, st.id, true);
          } else {
            this.queue(this.lastStatus, st.id, this.clock.nowMs(), 'duplicate');
          }
          break;
        case 'reorder': {
          const order = this.prng.permute(st.statuses);
          this.emit('REORDER_APPLIED', { stepId: st.id, detail: order.join(',') });
          for (const status of order) this.queue(status, st.id, this.clock.nowMs(), 'reordered');
          break;
        }
        case 'late_success':
          this.emit('LATE_SUCCESS_SCHEDULED', {
            stepId: st.id,
            detail: String(this.clock.nowMs() + st.afterMs),
          });
          this.queue('SUCCESS', st.id, this.clock.nowMs() + st.afterMs, 'late');
          break;
        case 'incomplete_deposit':
          this.queue('INCOMPLETE_DEPOSIT', st.id);
          this.groundTruth(st.event, st.id, false);
          break;
        case 'refund':
          this.queue('REFUNDED', st.id);
          this.groundTruth(st.event, st.id, false);
          break;
        case 'end':
          this.ended = true;
          this.emit('SCENARIO_ENDED', { stepId: st.id });
          return;
        default:
          throw new RouteSpecError('RS_INTERNAL', 'Unhandled timeline step.');
      }
    }
  }
}

export class ScenarioRuntime {
  readonly plan: CompiledPlan;
  private state: RuntimeState;

  constructor(plan: CompiledPlan) {
    this.plan = plan;
    this.state = Object.freeze({
      cursor: 0,
      nowMs: plan.initialState.virtualStartMs,
      prng: new DeterministicPrng(plan.seed, `scenario:${plan.scenarioId}`).state(),
      providerCurrent: plan.initialState.providerStatus,
      statusQueue: Object.freeze([]),
      lastGroundTruth: null,
      lastStatus: plan.initialState.providerStatus,
      ended: false,
      requests: 0,
      barriers: Object.freeze([]),
      events: Object.freeze([]),
      seenMaterial: Object.freeze([]),
      quotes: Object.freeze([]),
      canonicalTimer: true,
      limitBreached: false,
    });
  }

  nowMs(): number {
    return this.state.nowMs;
  }

  events(): readonly RuntimeEvent[] {
    return this.state.events;
  }

  /** Compute the decision for one request without changing runtime state. */
  planRequest(request: ScenarioRequest): RuntimePlan {
    const w = new Working(this.plan, this.state);
    const digest = materialDigest(request.route, request.material);
    const decide = (
      kind: DecisionKind,
      extra: Partial<Omit<Decision, 'kind' | 'virtualMs' | 'releasedBarriers'>> = {},
    ): Decision => ({
      kind,
      stepId: extra.stepId ?? null,
      virtualMs: w.clock.nowMs(),
      releasedBarriers,
      quoteResponse: extra.quoteResponse ?? null,
      rawStatus: extra.rawStatus ?? null,
      rejectCode: extra.rejectCode ?? null,
    });
    const releasedBarriers: string[] = [];
    try {
      if (w.requests >= this.plan.resourceBudget.maxRequests) {
        w.limitBreached = true;
        w.emit('LIMIT_EXCEEDED', { route: request.route, detail: 'maxRequests' });
        return {
          request,
          decision: decide('REJECT_UNEXPECTED', { rejectCode: 'RS_SCENARIO_LIMIT_EXCEEDED' }),
          next: w.freeze(),
        };
      }
      w.requests++;
      const seen = w.seenMaterial.includes(digest);
      if (seen && request.route !== 'STATUS' && this.plan.initialState.clientClock === 'EXTERNAL_WALL') {
        // A repeated mutation-shaped request is a client retry. Its timing is canonical only
        // when the client runs on an injected clock/transport.
        w.canonicalTimer = false;
        w.emit('CLIENT_TIMER_NONCANONICAL', {
          route: request.route,
          materialDigest: digest,
          detail: 'retry-under-wall-timer',
        });
      }
      if (!seen) w.seenMaterial.push(digest);
      const remaining: Array<{ stepId: string; releaseOn: ScenarioRoute | null }> = [];
      for (const b of w.barriers) {
        if (b.releaseOn === null || b.releaseOn === request.route) {
          releasedBarriers.push(b.stepId);
          w.emit('BARRIER_RELEASED', { stepId: b.stepId, route: request.route });
        } else remaining.push(b);
      }
      w.barriers = remaining;
      w.runTimeline(request);
      const st = w.step();
      if (w.ended || !st) {
        if (request.route === 'STATUS') {
          if (this.plan.initialState.statusPollIntervalMs > 0)
            w.clock.advance(this.plan.initialState.statusPollIntervalMs);
          const rawStatus = w.serveStatus(null, 'after-end');
          return { request, decision: decide('RESPOND', { rawStatus }), next: w.freeze() };
        }
        w.emit('UNEXPECTED_REQUEST', {
          route: request.route,
          materialDigest: digest,
          detail: 'scenario-ended',
        });
        return {
          request,
          decision: decide('REJECT_UNEXPECTED', { rejectCode: 'RS_SCENARIO_ENDED' }),
          next: w.freeze(),
        };
      }
      if ('match' in st && matches(st.match, request)) {
        w.cursor++;
        w.emit('REQUEST_MATCHED', { stepId: st.id, route: request.route, materialDigest: digest });
        const quoteResponse = request.route === 'QUOTE' ? this.quoteFor(w, request) : null;
        if (request.route === 'COMMIT' && w.providerCurrent === 'PENDING_DEPOSIT') {
          w.providerCurrent = 'KNOWN_DEPOSIT_TX';
          w.lastStatus = 'KNOWN_DEPOSIT_TX';
          w.emit('PROVIDER_STATUS_TRANSITION', {
            stepId: st.id,
            rawStatus: 'KNOWN_DEPOSIT_TX',
            detail: 'commit-accepted',
          });
        }
        switch (st.type) {
          case 'respond': {
            if (st.delayMs > 0) {
              w.clock.advance(st.delayMs);
              w.emit('VIRTUAL_DELAY', { stepId: st.id, detail: String(st.delayMs) });
            }
            let rawStatus: string | null = null;
            if (request.route === 'STATUS') {
              if (st.status !== null) w.queue(st.status, st.id);
              rawStatus = w.serveStatus(st.id, 'scripted');
            } else if (request.route === 'COMMIT') {
              rawStatus = w.providerCurrent;
            }
            w.emit('RESPONSE_PLANNED', { stepId: st.id, route: request.route, rawStatus });
            return {
              request,
              decision: decide('RESPOND', { stepId: st.id, quoteResponse, rawStatus }),
              next: w.freeze(),
            };
          }
          case 'drop_response':
            w.emit('RESPONSE_DROP_PLANNED', { stepId: st.id, route: request.route });
            return {
              request,
              decision: decide('DROP_AFTER_ACCEPT', {
                stepId: st.id,
                quoteResponse,
                rawStatus:
                  request.route === 'STATUS'
                    ? w.serveStatus(st.id, 'dropped')
                    : request.route === 'COMMIT'
                      ? w.providerCurrent
                      : null,
              }),
              next: w.freeze(),
            };
          case 'connection_barrier':
            w.barriers.push({ stepId: st.id, releaseOn: st.releaseOn });
            w.emit('BARRIER_HELD', { stepId: st.id, route: request.route, detail: st.releaseOn ?? 'ANY' });
            return {
              request,
              decision: decide('HOLD_BARRIER', {
                stepId: st.id,
                quoteResponse,
                rawStatus:
                  request.route === 'STATUS'
                    ? w.serveStatus(st.id, 'held')
                    : request.route === 'COMMIT'
                      ? w.providerCurrent
                      : null,
              }),
              next: w.freeze(),
            };
          case 'transport_error':
            w.emit('TRANSPORT_ERROR_PLANNED', { stepId: st.id, route: request.route, detail: st.error });
            return { request, decision: decide('RESET_BEFORE_ACCEPT', { stepId: st.id }), next: w.freeze() };
          default:
            throw new RouteSpecError('RS_INTERNAL', 'Unhandled request step.');
        }
      }
      if (request.route === 'STATUS') {
        if (this.plan.initialState.statusPollIntervalMs > 0)
          w.clock.advance(this.plan.initialState.statusPollIntervalMs);
        const rawStatus = w.serveStatus(null, 'unscripted-poll');
        return { request, decision: decide('RESPOND', { rawStatus }), next: w.freeze() };
      }
      w.emit('UNEXPECTED_REQUEST', {
        stepId: st.id,
        route: request.route,
        materialDigest: digest,
        detail: 'no-matching-step',
      });
      return {
        request,
        decision: decide('REJECT_UNEXPECTED', { rejectCode: 'RS_SCENARIO_UNEXPECTED_REQUEST' }),
        next: w.freeze(),
      };
    } catch (error) {
      if (error instanceof RouteSpecError && error.code === 'RS_SCENARIO_LIMIT_EXCEEDED') {
        // The breach itself is recorded deterministically on a fresh copy of the prior state.
        const v = new Working(this.plan, this.state);
        v.limitBreached = true;
        if (v.events.length < this.plan.resourceBudget.maxEvents) {
          v.emit('LIMIT_EXCEEDED', {
            route: request.route,
            detail: String(error.details['limit'] ?? 'limit'),
          });
        }
        return {
          request,
          decision: {
            kind: 'REJECT_UNEXPECTED',
            stepId: null,
            virtualMs: v.clock.nowMs(),
            releasedBarriers: [],
            quoteResponse: null,
            rawStatus: null,
            rejectCode: 'RS_SCENARIO_LIMIT_EXCEEDED',
          },
          next: v.freeze(),
        };
      }
      throw error;
    }
  }

  /** Apply a plan whose request the journal accepted (or which needs no journal write). */
  commit(plan: RuntimePlan): Decision {
    this.state = plan.next;
    return plan.decision;
  }

  /** Record that the journal refused a request; the scenario cursor does not move. */
  deny(request: ScenarioRequest, code: ErrorCode): void {
    const w = new Working(this.plan, this.state);
    if (w.events.length >= this.plan.resourceBudget.maxEvents) return;
    w.emit('REQUEST_DENIED', {
      route: request.route,
      materialDigest: materialDigest(request.route, request.material),
      detail: code,
    });
    this.state = w.freeze();
  }

  /** Close client input: run remaining timeline steps, abandon held barriers, summarize. */
  finish(): RuntimeSummary {
    const w = new Working(this.plan, this.state);
    try {
      for (;;) {
        w.runTimeline(null);
        const st = w.step();
        if (w.ended || !st) break;
        w.cursor++;
        w.emit('UNCONSUMED_REQUEST_STEP', { stepId: st.id, route: 'match' in st ? st.match.route : null });
      }
      for (const b of w.barriers) w.emit('BARRIER_ABANDONED', { stepId: b.stepId });
      w.barriers = [];
      w.emit('SCENARIO_FINISHED', {});
    } catch (error) {
      if (!(error instanceof RouteSpecError && error.code === 'RS_SCENARIO_LIMIT_EXCEEDED')) throw error;
      w.limitBreached = true;
    }
    this.state = w.freeze();
    return this.summary();
  }

  summary(): RuntimeSummary {
    const byId = new Map(this.plan.groundTruthEvents.map((e) => [e.id, e]));
    const events = this.state.events;
    return Object.freeze({
      runtimeRevision: RUNTIME_REVISION,
      scenarioId: this.plan.scenarioId,
      events,
      eventLogDigest: digestValue('routespec.scenario.events/1', events),
      groundTruth: events
        .filter((e) => e.kind === 'GROUND_TRUTH' || e.kind === 'GROUND_TRUTH_DUPLICATE')
        .map((e) => ({
          seq: e.seq,
          virtualMs: e.virtualMs,
          duplicate: e.kind === 'GROUND_TRUTH_DUPLICATE',
          event: byId.get(e.groundTruthEventId as string) as CompiledGroundTruthEvent,
        })),
      providerStatusesServed: events
        .filter((e) => e.kind === 'PROVIDER_STATUS_SERVED')
        .map((e) => e.rawStatus as string),
      canonicalTimer: this.state.canonicalTimer,
      finalVirtualMs: this.state.nowMs,
      assertionsFailed: events.filter((e) => e.kind === 'ASSERTION_FAILED').length,
      unexpectedRequests: events.filter((e) => e.kind === 'UNEXPECTED_REQUEST').length,
      limitBreached: this.state.limitBreached,
    });
  }

  /** Protocol-faithful SubmitDepositTxResponse / GetExecutionStatusResponse body. */
  executionBody(
    quoteResponse: QuoteResponseBody,
    rawStatus: string,
    virtualMs: number,
  ): Record<string, unknown> {
    return {
      correlationId: quoteResponse.correlationId,
      quoteResponse,
      status: rawStatus,
      updatedAt: new VirtualClock(0, Number.MAX_SAFE_INTEGER).isoAt(virtualMs),
      swapDetails: {
        intentHashes: [],
        nearTxHashes: [],
        originChainTxHashes: [],
        destinationChainTxHashes: [],
      },
    };
  }

  /** Look up the quote response previously generated for a deposit address. */
  quoteForDepositAddress(depositAddress: string): QuoteResponseBody | null {
    const hit = this.state.quotes.find((q) => q.response.quote['depositAddress'] === depositAddress);
    return hit?.response ?? null;
  }

  private quoteFor(w: Working, request: ScenarioRequest): QuoteResponseBody {
    const material = request.material as QuoteRequestMaterial;
    const key = `${request.logicalJobKey ?? ''}\u0000${materialDigest('QUOTE', material)}`;
    const cached = w.quotes.find((q) => q.key === key);
    if (cached) return cached.response;
    const t = this.plan.operationTemplate;
    const correlationId = `sim-corr-${w.prng.hex(8)}`;
    const signature = `sim-sig-${w.prng.hex(16)}`;
    const quote: Record<string, unknown> = {
      amountIn: t.amountIn,
      amountInFormatted: t.amountIn,
      amountInUsd: '0',
      minAmountIn: t.amountIn,
      amountOut: t.amountOut,
      amountOutFormatted: t.amountOut,
      amountOutUsd: '0',
      minAmountOut: t.minAmountOut,
      deadline: material.deadline,
      timeEstimate: t.timeEstimateSec,
    };
    if (t.refundFee !== null) quote['refundFee'] = t.refundFee;
    if (t.withdrawFee !== null) quote['withdrawFee'] = t.withdrawFee;
    if (!material.dry) {
      quote['depositAddress'] = `sim-deposit-${w.prng.hex(10)}`;
      if (material.depositMode === 'MEMO') quote['depositMemo'] = `sim-memo-${w.prng.hex(4)}`;
    }
    const response: QuoteResponseBody = Object.freeze({
      correlationId,
      timestamp: w.clock.isoAt(),
      signature,
      quoteRequest: material,
      quote,
    });
    w.quotes.push({ key, response });
    return response;
  }
}
