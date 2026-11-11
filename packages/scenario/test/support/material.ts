/** Synthetic protocol material used by scenario tests (no real assets or addresses). */
import type { ScenarioRequest } from '../../src/index.ts';

export function quoteMaterial(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dry: false,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset: 'nep141:origin.sim',
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: 'nep141:destination.sim',
    amount: '1000000',
    refundTo: 'refund.sim',
    refundType: 'ORIGIN_CHAIN',
    recipient: 'recipient.sim',
    recipientType: 'DESTINATION_CHAIN',
    deadline: '2026-11-11T12:00:00Z',
    ...overrides,
  };
}

export function quote(job = 'job-1', overrides: Record<string, unknown> = {}): ScenarioRequest {
  return { route: 'QUOTE', material: quoteMaterial(overrides), logicalJobKey: job };
}

export function commit(depositAddress: string, txHash = 'sim-tx-1'): ScenarioRequest {
  return { route: 'COMMIT', material: { txHash, depositAddress } };
}

export function status(depositAddress: string): ScenarioRequest {
  return { route: 'STATUS', material: { depositAddress } };
}
