/**
 * In-container entry point of the RouteSpec containment launcher (M14).
 *
 * This file runs inside the subject container (network mode `none`, read-only root, no
 * capabilities, non-root user). It is the only process the launcher starts there; everything
 * else in the container is its descendant, so the container's PID namespace and cgroup hold the
 * whole subject process tree and the engine kills all of it when this process exits.
 *
 * It has no network: the container has only a loopback interface. Its one channel to the host is
 * its own stdin/stdout, owned by the launcher. Only this file writes to that stdout: the subject's
 * stdout and stderr both go to the shim's stderr. Frames are bounded in both directions: the shim
 * ignores host lines over MAX_LINE, and an IPC message from the subject whose frame would exceed
 * MAX_LINE bytes is not relayed and ends the subject. The host stops the container on any frame
 * (or unterminated partial line) over its own bound, `MAX_FRAME_BYTES` in sandbox.ts.
 * Over that channel (one JSON object per line):
 *
 *   host -> shim  {t:'start', entry, execArgv, ports}   once, first line
 *                 {t:'ipc', m}                          message for the subject (credentials, job)
 *                 {t:'data', id, b} / {t:'end', id}     bytes of tunnel connection `id` (base64)
 *                 {t:'stop'}                            end the subject tree and exit
 *   shim -> host  {t:'ready', self}                     listeners up; self-observed confinement
 *                 {t:'open', id, port}                  the subject connected to 127.0.0.1:port
 *                 {t:'data', id, b} / {t:'end', id}
 *                 {t:'ipc', m}                          message from the subject
 *                 {t:'exit', code, signal}              the subject process exited
 *
 * The shim listens only on the loopback ports the launcher names (the RouteSpec proxy and the
 * effect interceptor sink). The launcher decides where each tunnel goes; the shim cannot open a
 * connection to anything itself. Dependencies: Node built-ins only.
 */
import { fork } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { setTimeout } from 'node:timers';

const MAX_LINE = 1024 * 1024;
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const conns = new Map();
let nextId = 1;
let child = null;
let started = false;

function selfObservation() {
  const status = (() => {
    try {
      return readFileSync('/proc/self/status', 'utf8');
    } catch {
      return '';
    }
  })();
  const field = (name) => {
    const m = new RegExp(`^${name}:\\s*(\\S+)`, 'm').exec(status);
    return m ? m[1] : null;
  };
  let interfaces = [];
  try {
    interfaces = readdirSync('/sys/class/net').sort();
  } catch {
    interfaces = ['UNREADABLE'];
  }
  return {
    pid: process.pid,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    gid: typeof process.getgid === 'function' ? process.getgid() : null,
    capEff: field('CapEff'),
    capPrm: field('CapPrm'),
    capBnd: field('CapBnd'),
    noNewPrivs: field('NoNewPrivs'),
    seccomp: field('Seccomp'),
    interfaces,
    node: process.version,
  };
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      const id = nextId++;
      conns.set(id, socket);
      out({ t: 'open', id, port });
      socket.on('data', (chunk) => out({ t: 'data', id, b: chunk.toString('base64') }));
      socket.on('end', () => out({ t: 'end', id }));
      socket.on('close', () => {
        if (conns.delete(id)) out({ t: 'end', id });
      });
      socket.on('error', () => socket.destroy());
    });
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve(server));
  });
}

async function start(msg) {
  started = true;
  for (const port of msg.ports) await listen(port);
  child = fork(msg.entry, [], {
    execArgv: msg.execArgv,
    // The subject's stdout must never mix with the tunnel channel: route it to stderr (fd 2).
    stdio: ['ignore', 2, 2, 'ipc'],
    env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', NODE_ENV: 'production' },
    serialization: 'json',
  });
  child.on('message', (m) => {
    const line = JSON.stringify({ t: 'ipc', m });
    if (Buffer.byteLength(line) <= MAX_LINE) process.stdout.write(`${line}\n`);
    else if (child.exitCode === null) child.kill('SIGKILL');
  });
  child.on('exit', (code, signal) => {
    out({ t: 'exit', code, signal });
    setTimeout(() => process.exit(0), 50);
  });
  out({ t: 'ready', self: selfObservation() });
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const text = line.replace(/\r$/, '');
  if (text.length === 0 || text.length > MAX_LINE) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  if (msg.t === 'start' && !started) {
    start(msg).catch((error) => {
      out({ t: 'exit', code: 70, signal: null, error: String(error && error.code ? error.code : error) });
      process.exit(70);
    });
  } else if (msg.t === 'ipc' && child?.connected) {
    child.send(msg.m);
  } else if (msg.t === 'data') {
    conns.get(msg.id)?.write(Buffer.from(String(msg.b), 'base64'));
  } else if (msg.t === 'end') {
    const s = conns.get(msg.id);
    if (s) {
      conns.delete(msg.id);
      s.end();
    }
  } else if (msg.t === 'stop') {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    setTimeout(() => process.exit(0), 50);
  }
});
rl.on('close', () => {
  // The launcher closed the channel: nothing in the container may outlive it.
  if (child && child.exitCode === null) child.kill('SIGKILL');
  process.exit(0);
});
