/**
 * Subject-side support for running a pinned third-party example inside the container (M48).
 *
 * Four small pieces, shared by every adapter under `examples/third-party/`:
 *
 * - `assertInsideContainer`: refuses to go on unless the process runs inside a Linux container.
 *   The container is the security boundary; this check only stops an accidental uncontained run.
 * - `loadPinnedEntry`: imports the pinned entry file through module hooks that serve only the
 *   pinned files (each checked against its pinned SHA-256 when it is read), let them import
 *   only each other and the allow-listed packages, and translate TypeScript to JavaScript with
 *   the repository's pinned TypeScript compiler. The source text is never edited.
 * - `pinSdkBase`: keeps the official SDK's `OpenAPI.BASE` on the RouteSpec proxy origin. An
 *   example that assigns its own base URL is recorded and has no effect.
 * - `observeSdkCalls` and `captureConsole`: record which official SDK service methods the
 *   example called and what it printed. Observation only; every call runs unchanged.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, sha256, sourceDir, type PinnedSource } from './pins.ts';

export class ConfinedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ConfinedError';
    this.code = code;
  }
}

/** True when this process runs inside a Linux container (Docker or Podman marker file). */
export function insideContainer(): boolean {
  return process.platform === 'linux' && (existsSync('/.dockerenv') || existsSync('/run/.containerenv'));
}

export function assertInsideContainer(): void {
  if (!insideContainer()) {
    throw new ConfinedError(
      'THIRD_PARTY_UNCONTAINED',
      'Third-party example code runs only inside the subject container.',
    );
  }
}

interface TypeScriptApi {
  transpileModule(
    source: string,
    options: { compilerOptions: Record<string, unknown>; fileName: string },
  ): { outputText: string };
  ModuleKind: { ESNext: number };
  ScriptTarget: { ES2022: number };
}

export interface LoadOptions {
  /** Directory that holds the pinned files. Defaults to the pin's place in this checkout. */
  readonly dir?: string;
  /** Module URL the allow-listed packages are resolved from (the subject harness). */
  readonly resolveFrom: string;
}

export interface LoadRecord {
  readonly entry: string;
  readonly entryDigest: string;
  /** Files actually served to the module loader, in load order. */
  readonly loaded: string[];
  /** Imports that were refused (specifier and importing file). */
  readonly refused: Array<{ specifier: string; from: string }>;
}

/**
 * Import the pinned entry. Only pinned bytes are served; anything else the example asks for is
 * refused with `THIRD_PARTY_IMPORT_DENIED`.
 */
export async function loadPinnedEntry(pin: PinnedSource, options: LoadOptions): Promise<LoadRecord> {
  const dir = options.dir ?? sourceDir(REPO_ROOT, pin);
  const dirUrl = pathToFileURL(dir).href.replace(/\/?$/, '/');
  // Node's module loader names a file by its real path. Where the directory sits behind a
  // symbolic link (macOS: /var -> /private/var) the URLs the hooks see start with the real path,
  // so both spellings belong to the pinned tree; otherwise its imports would escape the hooks.
  const realDirUrl = pathToFileURL(realpathSync(dir)).href.replace(/\/?$/, '/');
  const prefixes = realDirUrl === dirUrl ? [dirUrl] : [dirUrl, realDirUrl];
  // The entry is named by the hooks themselves, in the spelling of `dir`, never by Node's own
  // resolution: so the entry and everything it imports are always read, digest-checked and
  // confined by these hooks, whatever links lie on the way to the tree.
  const entryUrl = new URL(pin.entry, dirUrl).href;
  const pinned = new Map(pin.files.map((f) => [f.path, f.sha256]));
  const record: LoadRecord = {
    entry: pin.entry,
    entryDigest: pinned.get(pin.entry) as string,
    loaded: [],
    refused: [],
  };
  const ts = createRequire(import.meta.url)('typescript') as TypeScriptApi;
  const relOf = (url: string): string | null => {
    const prefix = prefixes.find((p) => url.startsWith(p));
    if (prefix === undefined) return null;
    return decodeURIComponent(url.slice(prefix.length).split(/[?#]/)[0] ?? '');
  };
  const deny = (specifier: string, from: string): never => {
    record.refused.push({ specifier: specifier.slice(0, 200), from });
    throw new ConfinedError(
      'THIRD_PARTY_IMPORT_DENIED',
      `Pinned source ${pin.id} may not import "${specifier.slice(0, 200)}".`,
    );
  };
  // The hooks stay registered for the life of the process: an import the example makes later
  // (a dynamic import after its first await) is held to the same rules.
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === entryUrl) return { url: entryUrl, shortCircuit: true };
      const from = context.parentURL === undefined ? null : relOf(context.parentURL);
      if (from === null) return nextResolve(specifier, context);
      if (pin.allowedImports.includes(specifier)) {
        return nextResolve(specifier, { ...context, parentURL: options.resolveFrom });
      }
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        const target = relOf(new URL(specifier, context.parentURL).href);
        const candidates =
          target === null
            ? []
            : [target, `${target}.ts`, target.replace(/\.js$/, '.ts'), `${target}/index.ts`];
        const hit = candidates.find((c) => pinned.has(c));
        if (hit !== undefined) return { url: new URL(hit, dirUrl).href, shortCircuit: true };
      }
      return deny(specifier, from);
    },
    load(url, context, nextLoad) {
      const rel = relOf(url);
      if (rel === null) return nextLoad(url, context);
      const expected = pinned.get(rel);
      if (expected === undefined) return deny(rel, rel);
      const bytes = readFileSync(join(dir, ...rel.split('/')));
      if (sha256(bytes) !== expected) {
        throw new ConfinedError('THIRD_PARTY_DIGEST_MISMATCH', `${pin.id}: ${rel} differs from its pin.`);
      }
      record.loaded.push(rel);
      const source = /\.[cm]?tsx?$/.test(rel)
        ? ts.transpileModule(bytes.toString('utf8'), {
            compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
            fileName: rel,
          }).outputText
        : bytes.toString('utf8');
      return { format: 'module', source, shortCircuit: true };
    },
  });
  await import(entryUrl);
  return record;
}

export interface BaseHolder {
  BASE: string;
}

export interface BasePin {
  /** Values the example tried to assign to `OpenAPI.BASE` (each recorded once, in order). */
  readonly ignored: string[];
  release(): void;
}

/** Keep `OpenAPI.BASE` at its current value (the RouteSpec proxy origin set by the adapter). */
export function pinSdkBase(openApi: BaseHolder): BasePin {
  const origin = openApi.BASE;
  const ignored: string[] = [];
  Object.defineProperty(openApi, 'BASE', {
    configurable: true,
    enumerable: true,
    get: () => origin,
    set: (value: unknown) => {
      const text = String(value).slice(0, 200);
      if (text !== origin && !ignored.includes(text) && ignored.length < 16) ignored.push(text);
    },
  });
  return {
    ignored,
    release() {
      Object.defineProperty(openApi, 'BASE', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: origin,
      });
    },
  };
}

export interface SdkCall {
  readonly method: string;
  readonly outcome: 'RESOLVED' | 'REJECTED' | 'PENDING';
  /** HTTP status of a rejected call when the SDK reported one. */
  readonly status: number | null;
  /** RouteSpec error code of a rejected call when the answer carried one. */
  readonly code: string | null;
}

export interface SdkObservation {
  readonly calls: SdkCall[];
  /** Resolves when no SDK call is in flight and none has started or ended for `idleMs`. */
  settled(options: { idleMs: number; timeoutMs: number }): Promise<'SETTLED' | 'TIMEOUT'>;
  restore(): void;
}

type Service = Record<string, unknown>;

/** Record every call of a static method on the official SDK service class. */
export function observeSdkCalls(service: object): SdkObservation {
  const target = service as Service;
  const originals = new Map<string, unknown>();
  const calls: Array<{ -readonly [K in keyof SdkCall]: SdkCall[K] }> = [];
  let inFlight = 0;
  let lastActivity = Date.now();
  for (const name of Object.getOwnPropertyNames(target)) {
    const original = target[name];
    if (typeof original !== 'function' || name === 'prototype') continue;
    originals.set(name, original);
    target[name] = function observed(this: unknown, ...args: unknown[]): unknown {
      const call: (typeof calls)[number] = { method: name, outcome: 'PENDING', status: null, code: null };
      if (calls.length < 200) calls.push(call);
      inFlight++;
      lastActivity = Date.now();
      const done = (outcome: 'RESOLVED' | 'REJECTED', error?: unknown) => {
        call.outcome = outcome;
        if (outcome === 'REJECTED') {
          const e = (error ?? {}) as { status?: unknown; body?: { error?: { code?: unknown } } | null };
          call.status = typeof e.status === 'number' ? e.status : null;
          const code = e.body?.error?.code;
          call.code = typeof code === 'string' ? code.slice(0, 64) : null;
        }
        inFlight--;
        lastActivity = Date.now();
      };
      const result = (original as (...a: unknown[]) => unknown).apply(this, args);
      if (
        result !== null &&
        typeof result === 'object' &&
        typeof (result as Promise<unknown>).then === 'function'
      ) {
        // The example keeps the SDK's own promise; this only watches it.
        (result as Promise<unknown>).then(
          () => done('RESOLVED'),
          (error: unknown) => done('REJECTED', error),
        );
      } else {
        done('RESOLVED');
      }
      return result;
    };
  }
  return {
    calls,
    async settled({ idleMs, timeoutMs }) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (inFlight === 0 && Date.now() - lastActivity >= idleMs) return 'SETTLED';
        if (Date.now() >= deadline) return 'TIMEOUT';
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    restore() {
      for (const [name, original] of originals) target[name] = original;
    },
  };
}

export interface ConsoleCapture {
  readonly lines: Array<{ stream: 'log' | 'error'; text: string }>;
  restore(): void;
}

/** Record the first lines the example prints (bounded), still writing them to the real console. */
export function captureConsole(maxLines = 40, maxChars = 240): ConsoleCapture {
  const lines: ConsoleCapture['lines'] = [];
  const original = { log: console.log, error: console.error };
  const tap =
    (stream: 'log' | 'error') =>
    (...args: unknown[]): void => {
      if (lines.length < maxLines) {
        const text = args
          .map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.name}: ${a.message}` : typeof a))
          .join(' ');
        lines.push({ stream, text: text.slice(0, maxChars) });
      }
      original[stream].apply(console, args);
    };
  console.log = tap('log');
  console.error = tap('error');
  return {
    lines,
    restore() {
      console.log = original.log;
      console.error = original.error;
    },
  };
}
