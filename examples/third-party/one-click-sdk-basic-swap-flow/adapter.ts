/**
 * Thin RouteSpec adapter for a pinned third-party example (M48):
 * `examples/basic-swap-flow.ts` of github.com/defuse-protocol/one-click-sdk-typescript, the
 * official 1Click TypeScript SDK repository (ISC licence, copyright NEAR Foundation; see
 * `NOTICE.md` next to this file and `examples/third-party/pins.json` for the pinned commit).
 *
 * The example is a script: importing it runs its whole flow once, with the values it hard-codes.
 * This adapter does not edit, wrap, or re-implement any of it. It only
 *   1. refuses to run outside the subject container,
 *   2. keeps the official SDK pointed at the RouteSpec proxy (the example assigns the hosted
 *      1Click URL to `OpenAPI.BASE`; that assignment is recorded and has no effect),
 *   3. imports the pinned file, byte-checked against its pinned SHA-256, and
 *   4. reports which SDK calls the example made and what it printed.
 *
 * None of the example's code is copied into this repository. The launch request's quote body
 * and transaction hash are not used: the example sends its own.
 */
import { runSubject, type Job } from '../../../packages/regressions/test/support/subject/runtime.ts';
import {
  assertInsideContainer,
  captureConsole,
  loadPinnedEntry,
  observeSdkCalls,
  pinSdkBase,
} from '../support/confined.ts';
import { pinById } from '../support/pins.ts';

const PIN_ID = 'one-click-sdk-basic-swap-flow';
const HARNESS = new URL('../../../packages/regressions/test/support/subject/runtime.ts', import.meta.url)
  .href;

const job: Job = async (ctx) => {
  assertInsideContainer();
  const pin = pinById(PIN_ID);
  const base = pinSdkBase(ctx.sdk.OpenAPI);
  const sdk = observeSdkCalls(ctx.sdk.OneClickService);
  const printed = captureConsole();
  let flow: 'SETTLED' | 'TIMEOUT' | 'LOAD_FAILED' = 'LOAD_FAILED';
  let loadError: string | null = null;
  let load: Awaited<ReturnType<typeof loadPinnedEntry>> | null = null;
  try {
    load = await loadPinnedEntry(pin, { resolveFrom: HARNESS });
    flow = await sdk.settled({ idleMs: 1_500, timeoutMs: 120_000 });
  } catch (error) {
    loadError =
      `${(error as { code?: string }).code ?? (error as Error).name}: ${(error as Error).message}`.slice(
        0,
        240,
      );
  } finally {
    printed.restore();
    sdk.restore();
  }
  return {
    result: flow,
    source: {
      id: pin.id,
      repository: pin.repository,
      commit: pin.commit,
      licence: pin.licence.spdx,
      entry: pin.entry,
      entryDigest: load?.entryDigest ?? null,
      filesLoaded: load?.loaded ?? [],
      importsRefused: load?.refused ?? [],
      sourceEdited: false,
    },
    loadError,
    baseAssignmentsIgnored: base.ignored,
    sdkCalls: sdk.calls,
    transport: ctx.adapter.log.map((r) => ({
      method: r.method,
      route: r.route,
      target: r.target,
      attempt: r.attempt,
      outcome: r.outcome,
      httpStatus: r.httpStatus,
      errorCode: r.errorCode,
    })),
    printed: printed.lines,
  };
};

runSubject(job);
