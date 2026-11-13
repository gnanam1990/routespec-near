/**
 * `routespec mcp` / `routespec-mcp`: start the RouteSpec MCP server on stdio.
 *
 * usage: routespec mcp [--root <dir>] [--work <dir>]
 *   --root  files the tools may read (client modules, bundles) must be inside it (default: cwd)
 *   --work  where gate run journals are written (default: a fresh temporary directory)
 */
import { serveMcp } from './server.ts';

export function parseMcpArgs(argv: readonly string[]): { root: string; work?: string } {
  let root = process.cwd();
  let work: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag === '--root' || flag === '--work') && value !== undefined && !value.startsWith('--')) {
      if (flag === '--root') root = value;
      else work = value;
      i++;
    } else {
      throw new Error(`routespec mcp: unknown or incomplete option ${String(flag).slice(0, 40)}`);
    }
  }
  return work === undefined ? { root } : { root, work };
}

export async function runMcpMain(argv: readonly string[]): Promise<void> {
  let options: { root: string; work?: string };
  try {
    options = parseMcpArgs(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\nusage: routespec mcp [--root <dir>] [--work <dir>]\n`);
    process.exitCode = 4;
    return;
  }
  const server = serveMcp(process.stdin, process.stdout, {
    root: options.root,
    ...(options.work === undefined ? {} : { workDir: options.work }),
    log: (line) => process.stderr.write(`${line}\n`),
  });
  await server.closed;
}
