/**
 * Separately launched replay trial process. It receives one trial input over the inherited IPC
 * channel, recompiles the scenario from its source with the M03 compiler, replays the exchange
 * sequence from a fresh runtime, and returns the canonical digest. No argument, environment
 * value, file, or network connection carries or fetches trial data.
 */
import { canonicalReplayDigest, compileScenario, type ReplayExchange } from '@routespec/scenario';

process.once('message', (raw: unknown) => {
  try {
    const input = raw as { identity: unknown; source: unknown; exchanges: ReplayExchange[] };
    const compiled = compileScenario(input.source, { format: 'json' });
    const r = canonicalReplayDigest(input.identity, compiled, input.exchanges);
    process.send?.({
      ok: true,
      result: {
        digest: r.digest,
        decisions: r.decisions.map((d) => ({ kind: d.kind, rawStatus: d.rawStatus })),
        canonicalTimer: r.summary.canonicalTimer,
        unexpectedRequests: r.summary.unexpectedRequests,
        assertionsFailed: r.summary.assertionsFailed,
        limitBreached: r.summary.limitBreached,
      },
    });
  } catch (error) {
    process.send?.({ ok: false, code: (error as { code?: string }).code ?? 'ERROR' });
  }
});
