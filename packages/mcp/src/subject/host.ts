/**
 * Subject host process: loads the client module named by argv[2] (a file path, never a shell
 * string) and serves its default `ClientJob` over the inherited IPC channel. A module without a
 * function default export is reported as an `error` message and the process exits.
 */
import { pathToFileURL } from 'node:url';
import { runSubject, type ClientJob } from './runtime.ts';

const entry = process.argv[2];
try {
  if (entry === undefined)
    throw Object.assign(new Error('no client module'), { code: 'CLIENT_MODULE_MISSING' });
  const mod = (await import(pathToFileURL(entry).href)) as { default?: unknown };
  if (typeof mod.default !== 'function') {
    throw Object.assign(new Error('the client module has no default export function'), {
      code: 'CLIENT_MODULE_NO_DEFAULT_JOB',
    });
  }
  runSubject(mod.default as ClientJob);
} catch (error) {
  process.send?.({
    type: 'error',
    code: (error as { code?: string }).code ?? 'CLIENT_MODULE_LOAD_FAILED',
    message: String(error).slice(0, 400),
  });
  process.disconnect?.();
}
