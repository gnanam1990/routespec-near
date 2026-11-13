/**
 * M52 — the coding agent skill and its demo.
 *
 * The skill file names only tools the server provides and only files that exist; the scripted
 * agent session runs against the real MCP server and records FAIL before the fix and PASS
 * after it without any local path; the shell fallback exits with the gate's own exit code.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSession } from '../../../examples/agent-skill/demo/agent-session.ts';
import { TOOL_DEFINITIONS } from '../src/tools.ts';
import { SCENARIO_SOURCES } from '../src/gate.ts';
import { FIX_PATTERNS } from '../src/knowledge.ts';
import { REPO_ROOT } from './support/mcp-client.ts';

const SKILL_DIR = join(REPO_ROOT, 'examples', 'agent-skill');
const skill = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');

describe('SKILL.md', () => {
  it('has name and description front matter that states the rule', () => {
    const front = /^---\nname: ([a-z0-9-]+)\ndescription: (.+)\n---\n/.exec(skill);
    expect(front?.[1]).toBe('routespec-gate');
    expect(front?.[2]).toMatch(/run the RouteSpec gate/);
    expect(front?.[2]).toMatch(/reconcile pattern/);
    expect(skill).toMatch(
      /\*\*Before shipping 1Click code, run the gate\. On FAIL, apply the reconcile pattern\.\*\*/,
    );
  });

  it('names every server tool, and only tools, patterns, scenarios and files that exist', () => {
    const tools = TOOL_DEFINITIONS.map((t) => t.name);
    for (const t of tools) expect(skill).toContain(`\`${t}\``);
    const snake = [...skill.matchAll(/`([a-z]+_[a-z_]+)`/g)].map((m) => m[1] as string);
    for (const name of snake) expect(tools, name).toContain(name);
    const kebab = [...skill.matchAll(/`([a-z]+(?:-[a-z]+){2,})`/g)].map((m) => m[1] as string);
    for (const name of kebab) {
      expect([...Object.keys(FIX_PATTERNS), ...Object.keys(SCENARIO_SOURCES)], name).toContain(name);
    }
    for (const file of [...skill.matchAll(/`((?:demo\/)?[A-Za-z.-]+\.(?:ts|md))`/g)].map(
      (m) => m[1] as string,
    )) {
      expect(existsSync(join(SKILL_DIR, file)), file).toBe(true);
    }
  });
});

describe('demo', () => {
  it(
    'the scripted agent session records FAIL, the fix, and PASS, with no local path',
    { timeout: 240_000 },
    async () => {
      const r = await runSession();
      expect([r.first, r.second]).toEqual(['FAIL', 'PASS']);
      expect(r.markdown).toMatch(
        /Agent → `run_gate`[\s\S]*Gate FAIL[\s\S]*`list_findings`[\s\S]*`show_fix_pattern`[\s\S]*```diff[\s\S]*Gate PASS/,
      );
      expect(r.markdown).toMatch(/INV03_SECOND_MUTATION_UNDER_UNCERTAINTY/);
      expect(r.markdown).not.toMatch(/[A-Za-z]:[\\/]|\/tmp\/|\/home\/|\/Users\//);
    },
  );

  it('the committed transcript is a recording of the same session', () => {
    const t = readFileSync(join(SKILL_DIR, 'demo', 'TRANSCRIPT.md'), 'utf8');
    expect(t).toMatch(/first run \*\*FAIL\*\*, run after the fix \*\*PASS\*\*/);
    expect(t).toMatch(/INV03_SECOND_MUTATION_UNDER_UNCERTAINTY/);
    expect(t).not.toMatch(/[A-Za-z]:[\\/]|\/tmp\/|\/home\/|\/Users\//);
  });

  it(
    'the shell fallback prints one JSON document and exits with the gate exit code',
    { timeout: 240_000 },
    () => {
      const run = (client: string) =>
        spawnSync(
          process.execPath,
          ['--no-warnings', join(SKILL_DIR, 'gate.ts'), client, 'slow-deposit-answer'],
          {
            cwd: REPO_ROOT,
            encoding: 'utf8',
          },
        );
      const naive = run('examples/agent-skill/demo/swap-client.naive.ts');
      expect(naive.status).toBe(2);
      const out = JSON.parse(naive.stdout) as {
        run: { decision: string };
        findings: { nextFixPatterns: string[] };
      };
      expect(out.run.decision).toBe('FAIL');
      expect(out.findings.nextFixPatterns[0]).toBe('no-second-order-while-unanswered');
      const fixed = run('examples/agent-skill/demo/swap-client.fixed.ts');
      expect(fixed.status).toBe(0);
      expect((JSON.parse(fixed.stdout) as { run: { decision: string } }).run.decision).toBe('PASS');
      const none = spawnSync(process.execPath, ['--no-warnings', join(SKILL_DIR, 'gate.ts')], {
        encoding: 'utf8',
      });
      expect(none.status).toBe(4);
    },
  );
});
