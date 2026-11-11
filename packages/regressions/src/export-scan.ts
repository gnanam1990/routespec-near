/**
 * Export privacy scan for reviewed regression content (M05 deliverable 7; FR-17, NFR-03;
 * SECURITY.md section 9). It only scans and reports: no bundle is written here.
 *
 * Categories: credentials (configured values, JWT, bearer, provider keys, case tokens),
 * authorization headers, cookies, private keys, signed payloads, and sensitive addresses.
 * Findings carry category, JSON path, and count — never the value. Any credential, cookie,
 * private-key, or signed-payload finding blocks export; sensitive addresses block unless the
 * caller explicitly acknowledges their inclusion.
 */
import { RouteSpecError } from '@routespec/contracts';
import type { ImportJournal } from '@routespec/store';
import { safePath } from './findings.ts';
import type { JsonValue } from './ingest.ts';
import { scanSecrets } from './scan.ts';

export type ExportFindingCategory =
  | 'CREDENTIAL'
  | 'AUTHORIZATION_HEADER'
  | 'COOKIE'
  | 'PRIVATE_KEY'
  | 'SIGNED_PAYLOAD'
  | 'SENSITIVE_ADDRESS';

export interface ExportFinding {
  readonly category: ExportFindingCategory;
  readonly path: string;
  readonly count: number;
}

export interface ExportScan {
  readonly exportAllowed: boolean;
  readonly findings: readonly ExportFinding[];
}

const SIGNED_KEY =
  /^(?:txHash|signature|signedPayload|signedTransaction|signedTx|rawTransaction|signedMessage)$/i;
const ADDRESS_KEY =
  /^(?:depositAddress|recipient|refundTo|sender|senderAddress|address|nearSenderAccount|virtualChainRecipient|virtualChainRefundRecipient|connectedWallets|recipientAccount)$/i;
const HEX_SIGNATURE = /^(?:0x)?[0-9a-fA-F]{128,}$/;

function mapSecret(category: string): ExportFindingCategory {
  if (category === 'SECRET_PRIVATE_KEY') return 'PRIVATE_KEY';
  if (category === 'SECRET_COOKIE') return 'COOKIE';
  if (category === 'SECRET_AUTHORIZATION_HEADER') return 'AUTHORIZATION_HEADER';
  return 'CREDENTIAL';
}

export function scanForExport(
  content: unknown,
  options: { configuredSecrets?: readonly string[]; acknowledgeAddresses?: boolean } = {},
): ExportScan {
  const value = JSON.parse(JSON.stringify(content ?? null)) as JsonValue;
  const merged = new Map<string, ExportFinding>();
  const add = (category: ExportFindingCategory, path: string, count = 1) => {
    const key = `${category}\u0000${path}`;
    const prior = merged.get(key);
    merged.set(key, { category, path, count: (prior?.count ?? 0) + count });
  };
  for (const f of scanSecrets(value, { configuredSecrets: options.configuredSecrets ?? [] }).list()) {
    add(mapSecret(f.category), f.path, f.count);
  }
  const walk = (v: JsonValue, parts: Array<string | number>) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, [...parts, i]));
    if (v === null || typeof v !== 'object') {
      if (typeof v === 'string' && HEX_SIGNATURE.test(v)) add('SIGNED_PAYLOAD', safePath(parts));
      return;
    }
    for (const [k, child] of Object.entries(v)) {
      const path = safePath([...parts, k]);
      const present = child !== null && child !== '' && !(Array.isArray(child) && child.length === 0);
      if (SIGNED_KEY.test(k) && present) add('SIGNED_PAYLOAD', path);
      if (ADDRESS_KEY.test(k) && present) add('SENSITIVE_ADDRESS', path);
      walk(child, [...parts, k]);
    }
  };
  walk(value, []);
  const findings = [...merged.values()].sort((a, b) =>
    a.category < b.category ? -1 : a.category > b.category ? 1 : a.path < b.path ? -1 : 1,
  );
  const blocking = findings.filter(
    (f) => f.category !== 'SENSITIVE_ADDRESS' || options.acknowledgeAddresses !== true,
  );
  return { exportAllowed: blocking.length === 0, findings };
}

/** Scan reviewed or promoted import content for export (no bundle is written). */
export function scanImportForExport(
  journal: ImportJournal,
  importId: string,
  options: { configuredSecrets?: readonly string[]; acknowledgeAddresses?: boolean } = {},
): ExportScan {
  const view = journal.getImport(importId);
  if (view.state !== 'REVIEWED' && view.state !== 'PROMOTED') {
    throw new RouteSpecError('RS_IMPORT_STATE_INVALID', 'Only reviewed content can be scanned for export.', {
      details: { state: view.state },
    });
  }
  return scanForExport(
    { trace: view.sanitized, mapping: journal.latestMapping(importId)?.mapping ?? null },
    options,
  );
}

export function assertExportAllowed(scan: ExportScan): void {
  if (!scan.exportAllowed) {
    throw new RouteSpecError('RS_EXPORT_BLOCKED', 'Export privacy scan found sensitive material.', {
      details: { findings: scan.findings.slice(0, 32).map((f) => `${f.category}@${f.path}`) },
    });
  }
}
