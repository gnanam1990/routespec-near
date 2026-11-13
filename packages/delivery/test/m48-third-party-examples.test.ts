/**
 * M48 third-party example clients: pins, fetch, the confined loader, and the adapter's refusal to
 * run uncontained. No network and no container are used here, and no third-party code runs:
 *
 * - the committed pins are well formed (public repository, full commit, permissive licence, safe
 *   paths, digests) and a pin that is not is refused;
 * - `fetchSource` is exercised against a real git repository created by the test: exact blob
 *   bytes, digest and commit checks, and a link entry are all checked for real;
 * - the confined loader runs in a real Node process over a fixture tree written by the test;
 * - the committed adapter, started as a real subject process on this host, refuses to load the
 *   example because it is not inside a container.
 *
 * The contained run of the real pinned example is `third-party-test/m48-third-party.runtime.test.ts`.
 */
import { execFileSync, fork, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  captureConsole,
  insideContainer,
  observeSdkCalls,
  pinSdkBase,
} from '../../../examples/third-party/support/confined.ts';
import { fetchSource } from '../../../examples/third-party/support/fetch.ts';
import {
  PERMISSIVE_LICENCES,
  PINS_SCHEMA,
  PinError,
  loadPins,
  parsePins,
  sha256,
  sourceDir,
  verifySourceTree,
  type PinnedSource,
} from '../../../examples/third-party/support/pins.ts';
import { ThirdPartyUnavailable, runThirdParty, selectVerifiedPins } from '../src/third-party.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const DRIVER = fileURLToPath(new URL('./support/m48-load-driver.ts', import.meta.url));
const temps: string[] = [];
const temp = (label: string) => {
  const dir = mkdtempSync(join(tmpdir(), `routespec-m48-${label}-`));
  temps.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof PinError ? error.code : `UNEXPECTED ${String(error)}`;
  }
  return 'NO_ERROR';
};

function doc(over: Record<string, unknown> = {}): unknown {
  return {
    schema: PINS_SCHEMA,
    sources: [
      {
        id: 'fixture-source',
        repository: 'https://github.com/example-org/example-repo',
        standing: 'OFFICIAL',
        standingNote: 'Fixture written by the test.',
        commit: 'a'.repeat(40),
        licence: { spdx: 'MIT', file: 'LICENSE', holder: 'Fixture' },
        entry: 'src/entry.ts',
        files: [
          { path: 'LICENSE', sha256: `sha256:${'0'.repeat(64)}` },
          { path: 'src/entry.ts', sha256: `sha256:${'1'.repeat(64)}` },
        ],
        allowedImports: ['@defuse-protocol/one-click-sdk-typescript'],
        ...over,
      },
    ],
  };
}

describe('M48 pins', () => {
  it('the committed pins name public repositories, full commits, permissive licences, and digests', () => {
    const pins = loadPins();
    expect(pins.length).toBeGreaterThanOrEqual(1);
    for (const pin of pins) {
      expect(pin.repository).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+$/);
      expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(PERMISSIVE_LICENCES).toContain(pin.licence.spdx);
      expect(pin.files.map((f) => f.path)).toContain(pin.licence.file);
      expect(pin.files.map((f) => f.path)).toContain(pin.entry);
      // Each pinned source has an adapter and its declared-effects file in this repository.
      const adapter = join(ROOT, 'examples', 'third-party', pin.id, 'adapter.ts');
      expect(existsSync(adapter)).toBe(true);
      expect(existsSync(adapter.replace(/\.ts$/, '.effects.json'))).toBe(true);
      expect(existsSync(join(ROOT, 'examples', 'third-party', pin.id, 'NOTICE.md'))).toBe(true);
    }
  });

  it('no third-party source file is committed: the fetch directory is ignored by git', () => {
    const pin = loadPins()[0] as PinnedSource;
    const rel = join('.data', 'third-party', pin.id, pin.commit, ...pin.entry.split('/'));
    const ignored = spawnSync('git', ['check-ignore', '-q', rel], { cwd: ROOT });
    expect(ignored.status).toBe(0);
  });

  it('refuses a pin without a permissive licence, with an unsafe path, or with a loose identity', () => {
    expect(codeOf(() => parsePins(doc()))).toBe('NO_ERROR');
    for (const spdx of ['', 'UNLICENSED', 'GPL-3.0-only', 'NOASSERTION']) {
      expect(codeOf(() => parsePins(doc({ licence: { spdx, file: 'LICENSE', holder: 'Fixture' } })))).toBe(
        'PIN_LICENCE_NOT_PERMISSIVE',
      );
    }
    for (const path of ['../outside.ts', '/etc/passwd', 'src\\entry.ts', 'src/../../x.ts', 'src//x.ts', '']) {
      expect(
        codeOf(() =>
          parsePins(
            doc({
              entry: path,
              files: [
                { path: 'LICENSE', sha256: `sha256:${'0'.repeat(64)}` },
                { path, sha256: `sha256:${'1'.repeat(64)}` },
              ],
            }),
          ),
        ),
      ).toBe('PIN_PATH_UNSAFE');
    }
    expect(codeOf(() => parsePins(doc({ commit: 'main' })))).toBe('PIN_INVALID');
    expect(codeOf(() => parsePins(doc({ commit: 'abc1234' })))).toBe('PIN_INVALID');
    expect(codeOf(() => parsePins(doc({ repository: 'http://github.com/a/b' })))).toBe('PIN_INVALID');
    expect(codeOf(() => parsePins(doc({ repository: 'git@github.com:a/b.git' })))).toBe('PIN_INVALID');
    expect(codeOf(() => parsePins(doc({ standing: 'COMMUNITY' })))).toBe('PIN_STANDING_INVALID');
    expect(codeOf(() => parsePins(doc({ entry: 'src/other.ts' })))).toBe('PIN_INVALID');
    expect(codeOf(() => parsePins(doc({ allowedImports: ['../escape'] })))).toBe('PIN_INVALID');
    expect(codeOf(() => parsePins(doc({ allowedImports: ['node:fs'] })))).toBe('PIN_INVALID');
  });
});

// --- fetch: a real git repository made by the test stands in for the remote ---------------------

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  }).trim();
}

const ENTRY_BYTES = 'export const answer: number = 42;\r\n// CRLF and a trailing space are kept \r\n';
const LICENCE_BYTES = 'MIT License\n\nCopyright (c) fixture\n';

function remoteRepo(): { dir: string; commit: string; linkCommit: string } {
  const dir = temp('remote');
  git(dir, 'init', '--quiet');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'LICENSE'), LICENCE_BYTES);
  writeFileSync(join(dir, 'src', 'entry.ts'), ENTRY_BYTES);
  writeFileSync(join(dir, 'src', 'unpinned.ts'), 'export {};\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '-m', 'fixture');
  const commit = git(dir, 'rev-parse', 'HEAD');
  // A second commit where the entry is a link (mode 120000), made without needing link support.
  const blob = git(dir, 'hash-object', '-w', join(dir, 'LICENSE'));
  git(dir, 'update-index', '--add', '--cacheinfo', `120000,${blob},src/link.ts`);
  git(dir, 'commit', '--quiet', '-m', 'link');
  return { dir, commit, linkCommit: git(dir, 'rev-parse', 'HEAD') };
}

function fixturePin(commit: string, over: Partial<Record<string, unknown>> = {}): PinnedSource {
  return parsePins(
    doc({
      commit,
      files: [
        { path: 'LICENSE', sha256: sha256(LICENCE_BYTES) },
        { path: 'src/entry.ts', sha256: sha256(ENTRY_BYTES) },
      ],
      ...over,
    }),
  )[0] as PinnedSource;
}

describe('M48 fetch', () => {
  const remote = remoteRepo();

  it('writes exactly the pinned blobs, byte for byte, and nothing else', () => {
    const root = temp('root');
    const pin = fixturePin(remote.commit);
    const first = fetchSource(pin, { root, remote: remote.dir });
    expect(first.status).toBe('FETCHED');
    const dir = sourceDir(root, pin);
    expect(readFileSync(join(dir, 'src', 'entry.ts'), 'utf8')).toBe(ENTRY_BYTES);
    expect(existsSync(join(dir, 'src', 'unpinned.ts'))).toBe(false);
    expect(existsSync(join(dir, '.git'))).toBe(false);
    expect(verifySourceTree(dir, pin)).toEqual({ ok: true, findings: [] });
    expect(fetchSource(pin, { root, remote: remote.dir }).status).toBe('ALREADY_PRESENT');
  });

  it('refuses a blob that differs from its pinned digest and leaves nothing behind', () => {
    const root = temp('root');
    const pin = fixturePin(remote.commit, {
      files: [
        { path: 'LICENSE', sha256: sha256(LICENCE_BYTES) },
        { path: 'src/entry.ts', sha256: sha256('something else') },
      ],
    });
    expect(codeOf(() => fetchSource(pin, { root, remote: remote.dir }))).toBe('FETCH_DIGEST_MISMATCH');
    expect(existsSync(sourceDir(root, pin))).toBe(false);
  });

  it('refuses a commit the remote does not have, a missing file, and a link entry', () => {
    const root = temp('root');
    expect(codeOf(() => fetchSource(fixturePin('b'.repeat(40)), { root, remote: remote.dir }))).toBe(
      'FETCH_GIT_FAILED',
    );
    const missing = fixturePin(remote.commit, {
      entry: 'src/absent.ts',
      files: [
        { path: 'LICENSE', sha256: sha256(LICENCE_BYTES) },
        { path: 'src/absent.ts', sha256: sha256('x') },
      ],
    });
    expect(codeOf(() => fetchSource(missing, { root, remote: remote.dir }))).toBe('FETCH_NOT_A_REGULAR_FILE');
    const link = fixturePin(remote.linkCommit, {
      entry: 'src/link.ts',
      files: [
        { path: 'LICENSE', sha256: sha256(LICENCE_BYTES) },
        { path: 'src/link.ts', sha256: sha256('LICENSE') },
      ],
    });
    expect(codeOf(() => fetchSource(link, { root, remote: remote.dir }))).toBe('FETCH_NOT_A_REGULAR_FILE');
    expect(existsSync(sourceDir(root, link))).toBe(false);
  });

  it('a tree changed after the fetch no longer verifies and is not silently reused', () => {
    const root = temp('root');
    const pin = fixturePin(remote.commit);
    fetchSource(pin, { root, remote: remote.dir });
    const dir = sourceDir(root, pin);
    rmSync(join(dir, 'src', 'entry.ts'), { force: true });
    writeFileSync(join(dir, 'src', 'entry.ts'), `${ENTRY_BYTES}// edited\n`);
    writeFileSync(join(dir, 'src', 'extra.ts'), 'export {};\n');
    const check = verifySourceTree(dir, pin);
    expect(check.ok).toBe(false);
    expect(check.findings).toEqual(['UNPINNED_FILE src/extra.ts', 'DIGEST_MISMATCH src/entry.ts']);
    expect(codeOf(() => fetchSource(pin, { root, remote: remote.dir }))).toBe('FETCH_EXISTING_TREE_DIFFERS');
    expect(verifySourceTree(join(root, 'nowhere'), pin).findings).toEqual(['SOURCES_ABSENT']);
  });
});

// --- confined loader: a real Node process over a fixture tree -----------------------------------

interface DriverResult {
  ok: boolean;
  code?: string | null;
  message?: string;
  record?: { loaded: string[]; refused: Array<{ specifier: string; from: string }>; entryDigest: string };
  fixture: unknown;
  late?: unknown;
}

function runLoader(
  files: Record<string, string>,
  tamper?: { path: string; bytes: string },
  options: { viaLink?: boolean } = {},
): DriverResult {
  const dir = temp('tree');
  const pinned = Object.entries(files).map(([path, bytes]) => {
    const target = join(dir, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    return { path, sha256: sha256(bytes) };
  });
  if (tamper) writeFileSync(join(dir, ...tamper.path.split('/')), tamper.bytes);
  const pinsFile = join(temp('pins'), 'pins.json');
  writeFileSync(pinsFile, JSON.stringify(doc({ files: pinned })));
  // The tree named through a directory link, as a macOS temp dir is (/var -> /private/var).
  const named = options.viaLink ? join(temp('link'), 'tree') : dir;
  if (options.viaLink) symlinkSync(dir, named, process.platform === 'win32' ? 'junction' : 'dir');
  const r = spawnSync(process.execPath, ['--no-warnings', DRIVER, pinsFile, 'fixture-source', named], {
    encoding: 'utf8',
    cwd: ROOT,
  });
  const line = r.stdout.trim().split('\n').pop() ?? '';
  if (line === '') throw new Error(`driver printed nothing: ${r.stderr.slice(-600)}`);
  return JSON.parse(line) as DriverResult;
}

const LICENCE = { LICENSE: LICENCE_BYTES };

describe('M48 confined loader', () => {
  it('serves the pinned files, resolves the allow-listed SDK, and drops type-only imports', () => {
    const r = runLoader({
      ...LICENCE,
      // `TokenResponse` is a type in the SDK: imported without `type`, as published examples do.
      'src/entry.ts': [
        'import { OpenAPI, QuoteRequest, TokenResponse } from "@defuse-protocol/one-click-sdk-typescript";',
        'import { describeIt } from "./lib/helper";',
        'const tokens: TokenResponse[] = [];',
        '(globalThis as { __m48Fixture?: unknown }).__m48Fixture = {',
        '  base: OpenAPI.BASE, swapType: QuoteRequest.swapType.EXACT_INPUT, helper: describeIt(tokens.length),',
        '};',
      ].join('\n'),
      'src/lib/helper.ts': 'export function describeIt(n: number): string { return `helper:${n}`; }\n',
    });
    expect(r.ok, r.message).toBe(true);
    expect(r.record?.loaded).toEqual(['src/entry.ts', 'src/lib/helper.ts']);
    expect(r.record?.refused).toEqual([]);
    expect(r.fixture).toEqual({
      base: 'https://1click.chaindefuser.com',
      swapType: 'EXACT_INPUT',
      helper: 'helper:0',
    });
  });

  it('refuses a built-in, a package outside the allow-list, and a file outside the pin', () => {
    for (const specifier of ['node:fs', 'axios', './unpinned', '../../outside']) {
      const r = runLoader({
        ...LICENCE,
        'src/entry.ts': `import * as x from ${JSON.stringify(specifier)};\n(globalThis as { __m48Fixture?: unknown }).__m48Fixture = typeof x;\n`,
      });
      expect(r.ok).toBe(false);
      expect(r.code).toBe('THIRD_PARTY_IMPORT_DENIED');
      expect(r.fixture).toBeNull();
    }
  });

  it('holds an import made after the entry has loaded to the same rules', () => {
    const r = runLoader({
      ...LICENCE,
      'src/entry.ts': [
        'const g = globalThis as { __m48Late?: unknown };',
        'setTimeout(() => {',
        '  import("node:child_process").then(',
        '    () => (g.__m48Late = "IMPORTED"),',
        '    (e: { code?: string }) => (g.__m48Late = e.code ?? "FAILED"),',
        '  );',
        '}, 20);',
      ].join('\n'),
    });
    expect(r.ok, r.message).toBe(true);
    expect(r.late).toBe('THIRD_PARTY_IMPORT_DENIED');
  });

  it('holds a tree named through a directory link to the same rules (macOS temp dirs)', () => {
    const ok = runLoader(
      {
        ...LICENCE,
        'src/entry.ts': [
          'import { OpenAPI } from "@defuse-protocol/one-click-sdk-typescript";',
          'import { describeIt } from "./lib/helper";',
          '(globalThis as { __m48Fixture?: unknown }).__m48Fixture = { base: OpenAPI.BASE, helper: describeIt(1) };',
        ].join('\n'),
        'src/lib/helper.ts': 'export function describeIt(n: number): string { return `helper:${n}`; }\n',
      },
      undefined,
      { viaLink: true },
    );
    expect(ok.ok, ok.message).toBe(true);
    expect(ok.record?.loaded).toEqual(['src/entry.ts', 'src/lib/helper.ts']);
    expect(ok.fixture).toEqual({ base: 'https://1click.chaindefuser.com', helper: 'helper:1' });
    for (const specifier of ['node:fs', 'axios', './unpinned']) {
      const r = runLoader(
        {
          ...LICENCE,
          'src/entry.ts': `import * as x from ${JSON.stringify(specifier)};\n(globalThis as { __m48Fixture?: unknown }).__m48Fixture = typeof x;\n`,
        },
        undefined,
        { viaLink: true },
      );
      expect(r.ok).toBe(false);
      expect(r.code).toBe('THIRD_PARTY_IMPORT_DENIED');
      expect(r.fixture).toBeNull();
    }
  });

  it('refuses a file whose bytes changed after it was pinned, before any of it runs', () => {
    const body = '(globalThis as { __m48Fixture?: unknown }).__m48Fixture = "ran";\n';
    const r = runLoader(
      { ...LICENCE, 'src/entry.ts': body },
      { path: 'src/entry.ts', bytes: `${body}// one byte more\n` },
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe('THIRD_PARTY_DIGEST_MISMATCH');
    expect(r.fixture).toBeNull();
  });
});

describe('M48 subject-side observation', () => {
  it('keeps OpenAPI.BASE on the proxy origin and records what an example tried to assign', async () => {
    const sdk = (await import('@defuse-protocol/one-click-sdk-typescript')) as unknown as {
      OpenAPI: { BASE: string };
    };
    const before = sdk.OpenAPI.BASE;
    sdk.OpenAPI.BASE = 'http://127.0.0.1:9531';
    const pin = pinSdkBase(sdk.OpenAPI);
    sdk.OpenAPI.BASE = 'https://1click.chaindefuser.com';
    sdk.OpenAPI.BASE = 'https://1click.chaindefuser.com';
    expect(sdk.OpenAPI.BASE).toBe('http://127.0.0.1:9531');
    expect(pin.ignored).toEqual(['https://1click.chaindefuser.com']);
    pin.release();
    sdk.OpenAPI.BASE = before;
    expect(sdk.OpenAPI.BASE).toBe(before);
  });

  it('records calls on a service class without changing what they return', async () => {
    class Service {
      static ok(value: number): Promise<number> {
        return Promise.resolve(value + 1);
      }
      static refused(): Promise<never> {
        return Promise.reject(
          Object.assign(new Error('refused'), {
            status: 404,
            body: { error: { code: 'RS_UNSUPPORTED_ROUTE' } },
          }),
        );
      }
    }
    const original = Service.ok;
    const seen = observeSdkCalls(Service);
    await expect(Service.ok(1)).resolves.toBe(2);
    await expect(Service.refused()).rejects.toThrow('refused');
    expect(await seen.settled({ idleMs: 60, timeoutMs: 2_000 })).toBe('SETTLED');
    expect(seen.calls).toEqual([
      { method: 'ok', outcome: 'RESOLVED', status: null, code: null },
      { method: 'refused', outcome: 'REJECTED', status: 404, code: 'RS_UNSUPPORTED_ROUTE' },
    ]);
    seen.restore();
    expect(Service.ok).toBe(original);
  });

  it('captures printed lines as text only, bounded, and restores the console', () => {
    const log = console.log;
    const cap = captureConsole(2, 12);
    console.log('a long line of text', { secret: 'not kept' });
    console.error(new Error('boom'));
    console.log('third line is dropped');
    cap.restore();
    expect(console.log).toBe(log);
    expect(cap.lines).toEqual([
      { stream: 'log', text: 'a long line ' },
      { stream: 'error', text: 'Error: boom' },
    ]);
  });
});

describe('M48 runner preconditions', () => {
  const reasonOf = async (fn: () => unknown): Promise<string> => {
    try {
      await fn();
    } catch (error) {
      return error instanceof ThirdPartyUnavailable ? error.reason : `UNEXPECTED ${String(error)}`;
    }
    return 'NO_ERROR';
  };

  it('launches nothing when the pinned files are absent, changed, or unknown', async () => {
    const root = temp('checkout');
    mkdirSync(join(root, 'examples', 'third-party'), { recursive: true });
    const pin = loadPins()[0] as PinnedSource;
    writeFileSync(
      join(root, 'examples', 'third-party', 'pins.json'),
      readFileSync(join(ROOT, 'examples', 'third-party', 'pins.json')),
    );
    expect(await reasonOf(() => selectVerifiedPins(root))).toBe('THIRD_PARTY_SOURCES_ABSENT');
    expect(await reasonOf(() => selectVerifiedPins(root, 'no-such-pin'))).toBe('THIRD_PARTY_PIN_UNKNOWN');
    const target = join(sourceDir(root, pin), ...pin.entry.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'not the pinned bytes');
    expect(await reasonOf(() => selectVerifiedPins(root))).toBe('THIRD_PARTY_SOURCES_DIFFER');
    expect(await reasonOf(() => runThirdParty({ root, work: temp('work') }))).toBe(
      'THIRD_PARTY_SOURCES_DIFFER',
    );
  });

  it('has no uncontained mode: without a container engine the run is refused', async () => {
    const before = process.env['ROUTESPEC_CONTAINER_CLI'];
    process.env['ROUTESPEC_CONTAINER_CLI'] = '["routespec-m48-no-such-engine"]';
    try {
      // Sources absent (a fresh clone) is refused first; with sources present the engine is.
      expect(['THIRD_PARTY_SOURCES_ABSENT', 'CONTAINER_RUNTIME_ABSENT']).toContain(
        await reasonOf(() => runThirdParty({ work: temp('work') })),
      );
    } finally {
      if (before === undefined) delete process.env['ROUTESPEC_CONTAINER_CLI'];
      else process.env['ROUTESPEC_CONTAINER_CLI'] = before;
    }
  });
});

describe('M48 adapter outside a container', () => {
  it('refuses to load the example when it is not inside a container', async (ctx) => {
    if (insideContainer()) ctx.skip('NOT_RUN: this host is itself a container');
    const pin = loadPins()[0] as PinnedSource;
    const adapter = join(ROOT, 'examples', 'third-party', pin.id, 'adapter.ts');
    const child = fork(adapter, [], {
      execArgv: ['--no-warnings'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const next = (type: string) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const onMessage = (m: unknown) => {
          const msg = m as Record<string, unknown>;
          if (msg['type'] === type || msg['type'] === 'error') {
            child.off('message', onMessage);
            resolve(msg);
          }
        };
        child.on('message', onMessage);
        child.once('exit', (code) => reject(new Error(`adapter exited ${String(code)}`)));
      });
    try {
      await next('loaded');
      const answer = next('run-done');
      child.send({ type: 'run', request: { logicalJob: 'm48-uncontained', quote: {}, txHash: 'none' } });
      const msg = await answer;
      expect(msg['type']).toBe('error');
      expect(msg['code']).toBe('THIRD_PARTY_UNCONTAINED');
    } finally {
      child.removeAllListeners('exit');
      child.kill();
    }
  });
});
