/**
 * Records the static read-only console demo (M54) from a real contained run.
 *
 * Input: the data directory, journey record and exported evidence bundle of a contained delivery
 * journey (`pnpm run delivery:journey -- ... --contained`). The recorder copies the data
 * directory, starts the real control service on it (loopback, port 9581 by default) with the
 * built console, and drives the console in Chromium: it opens every in-app link it finds,
 * breadth first, and keeps every GET response of the control API exactly as the service sent
 * it. Nothing is written by hand and nothing is mutated: the console's own requests are the only
 * requests, and a non-GET request fails the recording.
 *
 * Output (`--out`, default `packages/distribution/console-demo`):
 * - `snapshot.json`: `routespec.console-demo/1` with the provenance of the run and the responses;
 * - `evidence-bundle.tar`: the run's exported bundle, byte for byte;
 * - `provenance.json`: digests, counts, visited routes, and the commands that produced it.
 *
 * The recording fails if any response contains the control token, a path of this machine (the
 * repository, the home directory, the data directory), or if the journey was not contained.
 *
 *   node packages/distribution/src/console-demo/record.ts --data <dir> --journey <json> --bundle <tar>
 *        [--out <dir>] [--port 9581]
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { ROOT } from '../npm-package.ts';

type J = Record<string, unknown>;

export const DEMO_DIR = join(ROOT, 'packages', 'distribution', 'console-demo');
export const API_PREFIX = '/__routespec/v1';
const MAX_ROUTES = 400;

export interface RecordOptions {
  readonly dataDir: string;
  readonly journeyFile: string;
  readonly bundleFile: string;
  readonly outDir?: string;
  readonly port?: number;
}

export interface Recording {
  readonly snapshot: J;
  readonly provenance: J;
}

const sha256 = (bytes: Buffer | string): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export function buildConsole(): void {
  const vite = join(ROOT, 'apps', 'console', 'node_modules', 'vite', 'bin', 'vite.js');
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env['ROUTESPEC_CONSOLE_BASE'];
  delete env['ROUTESPEC_CONSOLE_OUT'];
  delete env['VITE_ROUTESPEC_DEMO'];
  execFileSync(process.execPath, [vite, 'build'], { cwd: join(ROOT, 'apps', 'console'), env, stdio: 'pipe' });
}

function startService(
  dataDir: string,
  port: number,
): Promise<{ child: ChildProcess; origin: string; token: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--no-warnings',
        join(ROOT, 'packages', 'control-api', 'src', 'main.ts'),
        '--data',
        dataDir,
        '--console',
        join(ROOT, 'apps', 'console', 'dist'),
        '--handoff',
        'stderr',
        '--port',
        String(port),
      ],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    const timer = setTimeout(
      () => reject(new Error(`control service did not start: ${stderr.slice(-500)}`)),
      30_000,
    );
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      const m = /routespec: console (http:\/\/127\.0\.0\.1:\d+)\/#token=([A-Za-z0-9._~-]+)/.exec(stderr);
      if (m) {
        clearTimeout(timer);
        resolvePromise({ child, origin: m[1] as string, token: m[2] as string });
      }
    });
    child.stdout?.resume();
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`control service exited ${String(code)}: ${stderr.slice(-500)}`));
    });
  });
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((r) => {
    if (child.exitCode !== null) return r();
    child.removeAllListeners('exit');
    child.once('exit', () => r());
    child.kill();
  });
}

/** Strings that must never appear in a published snapshot. */
export function forbiddenNeedles(extra: readonly string[] = []): string[] {
  const out = new Set<string>();
  for (const p of [ROOT, homedir(), tmpdir(), ...extra]) {
    if (p.length < 4) continue;
    out.add(p);
    out.add(p.replace(/\\/g, '/'));
    out.add(p.replace(/\\/g, '\\\\'));
  }
  return [...out];
}

export async function recordConsoleDemo(options: RecordOptions): Promise<Recording> {
  const journey = JSON.parse(readFileSync(options.journeyFile, 'utf8')) as J;
  const containment = journey['containment'] as J;
  if (containment['mode'] !== 'CONTAINED')
    throw new Error('the console demo is recorded from a contained run only');
  const corrected = journey['correctedRun'] as J;
  const bundleVerify = journey['bundleVerify'] as J;
  const exported = journey['export'] as J;
  const bundle = readFileSync(options.bundleFile);
  const bundleDigest = sha256(bundle);
  if (bundleDigest !== exported['outputDigest'])
    throw new Error('bundle is not the one this journey exported');
  if (bundleVerify['verified'] !== true) throw new Error('the journey did not verify its bundle');

  const work = mkdtempSync(join(tmpdir(), 'routespec-m54-record-'));
  const data = join(work, 'data');
  cpSync(options.dataDir, data, { recursive: true });
  buildConsole();
  const service = await startService(data, options.port ?? 9581);
  const responses: Record<string, { status: number; body: unknown }> = {};
  const refusals: string[] = [];
  const visited: string[] = [];
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    let inflight = 0;
    const pending: Promise<void>[] = [];
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (!url.pathname.startsWith(API_PREFIX)) return;
      if (req.method() !== 'GET') refusals.push(`${req.method()} ${url.pathname}`);
      inflight++;
    });
    const settle = (req: { url(): string }) => {
      if (new URL(req.url()).pathname.startsWith(API_PREFIX)) inflight--;
    };
    page.on('requestfailed', settle);
    page.on('response', (res) => {
      const url = new URL(res.url());
      if (!url.pathname.startsWith(API_PREFIX) || res.request().method() !== 'GET') {
        settle(res.request());
        return;
      }
      const key = `GET ${url.pathname.slice(API_PREFIX.length)}${url.search}`;
      pending.push(
        res
          .text()
          .then((text) => {
            responses[key] = {
              status: res.status(),
              body: text.length > 0 ? (JSON.parse(text) as unknown) : null,
            };
          })
          .finally(() => settle(res.request())),
      );
    });
    const quiet = async () => {
      let calm = 0;
      for (let i = 0; i < 200 && calm < 5; i++) {
        await page.waitForTimeout(100);
        calm = inflight === 0 ? calm + 1 : 0;
      }
      await Promise.all(pending);
    };
    await page.goto(`${service.origin}/#token=${service.token}`);
    await quiet();
    const queue: string[] = ['/'];
    const seen = new Set<string>(queue);
    while (queue.length > 0 && visited.length < MAX_ROUTES) {
      const route = queue.shift() as string;
      await page.evaluate((to) => {
        window.history.pushState({}, '', to);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, route);
      await quiet();
      visited.push(route);
      const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href') ?? ''));
      for (const href of hrefs) {
        if (!href.startsWith('/') || href.startsWith('//') || href.startsWith(API_PREFIX)) continue;
        const clean = href.split('#')[0] as string;
        if (!seen.has(clean)) {
          seen.add(clean);
          queue.push(clean);
        }
      }
    }
  } finally {
    await browser.close();
    await stop(service.child);
    rmSync(work, { recursive: true, force: true });
  }
  if (refusals.length > 0)
    throw new Error(`the console sent non-GET requests while recording: ${refusals.join(', ')}`);

  const ordered = Object.fromEntries(Object.entries(responses).sort(([a], [b]) => a.localeCompare(b)));
  const source = {
    commit: journey['commit'] as string,
    recordedAt: new Date().toISOString(),
    containment: containment['mode'] as string,
    platform: journey['platform'] as string,
    bundleDigest,
    correctedGateRunId: corrected['gateRunId'] as string,
    correctedDecision: (journey['restart'] as J)['correctedVerdict'] as string,
  };
  const snapshot = { schema: 'routespec.console-demo/1', source, responses: ordered };
  const text = `${JSON.stringify(snapshot, null, 1)}\n`;
  const leaks = forbiddenNeedles([options.dataDir, resolve(options.dataDir), data]).filter((n) =>
    text.includes(n),
  );
  if (text.includes(service.token)) leaks.push('control token');
  if (leaks.length > 0) throw new Error(`snapshot would publish ${leaks.length} machine-specific value(s)`);

  const provenance = {
    schema: 'routespec.console-demo-provenance/1',
    snapshotDigest: sha256(text),
    bundle: { file: 'evidence-bundle.tar', digest: bundleDigest, bytes: bundle.length },
    run: {
      journeySchema: journey['schema'],
      commit: journey['commit'],
      platform: journey['platform'],
      node: journey['node'],
      containment: {
        mode: containment['mode'],
        engine: containment['engine'],
        serverOs: containment['serverOs'],
        imageRef: containment['imageRef'],
        imageId: containment['imageId'],
      },
      gateRuns: Object.fromEntries(
        ['baselineRun', 'hedgingRun', 'baselineOnPromoted', 'correctedRun'].map((k) => [
          k,
          (journey[k] as J)['gateRunId'],
        ]),
      ),
      exportId: exported['exportId'],
      exportEvidenceUse: exported['evidenceUse'],
      bundleVerifiedByJourney: bundleVerify['verified'],
      decisionInBundle: bundleVerify['decisionInBundle'],
    },
    recording: {
      recordedAt: source.recordedAt,
      service: 'packages/control-api/src/main.ts (loopback) over a copy of the run data directory',
      browser: 'Chromium via @playwright/test, in-app navigation only, GET requests only',
      routesVisited: visited,
      responsesRecorded: Object.keys(ordered).length,
    },
  };
  const out = options.outDir ?? DEMO_DIR;
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'snapshot.json'), text);
  writeFileSync(join(out, 'evidence-bundle.tar'), bundle);
  writeFileSync(join(out, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  return { snapshot, provenance };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const need = (name: string): string => {
    const v = arg(name);
    if (v === undefined) throw new Error(`--${name} is required`);
    return resolve(v);
  };
  const port = arg('port');
  const recording = await recordConsoleDemo({
    dataDir: need('data'),
    journeyFile: need('journey'),
    bundleFile: need('bundle'),
    ...(arg('out') !== undefined ? { outDir: need('out') } : {}),
    ...(port !== undefined ? { port: Number(port) } : {}),
  });
  const p = recording.provenance['recording'] as J;
  process.stdout.write(
    `${JSON.stringify({ ok: true, routesVisited: (p['routesVisited'] as string[]).length, responsesRecorded: p['responsesRecorded'] })}\n`,
  );
}
