/**
 * Container containment launcher for a subject client (M14).
 *
 * `ContainedSubject.launch` starts the subject's whole process tree inside one Linux container:
 *
 * - `--network none`: the container has only its own loopback interface, so there is no route
 *   to any host, the internet, or a DNS resolver;
 * - `--read-only` root filesystem, the checkout bind-mounted read-only at the same path, and a
 *   small `noexec` tmpfs at `/tmp` that disappears with the container;
 * - `--cap-drop ALL`, `no-new-privileges`, a non-root user, `--pids-limit`, a memory limit, and
 *   `--init` so the container's PID namespace reaps and ends every descendant;
 * - the image is run by its immutable image id.
 *
 * The only channel out of the container is the shim's stdin/stdout (`shim.mjs`), owned by this
 * process. The shim listens on fixed loopback ports inside the container; each connection the
 * subject opens there is tunnelled here and connected to the one host target configured for
 * that port (the RouteSpec proxy, the effect interceptor sink). A port without a target refuses
 * the connection. Nothing else can leave the container.
 *
 * Only the shim writes frames to that channel (the subject's stdout goes to stderr), and every
 * frame, including an unterminated partial line, is bounded by `MAX_FRAME_BYTES`. A channel that
 * exceeds the bound stops the container and downgrades the verdict (RS-02).
 *
 * After start the engine's own record (`docker inspect`) and the shim's self-observation are
 * checked by `verifyInspect`; only a clean result is `PROCESS_TREE_ENFORCED`. Teardown stops the
 * tree, waits for the engine to remove the container, and reports whether anything survived.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enginePath, runEngine, type ContainerCli } from './runtime.ts';
import { verifyInspect, type ContainmentVerdict, type SelfObservation } from './verify.ts';

export const SHIM_PATH = fileURLToPath(new URL('./shim.mjs', import.meta.url));

export interface TunnelPort {
  /** Port the shim listens on inside the container (127.0.0.1). */
  readonly containerPort: number;
  /** Host target (127.0.0.1:hostPort); null until `setTunnelTarget`. */
  readonly hostPort: number | null;
  readonly purpose: string;
}

export interface LaunchOptions {
  readonly cli: ContainerCli;
  readonly imageId: string;
  /** Host directory mounted read-only at the same engine path (the installed checkout). */
  readonly root: string;
  /** Host path of the subject entry script; must lie inside `root`. */
  readonly entry: string;
  readonly tunnels: readonly TunnelPort[];
  readonly maxPids?: number;
  readonly memoryBytes?: number;
  readonly startTimeoutMs?: number;
  readonly onStderr?: (text: string) => void;
  /**
   * Called when the subject connects to a tunnel port that has no host target yet (for example
   * the effect sink before its interceptor exists). The connection waits while this resolves;
   * a null answer refuses it.
   */
  readonly resolveTunnel?: (containerPort: number) => Promise<number | null>;
}

export interface TunnelStats {
  connections: number;
  bytesIn: number;
  bytesOut: number;
  refused: number;
}

export interface TeardownEvidence {
  readonly removed: boolean;
  readonly engineExitCode: number | null;
  readonly subjectExit: { code: number | null; signal: string | null } | null;
  readonly survivors: readonly string[];
  readonly tunnels: Readonly<Record<string, TunnelStats>>;
}

interface TunnelEntry {
  socket: Socket | null;
  pending: Buffer[];
  purpose: string;
  /** The subject ended its side before (or after) the host-side connect completed. */
  ended: boolean;
}

/** End a host-side tunnel socket after its queued bytes are written, then close it fully. */
function closeAfterFlush(socket: Socket): void {
  socket.end(() => socket.destroy());
}

export const DEFAULT_MAX_PIDS = 128;
/**
 * Largest shim -> host frame (bytes, excluding the newline). The shim caps the frames it writes
 * at 1 MiB, so anything larger did not come from a well-behaved shim (RS-02).
 */
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const CONTROL_CHANNEL_FRAME_TOO_LARGE = 'CONTROL_CHANNEL_FRAME_TOO_LARGE';
export const DEFAULT_MAX_MEMORY_BYTES = 512 * 1024 * 1024;

function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel.length > 0 && !rel.startsWith('..') && !rel.split(sep).includes('..');
}

export class ContainedSubject {
  readonly name: string;
  readonly cli: ContainerCli;
  readonly imageId: string;
  readonly engineRoot: string;
  readonly expectations: {
    imageId: string;
    readOnlyMounts: string[];
    maxPids: number;
    maxMemoryBytes: number;
    tunnelPorts: number[];
  };
  verdict: ContainmentVerdict = {
    containment: 'DECLARED_HOOKS_ONLY',
    findings: ['NOT_VERIFIED'],
    sandboxScopeDigest: null,
    scope: null,
  };
  self: SelfObservation | null = null;
  containerId = '';
  subjectExit: { code: number | null; signal: string | null } | null = null;
  /** Set when the control channel broke its framing bound; the container is then stopped. */
  channelFault: string | null = null;
  readonly stats: Record<string, TunnelStats> = {};
  readonly #proc: ChildProcessWithoutNullStreams;
  readonly #targets = new Map<number, { hostPort: number | null; purpose: string }>();
  readonly #resolveTunnel: ((containerPort: number) => Promise<number | null>) | null;
  readonly #resolving = new Map<number, Promise<number | null>>();
  readonly #sockets = new Map<number, TunnelEntry>();
  /** Every host-side socket this launcher opened that has not closed yet (M17). */
  readonly #hostSockets = new Set<Socket>();
  readonly #listeners = new Set<(m: Record<string, unknown>) => void>();
  /** Messages that arrived while nobody listened (for example `loaded` during verification). */
  readonly #backlog: Record<string, unknown>[] = [];
  readonly #exited: Promise<number | null>;
  #ready: ((self: SelfObservation) => void) | null = null;
  #failed: ((e: Error) => void) | null = null;
  #stopped = false;
  /** Bytes of the current, not yet newline-terminated, frame. */
  #partial: Buffer[] = [];
  #partialBytes = 0;

  private constructor(options: LaunchOptions, name: string) {
    this.name = name;
    this.cli = options.cli;
    this.imageId = options.imageId;
    this.engineRoot = enginePath(options.cli, resolve(options.root));
    this.#resolveTunnel = options.resolveTunnel ?? null;
    for (const t of options.tunnels) {
      this.#targets.set(t.containerPort, { hostPort: t.hostPort, purpose: t.purpose });
      this.stats[t.purpose] = { connections: 0, bytesIn: 0, bytesOut: 0, refused: 0 };
    }
    const maxPids = options.maxPids ?? DEFAULT_MAX_PIDS;
    const memory = options.memoryBytes ?? DEFAULT_MAX_MEMORY_BYTES;
    this.expectations = {
      imageId: options.imageId,
      readOnlyMounts: [this.engineRoot],
      maxPids,
      maxMemoryBytes: memory,
      tunnelPorts: options.tunnels.map((t) => t.containerPort),
    };
    const args = [
      'run',
      '--rm',
      '-i',
      '--init',
      '--name',
      name,
      '--label',
      'routespec.containment=subject',
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--pids-limit',
      String(maxPids),
      '--memory',
      String(memory),
      '--memory-swap',
      String(memory),
      '--user',
      '1000:1000',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,nodev,size=16m',
      '--env',
      'HOME=/tmp',
      '--volume',
      `${this.engineRoot}:${this.engineRoot}:ro`,
      '--workdir',
      this.engineRoot,
      options.imageId,
      'node',
      '--no-warnings',
      enginePath(options.cli, SHIM_PATH),
    ];
    const [program, ...lead] = options.cli.argv as [string, ...string[]];
    this.#proc = spawn(program, [...lead, ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.#exited = new Promise((r) => this.#proc.once('close', (code) => r(code)));
    this.#proc.on('error', (e) => this.#failed?.(e));
    this.#proc.once('close', (code) => {
      this.#failed?.(new Error(`container exited before ready (${String(code)})`));
      // Nothing the subject opened may outlive its container (M17).
      for (const s of this.#hostSockets) s.destroy();
      this.#hostSockets.clear();
      this.#sockets.clear();
    });
    let stderr = '';
    this.#proc.stderr.on('data', (c: Buffer) => {
      const text = c.toString('utf8');
      stderr = (stderr + text).slice(-8000);
      options.onStderr?.(text);
    });
    this.#proc.stdout.on('data', (chunk: Buffer) => this.#onChunk(chunk));
  }

  /** Start the subject tree in a new container and verify its confinement. */
  static async launch(options: LaunchOptions): Promise<ContainedSubject> {
    if (!inside(options.root, options.entry)) {
      throw new Error('The subject entry must lie inside the mounted checkout.');
    }
    const name = `routespec-subject-${randomBytes(8).toString('hex')}`;
    const subject = new ContainedSubject(options, name);
    const ready = new Promise<SelfObservation>((resolveReady, reject) => {
      subject.#ready = resolveReady;
      subject.#failed = reject;
    });
    const timeout = options.startTimeoutMs ?? 120_000;
    const timer = setTimeout(() => subject.#failed?.(new Error('container start timed out')), timeout);
    subject.#write({
      t: 'start',
      entry: enginePath(options.cli, resolve(options.entry)),
      execArgv: ['--no-warnings'],
      ports: subject.expectations.tunnelPorts,
    });
    try {
      subject.self = await ready;
    } catch (error) {
      clearTimeout(timer);
      await subject.stop().catch(() => undefined);
      throw error;
    }
    clearTimeout(timer);
    subject.#ready = null;
    subject.#failed = null;
    await subject.verify();
    return subject;
  }

  /** Re-read the engine record and recompute the containment verdict. */
  async verify(): Promise<ContainmentVerdict> {
    const r = await runEngine(this.cli, ['inspect', this.name]);
    let inspect: unknown = null;
    try {
      inspect = r.exitCode === 0 ? (JSON.parse(r.stdout) as unknown) : null;
    } catch {
      inspect = null;
    }
    this.verdict = verifyInspect(inspect, this.expectations, this.self);
    this.#applyChannelFault();
    const id = Array.isArray(inspect) ? (inspect[0] as { Id?: string } | undefined)?.Id : undefined;
    if (typeof id === 'string') this.containerId = id;
    return this.verdict;
  }

  /** Point a container port at its host target (for example the interceptor sink, once known). */
  setTunnelTarget(containerPort: number, hostPort: number): void {
    const t = this.#targets.get(containerPort);
    if (!t) throw new Error('Unknown tunnel port.');
    if (t.hostPort !== null && t.hostPort !== hostPort) throw new Error('Tunnel target is already set.');
    this.#targets.set(containerPort, { ...t, hostPort });
  }

  /** Send one IPC message to the subject process. */
  post(message: Record<string, unknown>): void {
    this.#write({ t: 'ipc', m: message });
  }

  onMessage(listener: (m: Record<string, unknown>) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Post a message and wait for the subject's `<type>-done` (or `error`) answer. */
  request(message: Record<string, unknown>, timeoutMs = 120_000): Promise<Record<string, unknown>> {
    const doneType = `${String(message['type'])}-done`;
    return new Promise((resolveReq, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`subject did not answer ${String(message['type'])}`));
      }, timeoutMs);
      const off = this.onMessage((m) => {
        if (m['type'] === doneType || m['type'] === 'error') {
          clearTimeout(timer);
          off();
          if (m['type'] === 'error') reject(new Error(`subject error ${String(m['code'])}`));
          else resolveReq(m);
        }
      });
      this.#exited.then(() => {
        clearTimeout(timer);
        off();
        reject(new Error('subject container exited'));
      });
      this.post(message);
    });
  }

  /** Wait for one message type from the subject. */
  waitFor(type: string, timeoutMs = 120_000): Promise<Record<string, unknown>> {
    const i = this.#backlog.findIndex((m) => m['type'] === type);
    if (i >= 0) return Promise.resolve(this.#backlog.splice(i, 1)[0] as Record<string, unknown>);
    return new Promise((resolveWait, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`subject did not send ${type}`));
      }, timeoutMs);
      const off = this.onMessage((m) => {
        if (m['type'] === type) {
          clearTimeout(timer);
          off();
          resolveWait(m);
        }
      });
    });
  }

  /** Processes inside the container as the engine sees them (`docker top`). */
  async processes(): Promise<string[]> {
    const r = await runEngine(this.cli, ['top', this.name, '-eo', 'pid,ppid,args']);
    return r.exitCode === 0
      ? r.stdout
          .split('\n')
          .slice(1)
          .filter((l) => l.trim().length > 0)
      : [];
  }

  get running(): boolean {
    return this.#proc.exitCode === null && !this.#stopped;
  }

  /**
   * Stop the subject tree and remove the container. `removed` is true only when the engine no
   * longer knows the container; `survivors` lists processes still reported inside it.
   */
  async stop(graceMs = 5000): Promise<TeardownEvidence> {
    const survivors: string[] = [];
    if (!this.#stopped) {
      this.#stopped = true;
      if (this.#proc.exitCode === null) {
        this.#write({ t: 'stop' });
        this.#proc.stdin.end();
      }
    }
    const timer = setTimeout(() => {
      void runEngine(this.cli, ['kill', this.name]).catch(() => undefined);
    }, graceMs);
    const engineExitCode = await this.#exited;
    clearTimeout(timer);
    let removed = false;
    for (let i = 0; i < 50 && !removed; i++) {
      const r = await runEngine(this.cli, ['inspect', '--format', '{{.State.Status}}', this.name]);
      if (r.exitCode !== 0) removed = true;
      else {
        if (i === 49) survivors.push(...(await this.processes()));
        await new Promise((r2) => setTimeout(r2, 200));
      }
    }
    if (!removed) {
      await runEngine(this.cli, ['rm', '-f', this.name]).catch(() => undefined);
    }
    return { removed, engineExitCode, subjectExit: this.subjectExit, survivors, tunnels: this.stats };
  }

  #write(obj: Record<string, unknown>): void {
    if (this.#proc.stdin.writable) this.#proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  /** Split the channel into newline-terminated frames without ever holding more than the bound. */
  #onChunk(chunk: Buffer): void {
    let start = 0;
    while (this.channelFault === null) {
      const nl = chunk.indexOf(0x0a, start);
      const end = nl < 0 ? chunk.length : nl;
      if (this.#partialBytes + (end - start) > MAX_FRAME_BYTES) {
        this.#faultChannel(CONTROL_CHANNEL_FRAME_TOO_LARGE);
        return;
      }
      if (nl < 0) {
        if (end > start) {
          this.#partial.push(chunk.subarray(start));
          this.#partialBytes += end - start;
        }
        return;
      }
      const piece = chunk.subarray(start, nl);
      const frame = this.#partialBytes === 0 ? piece : Buffer.concat([...this.#partial, piece]);
      this.#partial = [];
      this.#partialBytes = 0;
      this.#onLine(frame.toString('utf8'));
      start = nl + 1;
    }
  }

  #faultChannel(reason: string): void {
    this.channelFault = reason;
    this.#partial = [];
    this.#partialBytes = 0;
    this.#applyChannelFault();
    this.#failed?.(new Error(`control channel fault (${reason})`));
    void this.stop().catch(() => undefined);
  }

  #applyChannelFault(): void {
    if (this.channelFault === null) return;
    this.verdict = {
      ...this.verdict,
      containment: 'DECLARED_HOOKS_ONLY',
      findings: [...new Set([...this.verdict.findings, this.channelFault])].sort(),
    };
  }

  #onLine(line: string): void {
    const text = line.replace(/\r$/, '');
    if (text.length === 0) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = Number(msg['id']);
    switch (msg['t']) {
      case 'ready':
        this.#ready?.(msg['self'] as SelfObservation);
        break;
      case 'ipc': {
        const m = (msg['m'] ?? {}) as Record<string, unknown>;
        if (this.#listeners.size === 0) this.#backlog.push(m);
        else for (const l of [...this.#listeners]) l(m);
        break;
      }
      case 'exit':
        this.subjectExit = {
          code: (msg['code'] as number | null) ?? null,
          signal: (msg['signal'] as string | null) ?? null,
        };
        for (const l of [...this.#listeners]) l({ type: 'subject-exit', ...this.subjectExit });
        break;
      case 'open':
        this.#open(id, Number(msg['port']));
        break;
      case 'data': {
        const c = this.#sockets.get(id);
        if (!c) break;
        const bytes = Buffer.from(String(msg['b']), 'base64');
        const s = this.stats[c.purpose];
        if (s) s.bytesOut += bytes.length;
        if (c.socket) c.socket.write(bytes);
        else c.pending.push(bytes);
        break;
      }
      case 'end': {
        const c = this.#sockets.get(id);
        if (c) {
          // The shim's side is closed in both directions once the subject ends it (no half-open
          // tunnels), so the host side is ended and then fully closed. If the host-side connect
          // has not completed yet, it is closed as soon as it does (M17).
          this.#sockets.delete(id);
          c.ended = true;
          if (c.socket) closeAfterFlush(c.socket);
        }
        break;
      }
      default:
        break;
    }
  }

  #open(id: number, port: number): void {
    const target = this.#targets.get(port);
    if (!target) {
      this.#write({ t: 'end', id });
      return;
    }
    const entry: TunnelEntry = { socket: null, pending: [], purpose: target.purpose, ended: false };
    this.#sockets.set(id, entry);
    const refuse = () => {
      const s = this.stats[target.purpose];
      if (s) s.refused++;
      if (this.#sockets.delete(id)) this.#write({ t: 'end', id });
    };
    if (target.hostPort !== null) {
      this.#connect(id, entry, target.hostPort);
      return;
    }
    if (this.#resolveTunnel === null) {
      refuse();
      return;
    }
    let pending = this.#resolving.get(port);
    if (!pending) {
      pending = this.#resolveTunnel(port).then(
        (hostPort) => {
          if (hostPort !== null) this.setTunnelTarget(port, hostPort);
          return hostPort;
        },
        () => null,
      );
      this.#resolving.set(port, pending);
    }
    void pending.then((hostPort) => {
      if (!this.#sockets.has(id)) return;
      const now = this.#targets.get(port)?.hostPort ?? hostPort;
      if (now === null || now === undefined) refuse();
      else this.#connect(id, entry, now);
    });
  }

  #connect(id: number, entry: TunnelEntry, hostPort: number): void {
    const stats = this.stats[entry.purpose] as TunnelStats;
    stats.connections++;
    const socket = connect({ host: '127.0.0.1', port: hostPort }, () => {
      entry.socket = socket;
      for (const b of entry.pending) socket.write(b);
      entry.pending = [];
      if (entry.ended) closeAfterFlush(socket);
    });
    this.#hostSockets.add(socket);
    socket.once('close', () => this.#hostSockets.delete(socket));
    if (!this.running) socket.destroy();
    socket.on('data', (chunk: Buffer) => {
      stats.bytesIn += chunk.length;
      this.#write({ t: 'data', id, b: chunk.toString('base64') });
    });
    const close = () => {
      if (this.#sockets.delete(id)) this.#write({ t: 'end', id });
    };
    socket.on('end', close);
    socket.on('close', close);
    socket.on('error', () => socket.destroy());
  }
}
