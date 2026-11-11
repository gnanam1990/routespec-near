/**
 * Operating-system views used as independent evidence by the hardening tests: the command
 * lines of running processes (secret values must never travel as child-process arguments,
 * INV-11) and the listening TCP sockets of a process (loopback-only exposure, NFR-02).
 *
 * Both are read from the OS itself, not from RouteSpec's own bookkeeping.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

export interface ProcessCommandLine {
  readonly pid: number;
  readonly commandLine: string;
}

function powershell(script: string): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  });
}

/** Command lines of every process visible to this user. */
export function processCommandLines(): ProcessCommandLine[] {
  if (process.platform === 'win32') {
    // Base64 per line: command lines may hold control characters that break a JSON round trip.
    const text = powershell(
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) " + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_.CommandLine)) }',
    );
    return text
      .split(/\r?\n/)
      .map((l) => /^([0-9]+) ([A-Za-z0-9+/=]*)$/.exec(l.trim()))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({
        pid: Number(m[1]),
        commandLine: Buffer.from(m[2] as string, 'base64').toString('utf8'),
      }));
  }
  if (process.platform === 'linux') {
    const out: ProcessCommandLine[] = [];
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const raw = readFileSync(`/proc/${name}/cmdline`);
        out.push({ pid: Number(name), commandLine: raw.toString('utf8').split('\0').join(' ') });
      } catch {
        // process exited or not readable
      }
    }
    return out;
  }
  const text = execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return text
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), commandLine: m[2] as string }));
}

export interface ListeningSocket {
  readonly address: string;
  readonly port: number;
  readonly pid: number;
}

/** TCP sockets in the LISTEN state owned by `pid`, as the OS reports them. */
export function listeningSockets(pid: number): ListeningSocket[] {
  if (process.platform === 'win32') {
    const text = powershell(
      `Get-NetTCPConnection -State Listen -OwningProcess ${Math.trunc(pid)} -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress`,
    ).trim();
    if (text.length === 0) return [];
    const rows = JSON.parse(text) as
      | Array<{ LocalAddress: string; LocalPort: number; OwningProcess: number }>
      | { LocalAddress: string; LocalPort: number; OwningProcess: number };
    return (Array.isArray(rows) ? rows : [rows]).map((r) => ({
      address: r.LocalAddress,
      port: r.LocalPort,
      pid: r.OwningProcess,
    }));
  }
  // lsof is present on macOS and most Linux distributions.
  const text = execFileSync('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], {
    encoding: 'utf8',
  });
  return text
    .split('\n')
    .filter((l) => l.startsWith('n'))
    .map((l) => {
      const m = /^n(.*):(\d+)$/.exec(l);
      return m ? { address: (m[1] as string).replace(/^\[|\]$/g, ''), port: Number(m[2]), pid } : null;
    })
    .filter((x): x is ListeningSocket => x !== null);
}
