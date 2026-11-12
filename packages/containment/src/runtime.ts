/**
 * Container runtime selection and detection (M14).
 *
 * The container command is configurable so the same launcher works with a plain Linux `docker`
 * CLI and with Docker Engine inside a WSL 2 distribution called from Windows:
 *
 *   ROUTESPEC_CONTAINER_CLI='["docker"]'                                         (Linux host)
 *   ROUTESPEC_CONTAINER_CLI='["wsl.exe","-d","Ubuntu-24.04","-u","root","--exec","docker"]'
 *
 * A JSON array is preferred; a plain string is split on whitespace. For `wsl.exe` a bare `--`
 * separator is rewritten to `--exec`, because `--` runs the command through the distribution's
 * login shell, which would expand `$` and other characters inside arguments.
 *
 * Detection never pulls an image and never changes the host: it asks the engine for its version
 * and inspects the pinned image. When no engine answers, the result is `ABSENT` with reason
 * `CONTAINER_RUNTIME_ABSENT`; tests that need a runtime then report NOT_RUN, never PASS or FAIL.
 */
import { spawn } from 'node:child_process';
import { basename } from 'node:path';

export const DEFAULT_CONTAINER_IMAGE = 'node:22-bookworm-slim';

export type PathStyle = 'wsl' | 'native';

export interface ContainerCli {
  /** Program and leading arguments; container arguments are appended. */
  readonly argv: readonly string[];
  /** How host paths are written for the engine. */
  readonly pathStyle: PathStyle;
  /** Notes about normalisation applied to the configured command. */
  readonly notes: readonly string[];
}

function isWsl(program: string): boolean {
  return /^wsl(\.exe)?$/i.test(basename(program));
}

/** Parse a configured container command (JSON array or whitespace-separated string). */
export function parseContainerCli(raw: string | undefined, pathStyle?: string): ContainerCli {
  const text = (raw ?? '').trim();
  let argv: string[];
  if (text.length === 0) argv = ['docker'];
  else if (text.startsWith('[')) {
    const parsed = JSON.parse(text) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      !parsed.every((x) => typeof x === 'string' && x.length > 0)
    ) {
      throw new Error('ROUTESPEC_CONTAINER_CLI must be a non-empty JSON array of strings.');
    }
    argv = parsed as string[];
  } else argv = text.split(/\s+/);
  const notes: string[] = [];
  const program = argv[0] as string;
  if (isWsl(program)) {
    const i = argv.indexOf('--');
    if (i > 0) {
      argv = [...argv.slice(0, i), '--exec', ...argv.slice(i + 1)];
      notes.push('WSL_SEPARATOR_REWRITTEN_TO_EXEC');
    }
    if (!argv.includes('--exec') && !argv.includes('-e')) {
      throw new Error('A wsl.exe container command must end with --exec <docker>.');
    }
  }
  const style: PathStyle =
    pathStyle === 'wsl' || pathStyle === 'native' ? pathStyle : isWsl(program) ? 'wsl' : 'native';
  return { argv, pathStyle: style, notes };
}

/** The configured container command from the environment. */
export function containerCliFromEnv(env: NodeJS.ProcessEnv = process.env): ContainerCli {
  return parseContainerCli(env['ROUTESPEC_CONTAINER_CLI'], env['ROUTESPEC_CONTAINER_PATH_STYLE']);
}

/** A host path as the engine sees it (`C:\a\b` -> `/mnt/c/a/b` for WSL). */
export function enginePath(cli: ContainerCli, hostPath: string): string {
  if (cli.pathStyle === 'native') return hostPath;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(hostPath);
  if (!m) {
    if (hostPath.startsWith('/')) return hostPath;
    throw new Error('A WSL engine path needs an absolute drive path.');
  }
  return `/mnt/${(m[1] as string).toLowerCase()}/${(m[2] as string).replace(/\\/g, '/')}`.replace(/\/+$/, '');
}

export interface RunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly spawnError: string | null;
}

/** Run one engine command and collect its output (never through a shell). */
export function runEngine(
  cli: ContainerCli,
  args: readonly string[],
  timeoutMs = 30_000,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const [program, ...lead] = cli.argv as [string, ...string[]];
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(program, [...lead, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', (e: NodeJS.ErrnoException) =>
      finish({ exitCode: null, stdout, stderr, timedOut, spawnError: e.code ?? 'SPAWN_FAILED' }),
    );
    child.on('close', (code) =>
      finish({ exitCode: code, stdout, stderr: stderr.slice(-4000), timedOut, spawnError: null }),
    );
  });
}

export type RuntimeStatus =
  | {
      readonly status: 'AVAILABLE';
      readonly engine: 'docker';
      readonly serverVersion: string;
      readonly serverOs: string;
      readonly imageRef: string;
      readonly imageId: string;
      readonly imageNodeVersion: string | null;
      readonly cli: ContainerCli;
    }
  | {
      readonly status: 'ABSENT';
      readonly reason:
        | 'CONTAINER_RUNTIME_ABSENT'
        | 'CONTAINER_IMAGE_ABSENT'
        | 'CONTAINER_RUNTIME_UNSUPPORTED';
      readonly detail: string;
      readonly cli: ContainerCli | null;
    };

/**
 * Ask the configured engine whether it can run Linux containers and whether the pinned image is
 * present locally. Never pulls.
 */
export async function detectContainerRuntime(
  options: { cli?: ContainerCli; image?: string; timeoutMs?: number } = {},
): Promise<RuntimeStatus> {
  let cli: ContainerCli;
  try {
    cli = options.cli ?? containerCliFromEnv();
  } catch (error) {
    return {
      status: 'ABSENT',
      reason: 'CONTAINER_RUNTIME_UNSUPPORTED',
      detail: String((error as Error).message),
      cli: null,
    };
  }
  const image = options.image ?? process.env['ROUTESPEC_CONTAINER_IMAGE'] ?? DEFAULT_CONTAINER_IMAGE;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const v = await runEngine(cli, ['version', '--format', '{{json .Server}}'], timeoutMs);
  if (v.exitCode !== 0) {
    const detail = v.spawnError ?? (v.timedOut ? 'TIMEOUT' : `EXIT_${String(v.exitCode)}`);
    return { status: 'ABSENT', reason: 'CONTAINER_RUNTIME_ABSENT', detail, cli };
  }
  let server: Record<string, unknown>;
  try {
    server = JSON.parse(v.stdout.trim()) as Record<string, unknown>;
  } catch {
    return { status: 'ABSENT', reason: 'CONTAINER_RUNTIME_ABSENT', detail: 'VERSION_UNPARSEABLE', cli };
  }
  if (server === null || typeof server !== 'object') {
    return { status: 'ABSENT', reason: 'CONTAINER_RUNTIME_ABSENT', detail: 'NO_SERVER', cli };
  }
  const serverOs = String(server['Os'] ?? '');
  if (serverOs !== 'linux') {
    return {
      status: 'ABSENT',
      reason: 'CONTAINER_RUNTIME_UNSUPPORTED',
      detail: `SERVER_OS_${serverOs}`,
      cli,
    };
  }
  const img = await runEngine(cli, ['image', 'inspect', '--format', '{{json .}}', image], timeoutMs);
  if (img.exitCode !== 0) {
    return { status: 'ABSENT', reason: 'CONTAINER_IMAGE_ABSENT', detail: image, cli };
  }
  let imageId = '';
  let imageNodeVersion: string | null = null;
  try {
    const info = JSON.parse(img.stdout.trim()) as { Id?: string; Config?: { Env?: string[] } };
    imageId = String(info.Id ?? '');
    const nodeEnv = (info.Config?.Env ?? []).find((e) => e.startsWith('NODE_VERSION='));
    imageNodeVersion = nodeEnv ? nodeEnv.slice('NODE_VERSION='.length) : null;
  } catch {
    imageId = '';
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) {
    return { status: 'ABSENT', reason: 'CONTAINER_IMAGE_ABSENT', detail: 'IMAGE_ID_UNREADABLE', cli };
  }
  return {
    status: 'AVAILABLE',
    engine: 'docker',
    serverVersion: String(server['Version'] ?? ''),
    serverOs,
    imageRef: image,
    imageId,
    imageNodeVersion,
    cli,
  };
}
