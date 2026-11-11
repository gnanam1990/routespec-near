/**
 * Separately spawned process for T-009: recompute the canonical replay digest from scratch and
 * print it as one JSON line. No arguments carry data; no file or network is touched.
 */
import { ScenarioRuntime, canonicalReplayDigest } from '../../src/index.ts';
import { REPLAY_COMPILED, replayExchanges, replayIdentity } from './replay-fixture.ts';

const probe = new ScenarioRuntime(REPLAY_COMPILED.plan);
const first = probe.commit(probe.planRequest(replayExchanges('unused')[0]!.request));
const deposit = String(first.quoteResponse?.quote['depositAddress']);
const result = canonicalReplayDigest(replayIdentity(), REPLAY_COMPILED, replayExchanges(deposit));
process.stdout.write(`${JSON.stringify({ digest: result.digest, events: result.summary.eventLogDigest })}\n`);
