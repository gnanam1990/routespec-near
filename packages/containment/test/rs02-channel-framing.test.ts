/**
 * RS-02 (self-run audit, Cloudflare security-audit skill methodology): the shim's stdout is the
 * only channel from the container to the host, so only the shim may write frames to it, and the
 * host bounds every frame.
 *
 * These tests run the real `ContainedSubject` and the real `shim.mjs`. Only the container engine
 * is replaced, by a stand-in that runs the shim with its stdio passed through unchanged (as
 * `docker run -i` does), so no container runtime is needed.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ContainedSubject, MAX_FRAME_BYTES, parseContainerCli } from '../src/index.ts';

const tmp = mkdtempSync(join(tmpdir(), 'routespec-rs02-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const engine = join(tmp, 'stand-in-engine.mjs');
writeFileSync(
  engine,
  [
    "import { spawn } from 'node:child_process';",
    'const args = process.argv.slice(2);',
    "if (args[0] === 'run') {",
    '  if (process.env.RS02_RAW_FLOOD) {',
    // A channel writer other than a well-behaved shim: one ready frame, then an endless line.
    "    process.stdout.write(JSON.stringify({ t: 'ready', self: { uid: 1000, interfaces: ['lo'] } }) + '\\n');",
    "    process.stdout.write('B'.repeat(Number(process.env.RS02_RAW_FLOOD)));",
    "    process.stdin.on('data', () => undefined);",
    "    process.stdin.on('end', () => process.exit(0));",
    '  } else {',
    '    const shim = args[args.length - 1];',
    "    const c = spawn(process.execPath, ['--no-warnings', shim], { stdio: 'inherit' });",
    "    c.on('exit', (code) => process.exit(code ?? 1));",
    '  }',
    "} else if (args[0] === 'inspect') process.exit(1);",
    'else process.exit(0);',
  ].join('\n'),
);
const cli = parseContainerCli(JSON.stringify([process.execPath, engine]), 'native');

function subjectScript(name: string, body: string): string {
  const path = join(tmp, name);
  writeFileSync(
    path,
    [
      body,
      "process.on('message', (m) => { if (m && m.type === 'ping') process.send({ type: 'ping-done' }); });",
      'setInterval(() => undefined, 1000);',
    ].join('\n'),
  );
  return path;
}

async function launch(entry: string): Promise<ContainedSubject> {
  return ContainedSubject.launch({
    cli,
    imageId: `sha256:${'a'.repeat(64)}`,
    root: tmp,
    entry,
    tunnels: [],
    startTimeoutMs: 30_000,
  });
}

describe('RS-02 the subject cannot write to the host control channel', () => {
  it('a frame the subject prints on its stdout is not taken as a shim frame', async () => {
    const entry = subjectScript(
      'forge-exit.mjs',
      [
        "process.stdout.write(JSON.stringify({ t: 'exit', code: 0, signal: null }) + '\\n');",
        "process.stdout.write(JSON.stringify({ t: 'ipc', m: { type: 'forged' } }) + '\\n');",
        "setTimeout(() => process.send({ type: 'loaded' }), 100);",
      ].join('\n'),
    );
    const subject = await launch(entry);
    const seen: string[] = [];
    subject.onMessage((m) => seen.push(String(m['type'])));
    try {
      await subject.waitFor('loaded', 15_000);
      await subject.request({ type: 'ping' }, 15_000);
      expect(subject.running).toBe(true);
      expect(subject.subjectExit).toBeNull();
      expect(seen).not.toContain('forged');
      expect(seen).not.toContain('subject-exit');
    } finally {
      const t = await subject.stop();
      expect(t.subjectExit).not.toEqual({ code: 0, signal: null });
    }
  });

  it('newline-free subject output cannot swallow the next real shim frame', async () => {
    const entry = subjectScript(
      'flood.mjs',
      [
        "process.stdout.write('A'.repeat(4 * 1024 * 1024));",
        "setTimeout(() => process.send({ type: 'loaded' }), 100);",
      ].join('\n'),
    );
    const subject = await launch(entry);
    try {
      await subject.waitFor('loaded', 15_000);
      await subject.request({ type: 'ping' }, 15_000);
      expect(subject.running).toBe(true);
    } finally {
      await subject.stop();
    }
  });

  it('the shim does not relay an IPC message larger than one frame; it ends the subject', async () => {
    const entry = subjectScript(
      'big-ipc.mjs',
      "process.send({ type: 'loaded' }); process.send({ type: 'big', s: 'x'.repeat(2 * 1024 * 1024) });",
    );
    const subject = await launch(entry);
    const seen: string[] = [];
    subject.onMessage((m) => seen.push(String(m['type'])));
    try {
      const deadline = Date.now() + 15_000;
      while (subject.subjectExit === null && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 50));
      expect(subject.subjectExit).not.toBeNull();
      expect(subject.subjectExit?.code).not.toBe(0);
      expect(seen).not.toContain('big');
    } finally {
      await subject.stop();
    }
  });
});

describe('RS-02 the host bounds every frame on the control channel', () => {
  it('a pending line over the frame bound stops the container and marks containment unverified', async () => {
    process.env['RS02_RAW_FLOOD'] = String(MAX_FRAME_BYTES + 1024);
    let subject: ContainedSubject;
    try {
      subject = await launch(subjectScript('unused.mjs', ''));
    } finally {
      delete process.env['RS02_RAW_FLOOD'];
    }
    const deadline = Date.now() + 15_000;
    while (subject.running && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(subject.running).toBe(false);
    expect(subject.channelFault).toBe('CONTROL_CHANNEL_FRAME_TOO_LARGE');
    expect(subject.verdict.containment).toBe('DECLARED_HOOKS_ONLY');
    expect(subject.verdict.findings).toContain('CONTROL_CHANNEL_FRAME_TOO_LARGE');
    const t = await subject.stop();
    expect(t.engineExitCode).toBe(0);
  });

  it('a large frame inside the bound is still delivered', async () => {
    const entry = subjectScript(
      'large-ok.mjs',
      "process.send({ type: 'loaded', s: 'y'.repeat(512 * 1024) });",
    );
    const subject = await launch(entry);
    try {
      const m = await subject.waitFor('loaded', 15_000);
      expect(String(m['s']).length).toBe(512 * 1024);
      expect(subject.channelFault).toBeNull();
    } finally {
      await subject.stop();
    }
  });
});
