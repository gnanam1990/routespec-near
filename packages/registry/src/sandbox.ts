/**
 * near-sandbox harness for the registry suites (M47). Test support only: nothing in the product
 * imports this entry.
 *
 * It starts a local NEAR sandbox node inside a Linux container (the nearcore sandbox binary has
 * no Windows build), publishes its JSON-RPC on a loopback port of the host, and offers the few
 * real transactions the suites need: create an account, deploy the registry wasm, initialise it.
 * Everything is local; nothing here can reach NEAR testnet or mainnet.
 *
 * The engine command comes from `ROUTESPEC_CONTAINER_CLI` (see
 * docs/runbooks/container-containment.md). The image is pinned by digest and never pulled. The
 * nearcore sandbox archive is downloaded inside the container on first use, checked against a
 * pinned SHA-256, and cached under `.data/registry/sandbox-cache`.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { containerCliFromEnv, enginePath, runEngine, type ContainerCli } from '@routespec/containment';
import { signerFromSecret, type Ed25519Signer } from './keys.ts';
import { jsonArgs, NearRpc, type NearAction } from './near.ts';
import { REGISTRY_CALL_GAS } from './registry-client.ts';

export const SANDBOX_IMAGE =
  'node:22-trixie-slim@sha256:68c76cfad89921b927eae28ba21407475e29d0ce450afcdbe70c1532db042b64';
export const SANDBOX_ROOT_ACCOUNT = 'test.near';
const ONE_NEAR = 10n ** 24n;

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CONTAINER_SCRIPTS = resolve(REPO_ROOT, 'scripts', 'registry');
const WASM_PATH = resolve(
  REPO_ROOT,
  'contracts',
  'routespec-registry',
  'target',
  'wasm32-unknown-unknown',
  'release',
  'routespec_registry.wasm',
);

export interface SandboxAccount {
  readonly accountId: string;
  readonly signer: Ed25519Signer;
}

export interface SandboxInfo {
  readonly rpcUrl: string;
  readonly containerName: string;
  /** NEAR-format secret of the sandbox validator account; exists only while the container does. */
  readonly rootSecret: string;
}

export type SandboxRuntime =
  | { readonly available: true; readonly cli: ContainerCli }
  | { readonly available: false; readonly reason: string };

/** Whether a Linux container engine and the pinned image are available. Never pulls. */
export async function detectSandboxRuntime(): Promise<SandboxRuntime> {
  let cli: ContainerCli;
  try {
    cli = containerCliFromEnv();
  } catch {
    return { available: false, reason: 'CONTAINER_CLI_INVALID' };
  }
  const version = await runEngine(cli, ['version', '--format', '{{.Server.Os}}'], 30_000);
  if (version.exitCode !== 0) {
    return { available: false, reason: `CONTAINER_RUNTIME_ABSENT (${version.spawnError ?? 'no engine'})` };
  }
  if (version.stdout.trim() !== 'linux') return { available: false, reason: 'CONTAINER_RUNTIME_UNSUPPORTED' };
  const image = await runEngine(cli, ['image', 'inspect', '--format', '{{.Id}}', SANDBOX_IMAGE], 30_000);
  if (image.exitCode !== 0)
    return { available: false, reason: 'CONTAINER_IMAGE_ABSENT (node:22-trixie-slim)' };
  return { available: true, cli };
}

async function rpcReady(rpcUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${rpcUrl}/status`, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Start the sandbox container and wait until its RPC answers on `127.0.0.1:<port>`. */
export async function startSandbox(cli: ContainerCli, port: number): Promise<SandboxInfo> {
  const cache = resolve(REPO_ROOT, '.data', 'registry', 'sandbox-cache');
  mkdirSync(cache, { recursive: true });
  const containerName = `routespec-registry-sandbox-${String(process.pid)}-${String(port)}`;
  const rpcUrl = `http://127.0.0.1:${String(port)}`;
  if (await rpcReady(rpcUrl)) throw new Error(`port ${String(port)} is already in use`);
  const started = await runEngine(
    cli,
    [
      'run',
      '--detach',
      '--rm',
      '--pull=never',
      '--name',
      containerName,
      '--publish',
      `127.0.0.1:${String(port)}:3030`,
      '--volume',
      `${enginePath(cli, CONTAINER_SCRIPTS)}:/routespec:ro`,
      '--volume',
      `${enginePath(cli, cache)}:/cache`,
      SANDBOX_IMAGE,
      'node',
      '/routespec/sandbox-container.mjs',
    ],
    60_000,
  );
  if (started.exitCode !== 0)
    throw new Error(`sandbox container did not start: ${started.stderr.slice(-400)}`);
  follow(cli, containerName);
  const deadline = Date.now() + 240_000;
  for (;;) {
    if (await rpcReady(rpcUrl)) break;
    const state = await runEngine(cli, ['inspect', '--format', '{{.State.Running}}', containerName], 15_000);
    if (state.exitCode !== 0 || state.stdout.trim() !== 'true' || Date.now() > deadline) {
      const logs = await runEngine(cli, ['logs', '--tail', '20', containerName], 15_000);
      await stopSandbox(cli, containerName);
      throw new Error(`sandbox node is not reachable: ${`${logs.stdout}${logs.stderr}`.slice(-600)}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const key = await runEngine(cli, ['exec', containerName, 'cat', '/sandbox/validator_key.json'], 15_000);
  if (key.exitCode !== 0) {
    await stopSandbox(cli, containerName);
    throw new Error('sandbox validator key is not readable');
  }
  const parsed = JSON.parse(key.stdout) as { account_id?: string; secret_key?: string };
  if (parsed.account_id !== SANDBOX_ROOT_ACCOUNT || typeof parsed.secret_key !== 'string') {
    await stopSandbox(cli, containerName);
    throw new Error('sandbox validator key has an unexpected shape');
  }
  return { rpcUrl, containerName, rootSecret: parsed.secret_key };
}

const followers = new Map<string, ChildProcess>();

/**
 * Keep one engine client attached to the container while the suite runs. With Docker Engine
 * inside WSL 2 the distribution can be stopped when no client session is open, which would take
 * the detached sandbox node with it in the middle of a run (seen twice while building M47).
 */
function follow(cli: ContainerCli, containerName: string): void {
  const [program, ...lead] = cli.argv as [string, ...string[]];
  const child = spawn(program, [...lead, 'logs', '--follow', '--tail', '0', containerName], {
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () => undefined);
  followers.set(containerName, child);
}

/** Remove the container this harness started (by its exact name). */
export async function stopSandbox(cli: ContainerCli, containerName: string): Promise<void> {
  if (!/^routespec-registry-sandbox-\d+-\d+$/.test(containerName)) return;
  followers.get(containerName)?.kill();
  followers.delete(containerName);
  await runEngine(cli, ['rm', '--force', containerName], 60_000);
}

export function sandboxRoot(info: Pick<SandboxInfo, 'rootSecret'>): SandboxAccount {
  return { accountId: SANDBOX_ROOT_ACCOUNT, signer: signerFromSecret(info.rootSecret) };
}

/** Create `accountId` (a sub-account of the payer) with one full-access key and a balance. */
export async function createAccount(
  rpc: NearRpc,
  payer: SandboxAccount,
  account: SandboxAccount,
  near = 20n,
): Promise<void> {
  await rpc.sendActions({
    signerId: payer.accountId,
    signer: payer.signer,
    receiverId: account.accountId,
    actions: [
      { type: 'CreateAccount' },
      { type: 'Transfer', deposit: near * ONE_NEAR },
      { type: 'AddFullAccessKey', publicKey: account.signer.publicKey },
    ],
  });
}

/** Deploy the registry wasm to `registry` and initialise it in the same transaction. */
export async function deployRegistry(
  rpc: NearRpc,
  registry: SandboxAccount,
  wasm: Uint8Array,
  ownerId: string,
): Promise<void> {
  const actions: NearAction[] = [
    { type: 'DeployContract', code: wasm },
    {
      type: 'FunctionCall',
      methodName: 'new',
      args: jsonArgs({ owner_id: ownerId }),
      gas: REGISTRY_CALL_GAS,
      deposit: 0n,
    },
  ];
  await rpc.sendActions({
    signerId: registry.accountId,
    signer: registry.signer,
    receiverId: registry.accountId,
    actions,
  });
}

/**
 * Path of the registry wasm under test. `ROUTESPEC_REGISTRY_WASM` names an already built
 * artifact (for example the reproducible build); otherwise the contract is built here with the
 * locked dependencies through `scripts/registry/build.mjs`.
 */
export function registryWasmPath(): string {
  const configured = process.env['ROUTESPEC_REGISTRY_WASM'];
  if (configured !== undefined && configured !== '') {
    const path = resolve(configured);
    if (!existsSync(path)) throw new Error('ROUTESPEC_REGISTRY_WASM does not name a file');
    return path;
  }
  const built = spawnSync(process.execPath, [resolve(REPO_ROOT, 'scripts', 'registry', 'build.mjs')], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (built.status !== 0 || !existsSync(WASM_PATH)) {
    throw new Error(`registry wasm build failed: ${`${built.stdout}${built.stderr}`.slice(-600)}`);
  }
  return WASM_PATH;
}

interface WasmApi {
  readonly Module: {
    new (bytes: Uint8Array): object;
    exports(module: object): Array<{ name: string; kind: string }>;
    imports(module: object): Array<{ module: string; name: string; kind: string }>;
  };
}

/** The exported function names and imported host function names of a wasm module, sorted. */
export function wasmInterface(wasm: Uint8Array): { exports: string[]; imports: string[] } {
  const api = (globalThis as unknown as { WebAssembly: WasmApi }).WebAssembly;
  const module = new api.Module(wasm);
  return {
    exports: api.Module.exports(module)
      .filter((e) => e.kind === 'function')
      .map((e) => e.name)
      .sort(),
    imports: api.Module.imports(module)
      .map((i) => i.name)
      .sort(),
  };
}

/** What the suite's global setup provides to every test file (`inject('registrySandbox')`). */
export type RegistrySandboxContext =
  | { readonly available: false; readonly reason: string }
  | {
      readonly available: true;
      readonly rpcUrl: string;
      readonly rootSecret: string;
      readonly wasmPath: string;
    };

declare module 'vitest' {
  export interface ProvidedContext {
    registrySandbox: RegistrySandboxContext;
  }
}
