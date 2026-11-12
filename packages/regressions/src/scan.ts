/**
 * Secret detection and active-content neutralization over parsed, untrusted trace data
 * (FR-11, FR-17, NFR-03, INV-11; SECURITY.md sections 5 and 8; AC-05).
 *
 * Secret detection runs before anything is persisted. It checks configured secret values held
 * in memory for this call only (exact substring match), high-confidence credential patterns,
 * and credential-bearing field names. A finding records category and path, never the value.
 *
 * Active content is neutralized so imported text can only ever be text: angle brackets become
 * single guillemets, terminal/C0/C1 control characters and bidirectional overrides become
 * visible `\uXXXX` escapes, and everything is flagged for the reviewer. URLs and Markdown links
 * are left as inert text and flagged; nothing is fetched or followed. Instruction-shaped text
 * is flagged; it is data and cannot change product policy because no product decision reads
 * free text.
 */
import { FindingSet, safePath, type FindingCategory } from './findings.ts';
import type { JsonValue } from './ingest.ts';

const VALUE_RULES: ReadonlyArray<readonly [FindingCategory, RegExp]> = [
  // JWT and case-token shapes carry no leading word boundary (security fix vuln-0002).
  ['SECRET_JWT', /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['SECRET_BEARER', /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i],
  ['SECRET_PRIVATE_KEY', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  // NEAR-style ed25519 secret keys are base58 of 64 bytes (public keys are ~44 characters).
  ['SECRET_PRIVATE_KEY', /\bed25519:[1-9A-HJ-NP-Za-km-z]{80,}/],
  ['SECRET_CASE_TOKEN', /rsct_[A-Za-z0-9_-]{20,}/],
  ['SECRET_PROVIDER_KEY', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['SECRET_PROVIDER_KEY', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/],
  ['SECRET_PROVIDER_KEY', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['SECRET_PROVIDER_KEY', /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/],
];

const KEY_RULES: ReadonlyArray<readonly [FindingCategory, RegExp]> = [
  ['SECRET_AUTHORIZATION_HEADER', /^(?:proxy[-_]?)?authorization$/i],
  ['SECRET_COOKIE', /^(?:set[-_]?)?cookies?$/i],
  [
    'SECRET_FIELD',
    /^(?:jwt|bearer|token|access[-_]?token|refresh[-_]?token|id[-_]?token|provider[-_]?(?:jwt|token|credential)s?|api[-_]?key|apikey|secret|client[-_]?secret|password|passphrase|private[-_]?key|secret[-_]?key|mnemonic|seed[-_]?phrase|signing[-_]?key|x-routespec-case-token)$/i,
  ],
];

const ACTIVE_RULES: ReadonlyArray<readonly [FindingCategory, RegExp]> = [
  ['ACTIVE_SCRIPT', /<\s*\/?\s*script\b/i],
  ['ACTIVE_SCRIPT', /\bjavascript\s*:/i],
  ['ACTIVE_SVG_HANDLER', /<\s*svg\b/i],
  ['ACTIVE_SVG_HANDLER', /\bon[a-z]{3,20}\s*=/i],
  ['ACTIVE_HTML', /<\s*\/?\s*[a-zA-Z!?][^<>]{0,512}>/],
  ['ACTIVE_URL_SCHEME', /\b(?:data|vbscript|file|blob)\s*:/i],
  ['ACTIVE_MARKDOWN_LINK', /!?\[[^\]\n]{0,512}\]\([^)\n]{0,2048}\)/],
  ['ACTIVE_MARKDOWN_LINK', /<(?:https?|ftp|mailto):[^>\s]{1,2048}>/i],
  ['URL_NOT_FETCHED', /\b(?:https?|ftp|wss?):\/\/[^\s]{1,2048}/i],
];

const INSTRUCTION_RULES: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all)\b[^.\n]{0,20}\b(?:instructions?|rules?|prompts?)\b/i,
  /\byou\s+are\s+now\b/i,
  /\b(?:system|developer)\s+(?:prompt|message|instructions?)\b/i,
  /\b(?:mark|set|force|declare|treat)\b[^.\n]{0,48}\b(?:pass(?:ed)?|verdict|promot\w*|approv\w*)\b/i,
  /\bauto[-\s]?(?:promot|approv|merg)\w*/i,
];

const TERMINAL = /[\u001b\u009b]/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const CONTROL_ALL =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

export interface ScanOptions {
  /** Configured secret values, in memory for this call only. Values shorter than 8 are ignored. */
  readonly configuredSecrets?: readonly string[];
}

function visibleEscape(ch: string): string {
  return `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
}

/** Make a string inert: no markup delimiters, no control or bidirectional characters. */
export function neutralizeText(text: string): string {
  return text.replace(CONTROL_ALL, visibleEscape).replace(/</g, '\u2039').replace(/>/g, '\u203a');
}

export function scanSecretsInString(
  text: string,
  path: string,
  findings: FindingSet,
  configured: readonly string[],
): void {
  for (const value of configured) {
    if (value.length >= 8 && text.includes(value)) findings.add('SECRET_CONFIGURED_VALUE', path);
  }
  for (const [category, rule] of VALUE_RULES) if (rule.test(text)) findings.add(category, path);
}

/** Detect secrets anywhere in the parsed document (keys and values). Never returns values. */
export function scanSecrets(value: JsonValue, options: ScanOptions = {}): FindingSet {
  const findings = new FindingSet();
  const configured = (options.configuredSecrets ?? []).filter((s) => s.length >= 8);
  const walk = (v: JsonValue, parts: Array<string | number>) => {
    const path = safePath(parts);
    if (typeof v === 'string') {
      scanSecretsInString(v, path, findings, configured);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, [...parts, i]));
      return;
    }
    if (v !== null && typeof v === 'object') {
      for (const [key, child] of Object.entries(v)) {
        const childPath = [...parts, key];
        scanSecretsInString(key, safePath(childPath), findings, configured);
        const nonEmpty =
          child !== null && child !== '' && !(Array.isArray(child) && child.length === 0) && child !== false;
        for (const [category, rule] of KEY_RULES) {
          if (rule.test(key) && nonEmpty) findings.add(category, safePath(childPath));
        }
        walk(child, childPath);
      }
    }
  };
  walk(value, []);
  return findings;
}

/** Neutralize every string (keys included) and flag active or instruction-shaped content. */
export function neutralizeDocument(value: JsonValue, findings: FindingSet): JsonValue {
  const walk = (v: JsonValue, parts: Array<string | number>): JsonValue => {
    if (typeof v === 'string') {
      const path = safePath(parts);
      if (TERMINAL.test(v)) findings.add('ACTIVE_TERMINAL_ESCAPE', path);
      else if (CONTROL.test(v)) findings.add('ACTIVE_CONTROL_CHARACTER', path);
      if (BIDI.test(v)) findings.add('ACTIVE_BIDI_CONTROL', path);
      const seen = new Set<FindingCategory>();
      for (const [category, rule] of ACTIVE_RULES) {
        if (!seen.has(category) && rule.test(v)) {
          seen.add(category);
          findings.add(category, path);
        }
      }
      if (INSTRUCTION_RULES.some((r) => r.test(v))) findings.add('INSTRUCTION_TEXT', path);
      return neutralizeText(v);
    }
    if (Array.isArray(v)) return v.map((item, i) => walk(item, [...parts, i]));
    if (v !== null && typeof v === 'object') {
      const out: Record<string, JsonValue> = {};
      for (const [key, child] of Object.entries(v)) {
        const safeKey = neutralizeText(key);
        if (safeKey !== key) findings.add('ACTIVE_CONTROL_CHARACTER', safePath([...parts, key]));
        out[safeKey] = walk(child, [...parts, key]);
      }
      return out;
    }
    return v;
  };
  return walk(value, []);
}

/**
 * Text for display surfaces (CLI, logs, console): the sanitized text with HTML-significant
 * characters entity-escaped as a second independent layer. Renderers still use text nodes.
 */
export function toDisplayText(text: string): string {
  return neutralizeText(text)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;');
}
