/** Canonical byte form of a trace document (sorted keys, no whitespace, UTF-8). */
import { canonicalJson } from '@routespec/contracts';
import type { TraceDocument } from './trace.ts';

export function canonicalTraceBytes(trace: TraceDocument): Buffer {
  return Buffer.from(canonicalJson(trace), 'utf8');
}
