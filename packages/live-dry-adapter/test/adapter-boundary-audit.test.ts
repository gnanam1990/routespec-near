/**
 * Supplementary static audit for the live-dry adapter source (supports T-020, T-021, T-038).
 *
 * - The adapter has no path into the gate journal, kernel, networkless proxy or scenario runtime:
 *   its compatibility result cannot reach or upgrade a local GateRun.
 * - Outbound network modules are confined to egress.ts (resolution, TLS, the one HTTP request);
 *   server.ts may only create the loopback listener; address-policy.ts only uses BlockList/isIP.
 * - The credential value is held only in credential.ts; nothing in src logs to the console, and
 *   only the operator command writes to stdout/stderr. Child processes start only in launch.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));
const text = (f: string) => readFileSync(join(SRC, f), 'utf8');

describe('live-dry adapter boundary audit', () => {
  it('does not import the gate journal, kernel, networkless proxy or scenario runtime', () => {
    for (const f of files) {
      expect(text(f), f).not.toMatch(/from\s+'@routespec\/(store|kernel|proxy|scenario|client-adapter)'/);
    }
  });

  it('confines outbound network modules to egress.ts', () => {
    for (const f of files) {
      const src = text(f);
      const imports = [...src.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'(node:[a-z_/]+)'/gm)].map(
        (m) => m[1],
      );
      for (const spec of imports) {
        if (spec === 'node:tls' || spec === 'node:dns' || spec === 'node:https' || spec === 'node:http2') {
          expect(f, `${f} imports ${spec}`).toBe('egress.ts');
        }
        if (spec === 'node:http') expect(['egress.ts', 'server.ts'], `${f} imports ${spec}`).toContain(f);
        if (spec === 'node:net') expect(f, `${f} imports ${spec}`).toBe('address-policy.ts');
        if (spec === 'node:child_process') expect(f, `${f} imports ${spec}`).toBe('launch.ts');
      }
      expect(src, f).not.toMatch(/\bfetch\(|from\s+'(undici|axios)'/);
    }
    expect(text('server.ts')).not.toMatch(/\brequest\s*\(/);
  });

  it('keeps the credential value inside credential.ts and never logs', () => {
    for (const f of files) {
      const src = text(f);
      if (f !== 'credential.ts') expect(src, f).not.toMatch(/#token/);
      expect(src, f).not.toMatch(/console\./);
      if (f !== 'probe-cli.ts') expect(src, f).not.toMatch(/process\.(stdout|stderr)\.write/);
    }
  });
});
