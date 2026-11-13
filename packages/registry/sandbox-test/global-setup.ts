/**
 * Starts one near-sandbox node (in a container) for the registry suite and builds the registry
 * wasm once. Test files read both through `inject('registrySandbox')`.
 */
import type { TestProject } from 'vitest/node';
import { detectSandboxRuntime, registryWasmPath, startSandbox, stopSandbox } from '../src/sandbox.ts';

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

export default async function setup(project: TestProject): Promise<(() => Promise<void>) | void> {
  const runtime = await detectSandboxRuntime();
  if (!runtime.available) {
    project.provide('registrySandbox', { available: false, reason: runtime.reason });
    return;
  }
  const wasmPath = registryWasmPath();
  const port = Number(process.env['ROUTESPEC_REGISTRY_SANDBOX_PORT'] ?? '9501');
  const info = await startSandbox(runtime.cli, port);
  project.provide('registrySandbox', {
    available: true,
    rpcUrl: info.rpcUrl,
    rootSecret: info.rootSecret,
    wasmPath,
  });
  return async () => {
    await stopSandbox(runtime.cli, info.containerName);
  };
}
