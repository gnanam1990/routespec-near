/**
 * Scripted coding agent session (M52 demo).
 *
 * It plays the part of a coding agent that follows `../SKILL.md`, talking to the real RouteSpec
 * MCP server (`routespec mcp`, a separate process on stdio) the way an agent's MCP client does:
 *
 *   1. the working copy `swap-client.ts` holds the naive client; the agent runs the gate (FAIL);
 *   2. it lists the findings and asks for the first fix pattern they name;
 *   3. it applies the pattern: the working copy becomes the reconciling client (the edit is
 *      scripted, and recorded as a diff);
 *   4. it runs the gate again (PASS).
 *
 * The agent's decisions are scripted; every gate run and every verdict is real. The session is
 * written as Markdown to --out. Only paths relative to the session workspace are recorded.
 *
 * usage: node --no-warnings examples/agent-skill/demo/agent-session.ts --out <file.md>
 * exit:  0 when the first run FAILed and the run after the fix PASSed, 1 otherwise
 */
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

type J = Record<string, unknown>;

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CLI = fileURLToPath(new URL('../../../packages/cli/bin/routespec.mjs', import.meta.url));
const NAIVE = join(HERE, 'swap-client.naive.ts');
const FIXED = join(HERE, 'swap-client.fixed.ts');
const WORKING = 'swap-client.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Line diff (longest common subsequence), unified-style without hunk headers. */
export function lineDiff(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push(`  ${a[i] as string}`);
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      out.push(`+ ${b[j] as string}`);
      j++;
    } else {
      out.push(`- ${a[i] as string}`);
      i++;
    }
  }
  return out.join('\n');
}

class Session {
  private readonly child;
  private buffer = '';
  private id = 1;
  private readonly waiting = new Map<number, (m: J) => void>();
  readonly log: string[] = [];

  constructor(root: string) {
    this.child = spawn(process.execPath, ['--no-warnings', CLI, 'mcp', '--root', root], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.child.stdout.on('data', (c: Buffer) => {
      this.buffer += c.toString('utf8');
      let k: number;
      while ((k = this.buffer.indexOf('\n')) >= 0) {
        const msg = JSON.parse(this.buffer.slice(0, k)) as J;
        this.buffer = this.buffer.slice(k + 1);
        this.waiting.get(msg['id'] as number)?.(msg);
      }
    });
  }

  request(method: string, params: J): Promise<J> {
    const id = this.id++;
    const p = new Promise<J>((r) => this.waiting.set(id, r));
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return p;
  }

  notify(method: string): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }

  async tool(name: string, args: J): Promise<{ text: string; data: J }> {
    const started = Date.now();
    const r = await this.request('tools/call', { name, arguments: args });
    const result = r['result'] as { content: Array<{ text: string }>; structuredContent: J };
    const text = result.content[0]?.text ?? '';
    this.log.push(
      `**Agent → \`${name}\`** \`${JSON.stringify(args)}\`  \n_${String(Date.now() - started)} ms_\n\n` +
        `\`\`\`text\n${text.length > 6_000 ? `${text.slice(0, 6_000)}\n… (truncated)` : text}\n\`\`\`\n`,
    );
    return { text, data: result.structuredContent };
  }

  close(): Promise<void> {
    this.child.stdin.end();
    return new Promise((r) => this.child.on('close', () => r()));
  }
}

export async function runSession(): Promise<{ markdown: string; first: string; second: string }> {
  const root = mkdtempSync(join(tmpdir(), 'routespec-agent-session-'));
  const session = new Session(root);
  try {
    copyFileSync(NAIVE, join(root, WORKING));
    const say = (text: string) => session.log.push(`> ${text.split('\n').join('\n> ')}\n`);
    const init = await session.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'scripted-coding-agent', version: '1.0.0' },
    });
    session.notify('notifications/initialized');
    const info = (init['result'] as J)['serverInfo'] as J;
    session.log.push(`Connected to MCP server \`${String(info['name'])}\` ${String(info['version'])}.\n`);

    say(
      `The task changed \`${WORKING}\`, which calls the 1Click SDK. The skill says: run the gate before shipping.`,
    );
    const first = await session.tool('run_gate', { client: WORKING });
    const firstDecision = String(first.data['decision']);

    say(`The gate says ${firstDecision}. Listing the findings.`);
    const findings = await session.tool('list_findings', {});
    const patterns = (findings.data['nextFixPatterns'] as string[] | undefined) ?? [];
    const pattern = patterns[0];
    if (pattern === undefined) throw new Error('no fix pattern named');

    say(`The first finding names \`${pattern}\`. Reading it.`);
    await session.tool('show_fix_pattern', { pattern });

    say(
      'Applying the reconcile pattern: no second order while the first is unanswered; read the same order to a terminal status; wait for reconciliation authority after a lost answer.',
    );
    const before = readFileSync(join(root, WORKING), 'utf8');
    const after = readFileSync(FIXED, 'utf8');
    writeFileSync(join(root, WORKING), after);
    session.log.push(`**Agent edits \`${WORKING}\`:**\n\n\`\`\`diff\n${lineDiff(before, after)}\n\`\`\`\n`);

    say('Running the gate again on the changed client.');
    const second = await session.tool('run_gate', { client: WORKING });
    const secondDecision = String(second.data['decision']);
    say(
      secondDecision === 'PASS'
        ? `PASS on every scenario (${String(first.data['runId'])} FAIL, ${String(second.data['runId'])} PASS). This run was uncontained and diagnostic, not release evidence.`
        : `Still ${secondDecision}; not done.`,
    );

    const markdown = [
      '# Recorded coding agent session: RouteSpec gate, fix, gate',
      '',
      'Recorded by `examples/agent-skill/demo/agent-session.ts`. The agent part (what to call and',
      'the edit) is scripted; the MCP server, the gate runs, the official SDK client processes and',
      'every verdict are real. Durations, identifiers and digests are those of this recording.',
      '',
      `Result: first run **${firstDecision}**, run after the fix **${secondDecision}**.`,
      '',
      ...session.log,
    ].join('\n');
    return { markdown, first: firstDecision, second: secondDecision };
  } finally {
    await session.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const out = arg('out');
  const r = await runSession();
  if (out !== undefined) writeFileSync(out, r.markdown.endsWith('\n') ? r.markdown : `${r.markdown}\n`);
  else process.stdout.write(r.markdown);
  process.stderr.write(`agent session: first ${r.first}, after fix ${r.second}\n`);
  process.exitCode = r.first === 'FAIL' && r.second === 'PASS' ? 0 : 1;
}
