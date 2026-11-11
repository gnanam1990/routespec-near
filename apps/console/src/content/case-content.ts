import type { CaseLineageRole } from '@routespec/contracts/enums';
import type { CaseRun } from '../api/schemas.ts';

export const LINEAGE_ROLE_TEXT: Readonly<Record<CaseLineageRole, string>> = {
  BASELINE: 'Baseline',
  CORRECTED: 'Corrected client',
  REPLAY: 'Replay',
  PROMOTED_REGRESSION: 'Promoted regression',
};

export const TOKEN_STATE_TEXT: Readonly<Record<CaseRun['token']['state'], string>> = {
  NOT_ISSUED: 'Not issued',
  ACTIVE: 'Active',
  EXPIRED: 'Expired',
  REVOKED: 'Revoked',
  REUSE_REJECTED: 'Reuse rejected',
};

export const CLIENT_STATE_TEXT: Readonly<Record<CaseRun['clientState'], string>> = {
  NOT_STARTED: 'Not started',
  CONNECTED: 'Client connected',
  TORN_DOWN: 'Torn down',
  TEARDOWN_INCOMPLETE: 'Teardown incomplete — REVIEW',
  CONCURRENT_CLIENT_REJECTED: 'Concurrent client rejected',
};
