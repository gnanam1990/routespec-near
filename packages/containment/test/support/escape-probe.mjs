/**
 * Hostile subject used by the M14 containment tests. It runs as the subject inside the
 * container and tries to leave it: direct TCP/UDP egress (IPv4 and IPv6), DNS, other loopback
 * ports, the container gateway, writes outside the ephemeral /tmp, executing from /tmp,
 * privilege changes, a detached daemon in a new session, and a process flood. It reports what
 * happened; the tests decide what that proves. It never reaches a real downstream effect: every
 * attempt has no route, and the only reachable endpoints are the tunnels the launcher set up.
 *
 * IPC (from the shim): {type:'escape'} | {type:'http', port, path, body?} | {type:'daemon'} |
 * {type:'flood', count} | {type:'detach'}; each answers `<type>-done`.
 */
import { spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { promises as dns } from 'node:dns';
import { writeFileSync, existsSync, chmodSync } from 'node:fs';
import { connect } from 'node:net';
import { request } from 'node:http';
import { setTimeout } from 'node:timers';

const code = (e) => (e && typeof e === 'object' && 'code' in e ? String(e.code) : String(e));

function tcp(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const s = connect({ host, port, timeout: timeoutMs });
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

function udp(host, port) {
  return new Promise((resolve) => {
    const s = createSocket(host.includes(':') ? 'udp6' : 'udp4');
    s.once('error', (e) => {
      s.close();
      resolve(code(e));
    });
    s.send(Buffer.from('routespec-probe'), port, host, (e) => {
      s.close();
      resolve(e ? code(e) : 'SENT');
    });
  });
}

async function attempt(fn) {
  try {
    const v = await fn();
    return v === undefined ? 'OK' : v;
  } catch (e) {
    return code(e);
  }
}

async function escape(root, hostPort) {
  const r = {};
  r.tcpPublicV4 = await tcp('1.1.1.1', 443);
  r.tcpDnsV4 = await tcp('8.8.8.8', 53);
  r.tcpPublicV6 = await tcp('2606:4700:4700::1111', 443);
  r.tcpDockerGateway = await tcp('172.17.0.1', 2375);
  r.tcpWslHost = await tcp('10.255.255.254', 53);
  r.tcpLoopbackUnconfigured = await tcp('127.0.0.1', 9);
  r.tcpHostListenerPort = Number.isInteger(hostPort) ? await tcp('127.0.0.1', hostPort) : 'NOT_TRIED';
  r.udpDnsV4 = await udp('8.8.8.8', 53);
  r.dnsLookup = await attempt(async () => (await dns.lookup('registry.npmjs.org')).address);
  r.dnsResolve = await attempt(async () => (await dns.resolve4('example.com')).join(','));
  r.dnsHostGateway = await attempt(async () => (await dns.lookup('host.docker.internal')).address);
  r.writeRootfs = await attempt(() => writeFileSync('/etc/routespec-escape', 'x'));
  r.writeCheckout = await attempt(() => writeFileSync(`${root}/routespec-escape`, 'x'));
  r.writeTmp = await attempt(() => writeFileSync('/tmp/routespec-probe', 'x'));
  r.execFromTmp = await attempt(
    () =>
      new Promise((resolve, reject) => {
        writeFileSync('/tmp/routespec-exec.sh', '#!/bin/sh\necho escaped\n');
        chmodSync('/tmp/routespec-exec.sh', 0o755);
        const c = spawn('/tmp/routespec-exec.sh', [], { stdio: 'ignore' });
        c.once('error', reject);
        c.once('exit', (exitCode) => resolve(`EXIT_${String(exitCode)}`));
      }),
  );
  r.setuidRoot = await attempt(() => process.setuid(0));
  r.engineSocket = existsSync('/var/run/docker.sock') ? 'PRESENT' : 'ABSENT';
  return r;
}

function http(port, path, body) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: payload ? 'POST' : 'GET',
        headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
        timeout: 10_000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.once('error', (e) => resolve({ status: null, error: code(e) }));
    req.once('timeout', () => req.destroy(new Error('TIMEOUT')));
    if (payload) req.write(payload);
    req.end();
  });
}

process.on('message', (msg) => {
  void (async () => {
    const reply = (body) => process.send?.({ type: `${msg.type}-done`, ...body });
    if (msg.type === 'escape') reply({ results: await escape(process.cwd(), msg.hostPort) });
    else if (msg.type === 'http') reply(await http(msg.port, msg.path, msg.body));
    else if (msg.type === 'daemon') {
      // A detached grandchild in its own session that tries to outlive the subject and then
      // phone home once a minute. It must die with the container.
      const seconds = Number.isInteger(msg.seconds) ? msg.seconds : 600;
      const d = spawn('/bin/sh', ['-c', `sleep ${seconds}`], { detached: true, stdio: 'ignore' });
      d.unref();
      reply({ pid: d.pid });
    } else if (msg.type === 'flood') {
      let started = 0;
      let refused = null;
      const kids = [];
      for (let i = 0; i < msg.count; i++) {
        try {
          const k = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
          const err = await new Promise((resolve) => {
            k.once('spawn', () => resolve(null));
            k.once('error', (e) => resolve(code(e)));
          });
          if (err) {
            refused = err;
            break;
          }
          kids.push(k);
          started++;
        } catch (e) {
          refused = code(e);
          break;
        }
      }
      for (const k of kids) k.kill('SIGKILL');
      reply({ started, refused });
    } else if (msg.type === 'exit') {
      reply({});
      setTimeout(() => process.exit(0), 20);
    }
  })();
});
process.send?.({ type: 'loaded' });
