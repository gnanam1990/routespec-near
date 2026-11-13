/**
 * M51 — static policy for the scheduled fidelity-matrix workflow.
 *
 * The job may only run on a schedule or by manual dispatch, with read-only permissions (so a
 * failing run cannot open an issue, comment or pull request), with every third-party action
 * pinned to a commit, and with the provider JWT secret reaching exactly one step as an
 * environment variable and never a command line. This is a text audit of the committed file; the
 * job itself has not run on GitHub (see docs/status/M51.md).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  fileURLToPath(new URL('../../../.github/workflows/fidelity-matrix.yml', import.meta.url)),
  'utf8',
).replace(/\r\n/g, '\n');
const body = workflow
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');

describe('M51 fidelity-matrix workflow policy', () => {
  it('runs only on a schedule and on manual dispatch', () => {
    const on = body.slice(body.indexOf('\non:\n'), body.indexOf('\npermissions:'));
    expect(on).toMatch(/^\non:\n {2}schedule:\n {4}- cron: '[0-9*/, ]+'\n {2}workflow_dispatch:$/);
    expect(body).not.toMatch(/pull_request|push:|workflow_run|issue_comment/);
  });

  it('has read-only permissions and no step that could open an issue', () => {
    expect(body.match(/^permissions:\n {2}contents: read\n(?! )/m)).not.toBeNull();
    expect(body.match(/permissions:/g)).toHaveLength(1);
    expect(body).not.toMatch(/issues|pull-requests|: write|write-all|GITHUB_TOKEN|github\.token/);
    expect(body).not.toMatch(/\bgh (issue|pr|api)\b|github-script|create-issue/i);
  });

  it('pins every action to a full commit SHA', () => {
    const uses = [...body.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]!);
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) expect(ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });

  it('gives the secret to one step as an environment variable only', () => {
    const refs = body.split('\n').filter((line) => line.includes('secrets.'));
    expect(refs).toEqual(['          ROUTESPEC_PROVIDER_JWT: ${{ secrets.ROUTESPEC_PROVIDER_JWT }}']);
    const runLines = body.split('\n').filter((line) => /^\s+(run:|pnpm |echo |cat |\[ )/.test(line));
    for (const line of runLines) expect(line).not.toMatch(/ROUTESPEC_PROVIDER_JWT|\$\{\{/);
  });

  it('runs the matrix command with the explicit confirmation and no request-count override', () => {
    const commands = body.split('\n').filter((line) => line.includes('fidelity:matrix'));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('--confirm-official-endpoint');
    expect(commands[0]).not.toMatch(/--routes|--max-quotes/);
    expect(commands[0]).toContain('> /dev/null');
  });
});
