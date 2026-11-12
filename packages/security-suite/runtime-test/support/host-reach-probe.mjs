/**
 * Container-side probe for the T-036 container-host run (M17). Node built-ins only.
 *
 * It runs in two places:
 *
 * - as the subject inside the RouteSpec containment launcher's confined container (forked by the
 *   in-container shim, IPC available): messages {type:'reach', targets} and
 *   {type:'http', port, path, method?, body?} answer `<type>-done`;
 * - as the main process of an ordinary container on the same engine (no IPC):
 *     node host-reach-probe.mjs reach <base64 JSON targets>    -> one JSON line of results
 *     node host-reach-probe.mjs discover                       -> interfaces and default gateways
 *     node host-reach-probe.mjs listen <base64 {hosts, ports}> -> a control listener (see below)
 *
 * A target is {id, kind, ...}: `tcp` {host, port} connects once and closes (no byte is sent);
 * `dns` {name} resolves a name; `unix` {path} connects to a Unix socket; `path` {path} checks
 * whether a filesystem path exists; `exec` {path, args} runs a program once (used for a Windows
 * executable in the mounted checkout, which WSL's binfmt registration would hand to the Windows
 * interop interpreter). Each result is a code: CONNECTED, TIMEOUT, an errno code (ENETUNREACH,
 * ECONNREFUSED, ...), RESOLVED:<addresses>, PRESENT or ABSENT; `exec` answers {result, stdout,
 * stderr}. The tests decide what the results prove.
 *
 * `listen` binds the first port of `ports` that is free on every address in `hosts` and prints
 * {"listening": port}; each connection gets one line and is closed. It is the positive control
 * that proves an ordinary container does have a path to the engine host's network.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { promises as dns } from 'node:dns';
import { connect, createServer } from 'node:net';
import { request } from 'node:http';
import { networkInterfaces } from 'node:os';

const TIMEOUT_MS = 3000;
const code = (e) => (e && typeof e === 'object' && 'code' in e ? String(e.code) : String(e));

function tcp(host, port) {
  return new Promise((resolve) => {
    let s;
    try {
      s = connect({ host, port, timeout: TIMEOUT_MS });
    } catch (e) {
      resolve(code(e));
      return;
    }
    s.once('connect', () => {
      s.destroy();
      resolve('CONNECTED');
    });
    s.once('timeout', () => {
      s.destroy();
      resolve('TIMEOUT');
    });
    s.once('error', (e) => resolve(code(e)));
  });
}

function unix(path) {
  return new Promise((resolve) => {
    const s = connect({ path, timeout: TIMEOUT_MS });
    s.once('connect', () => {
      s.destroy();
      resolve('CONNECTED');
    });
    s.once('timeout', () => {
      s.destroy();
      resolve('TIMEOUT');
    });
    s.once('error', (e) => resolve(code(e)));
  });
}

async function lookup(name) {
  try {
    const all = await dns.lookup(name, { all: true });
    return `RESOLVED:${all.map((a) => a.address).join(',')}`;
  } catch (e) {
    return code(e);
  }
}

function run(path, args) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(path, args ?? [], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 });
    } catch (e) {
      resolve({ result: code(e), stdout, stderr });
      return;
    }
    child.stdout.on('data', (c) => (stdout = (stdout + c.toString('utf8')).slice(0, 1000)));
    child.stderr.on('data', (c) => (stderr = (stderr + c.toString('utf8')).slice(0, 2000)));
    child.once('error', (e) => resolve({ result: code(e), stdout, stderr }));
    child.once('close', (exitCode, signal) =>
      resolve({ result: signal ? `SIGNAL_${signal}` : `EXIT_${String(exitCode)}`, stdout, stderr }),
    );
  });
}

async function reach(targets) {
  const results = {};
  await Promise.all(
    targets.map(async (t) => {
      if (t.kind === 'tcp') results[t.id] = await tcp(t.host, t.port);
      else if (t.kind === 'dns') results[t.id] = await lookup(t.name);
      else if (t.kind === 'unix') results[t.id] = await unix(t.path);
      else if (t.kind === 'path') results[t.id] = existsSync(t.path) ? 'PRESENT' : 'ABSENT';
      else if (t.kind === 'exec') results[t.id] = await run(t.path, t.args);
      else results[t.id] = 'UNKNOWN_KIND';
    }),
  );
  return results;
}

function http(port, path, method, body) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: method ?? (payload ? 'POST' : 'GET'),
        headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
        timeout: 10_000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8').slice(0, 2000) }),
        );
      },
    );
    req.once('error', (e) => resolve({ status: null, error: code(e) }));
    req.once('timeout', () => req.destroy(new Error('TIMEOUT')));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Default IPv4 gateways from the kernel routing table (little-endian hex). */
function defaultGateways() {
  let text = '';
  try {
    text = readFileSync('/proc/net/route', 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 3 || f[1] !== '00000000') continue;
    const hex = f[2];
    const b = [0, 2, 4, 6].map((i) => parseInt(hex.slice(i, i + 2), 16)).reverse();
    out.push({ iface: f[0], gateway: b.join('.') });
  }
  return out;
}

function discover() {
  const addresses = [];
  for (const [iface, list] of Object.entries(networkInterfaces())) {
    for (const a of list ?? []) addresses.push({ iface, address: a.address, family: a.family });
  }
  return { addresses, defaultGateways: defaultGateways() };
}

async function listen(hosts, ports) {
  const line = Buffer.from('routespec-t036-control\n');
  for (const port of ports) {
    const servers = [];
    try {
      for (const host of hosts) {
        const srv = createServer((s) => {
          // Probes connect and close at once; a reset must not end the control listener.
          s.on('error', () => s.destroy());
          s.end(line);
        });
        await new Promise((resolve, reject) => {
          srv.once('error', reject);
          srv.listen({ host, port, exclusive: true }, resolve);
        });
        servers.push(srv);
      }
      process.stdout.write(`${JSON.stringify({ listening: port, hosts })}\n`);
      return;
    } catch {
      for (const s of servers) s.close();
    }
  }
  process.stdout.write(`${JSON.stringify({ listening: null })}\n`);
  process.exit(3);
}

const decode = (b64) => JSON.parse(Buffer.from(String(b64), 'base64').toString('utf8'));

if (typeof process.send === 'function') {
  process.on('message', (msg) => {
    void (async () => {
      const reply = (body) => process.send?.({ type: `${msg.type}-done`, ...body });
      if (msg.type === 'reach') reply({ results: await reach(msg.targets) });
      else if (msg.type === 'http') reply(await http(msg.port, msg.path, msg.method, msg.body));
      else if (msg.type === 'discover') reply(discover());
      else reply({ error: 'UNKNOWN_MESSAGE' });
    })();
  });
  process.send({ type: 'loaded' });
} else {
  const [mode, arg] = process.argv.slice(2);
  if (mode === 'reach') {
    process.stdout.write(`${JSON.stringify({ results: await reach(decode(arg)) })}\n`);
  } else if (mode === 'discover') {
    process.stdout.write(`${JSON.stringify(discover())}\n`);
  } else if (mode === 'listen') {
    const { hosts, ports } = decode(arg);
    await listen(hosts, ports);
  } else {
    process.stderr.write('usage: host-reach-probe.mjs reach|discover|listen [arg]\n');
    process.exit(2);
  }
}
