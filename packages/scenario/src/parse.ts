/**
 * Bounded, data-only parsing of scenario authoring source (TB-03, SECURITY.md section 8).
 *
 * - Byte size is checked before any parsing.
 * - JSON nesting depth is measured by a linear scan before `JSON.parse`, so a deeply nested
 *   document is rejected without recursion.
 * - YAML is parsed with the YAML 1.2 core schema only: no custom tags, no merge keys, unique
 *   keys required, and alias expansion capped (default 0 = aliases disabled). Any explicit tag
 *   (`!!js/function`, `!!binary`, `!custom`, ...) is an unsafe construct.
 * - The resulting plain value is walked once: non-JSON values (non-finite numbers, BigInt,
 *   Date, binary), prototype-polluting keys, over-long strings, and over-deep nesting fail
 *   closed. Nothing in the source is ever evaluated, fetched, imported, or opened as a file.
 */
import { RouteSpecError } from '@routespec/contracts';
import { isAlias, isNode, isScalar, parseDocument, visit } from 'yaml';
import { HARD_CAPS, limitExceeded } from './budget.ts';

export type SourceFormat = 'yaml' | 'json';

export interface ParseLimits {
  readonly maxSourceBytes: number;
  readonly maxDepth: number;
  readonly maxAliases: number;
  readonly maxStringLength: number;
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function unsafe(reason: string, details: Record<string, string | number> = {}): never {
  throw new RouteSpecError('RS_SCENARIO_UNSAFE_CONSTRUCT', 'Scenario source contains an unsafe construct.', {
    details: { reason, ...details },
  });
}

function invalid(reason: string): never {
  throw new RouteSpecError('RS_SCENARIO_INVALID', 'Scenario source could not be parsed as data.', {
    details: { reason },
  });
}

function jsonDepth(text: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (inString) {
      if (ch === 0x5c) i++;
      else if (ch === 0x22) inString = false;
      continue;
    }
    if (ch === 0x22) inString = true;
    else if (ch === 0x7b || ch === 0x5b) {
      depth++;
      if (depth > max) max = depth;
    } else if (ch === 0x7d || ch === 0x5d) depth--;
  }
  return max;
}

/** Walk a parsed value: plain JSON data only, bounded depth/strings, no pollution keys. */
export function assertPlainData(value: unknown, limits: ParseLimits, path = '$', depth = 0): void {
  if (depth > limits.maxDepth) limitExceeded('maxDepth', depth, limits.maxDepth);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (value.length > limits.maxStringLength)
      limitExceeded('maxStringLength', value.length, limits.maxStringLength);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) unsafe('non-finite-number', { path });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertPlainData(item, limits, `${path}[${i}]`, depth + 1));
    return;
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) unsafe('non-plain-object', { path });
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key)) unsafe('forbidden-key', { path: `${path}.${key}` });
      assertPlainData((value as Record<string, unknown>)[key], limits, `${path}.${key}`, depth + 1);
    }
    return;
  }
  unsafe('non-json-value', { path, type: typeof value });
}

/**
 * Maximum nesting of YAML flow collections (`[` / `{`) outside quoted scalars and comments.
 * Checked before the YAML parser runs: the parser composes flow collections recursively, so a
 * few kilobytes of brackets could otherwise exhaust the call stack (M11, T-042).
 */
const BACKSLASH = String.fromCharCode(92);
const NEWLINE = String.fromCharCode(10);
const WHITESPACE = /[ \t\r\n]/;

function yamlFlowDepth(source: string): number {
  let depth = 0;
  let max = 0;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i] as string;
    if (quote !== null) {
      if (quote === '"' && ch === BACKSLASH) i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '#' && (i === 0 || WHITESPACE.test(source[i - 1] as string))) {
      while (i < source.length && source[i] !== NEWLINE) i++;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '{') max = Math.max(max, ++depth);
    else if ((ch === ']' || ch === '}') && depth > 0) depth--;
  }
  return max;
}

export function parseScenarioSource(source: string, format: SourceFormat, limits: ParseLimits): unknown {
  if (typeof source !== 'string') invalid('source-not-text');
  const caps: ParseLimits = {
    maxSourceBytes: Math.min(limits.maxSourceBytes, HARD_CAPS.maxSourceBytes),
    maxDepth: Math.min(limits.maxDepth, HARD_CAPS.maxDepth),
    maxAliases: Math.min(limits.maxAliases, HARD_CAPS.maxAliases),
    maxStringLength: Math.min(limits.maxStringLength, HARD_CAPS.maxStringLength),
  };
  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes > caps.maxSourceBytes) limitExceeded('maxSourceBytes', bytes, caps.maxSourceBytes);
  let value: unknown;
  if (format === 'json') {
    const depth = jsonDepth(source);
    if (depth > caps.maxDepth) limitExceeded('maxDepth', depth, caps.maxDepth);
    try {
      value = JSON.parse(source);
    } catch {
      invalid('json-syntax');
    }
  } else if (format === 'yaml') {
    const flow = yamlFlowDepth(source);
    if (flow > caps.maxDepth) limitExceeded('maxDepth', flow, caps.maxDepth);
    const doc = parseDocument(source, {
      version: '1.2',
      schema: 'core',
      merge: false,
      uniqueKeys: true,
      strict: true,
      prettyErrors: false,
      stringKeys: true,
    });
    if (doc.errors.length > 0) {
      const code = doc.errors[0]?.code ?? 'YAML_ERROR';
      if (code === 'DUPLICATE_KEY') unsafe('duplicate-key');
      invalid(`yaml-${String(code).toLowerCase()}`);
    }
    if (doc.warnings.length > 0) {
      const code = String(doc.warnings[0]?.code ?? 'YAML_WARNING');
      if (code === 'TAG_RESOLVE_FAILED') unsafe('explicit-tag');
      invalid(`yaml-${code.toLowerCase()}`);
    }
    let aliases = 0;
    let tagged = false;
    let mergeKey = false;
    let structuralDepth = 0;
    visit(doc, {
      Alias: () => {
        aliases++;
      },
      Node: (_key, node, path) => {
        if (isNode(node) && !isAlias(node) && typeof node.tag === 'string' && node.tag.length > 0) {
          // The core schema resolves implicit scalars without setting `tag` on the node; any
          // explicit tag in the source (including standard `!!str`) is rejected as unsafe.
          tagged = true;
        }
        if (isScalar(node) && node.value === '<<') mergeKey = true;
        structuralDepth = Math.max(structuralDepth, path.length);
      },
    });
    if (tagged) unsafe('explicit-tag');
    if (mergeKey) unsafe('merge-key');
    if (aliases > caps.maxAliases) {
      if (caps.maxAliases === 0) unsafe('alias-disabled', { aliases });
      limitExceeded('maxAliases', aliases, caps.maxAliases);
    }
    // `path` counts Pair and collection nodes, so a mapping level contributes two entries.
    if (structuralDepth > caps.maxDepth * 2 + 2) limitExceeded('maxDepth', structuralDepth, caps.maxDepth);
    try {
      value = doc.toJS({ maxAliasCount: caps.maxAliases === 0 ? 0 : caps.maxAliases });
    } catch (error) {
      if (/alias/i.test(String((error as Error).message)))
        limitExceeded('maxAliases', aliases, caps.maxAliases);
      invalid('yaml-materialize');
    }
  } else {
    invalid('unknown-format');
  }
  assertPlainData(value, caps);
  return value;
}
