/**
 * Shell fallback of the MCP tools for coding agents without MCP support (M52): runs the gate on
 * one client module, then prints one JSON document with the run summary and its findings.
 *
 * usage: node --no-warnings examples/agent-skill/gate.ts <client module> [scenario ...]
 * exit:  0 PASS, 2 FAIL, 3 REVIEW or NOT_RUN, 4 input error
 */
import { RouteSpecTools } from '../../packages/mcp/src/tools.ts';

const [client, ...scenarios] = process.argv.slice(2);
if (client === undefined) {
  process.stderr.write(
    'usage: node --no-warnings examples/agent-skill/gate.ts <client module> [scenario ...]\n',
  );
  process.exit(4);
}
const tools = new RouteSpecTools({ root: process.cwd(), log: (l) => process.stderr.write(`${l}\n`) });
const run = await tools.call('run_gate', scenarios.length > 0 ? { client, scenarios } : { client });
if (run.isError && run.structuredContent['decision'] === undefined) {
  process.stdout.write(`${JSON.stringify(run.structuredContent)}\n`);
  process.exit(4);
}
const findings = await tools.call('list_findings', {});
process.stdout.write(
  `${JSON.stringify({ run: run.structuredContent, findings: findings.structuredContent })}\n`,
);
const decision = run.structuredContent['decision'];
process.exitCode = decision === 'PASS' ? 0 : decision === 'FAIL' ? 2 : 3;
