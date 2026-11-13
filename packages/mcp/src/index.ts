/**
 * @routespec/mcp — the RouteSpec MCP server for coding agents (M52).
 */
export {
  serveMcp,
  SERVER_NAME,
  SERVER_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  SERVER_INSTRUCTIONS,
} from './server.ts';
export { RouteSpecTools, TOOL_DEFINITIONS, type ToolResult, type ServerOptions } from './tools.ts';
export {
  runGate,
  DEFAULT_SCENARIOS,
  REQUIRED_INVARIANTS,
  SCENARIO_SOURCES,
  type GateRunRecord,
} from './gate.ts';
export { buildFindings, type FindingsReport } from './findings.ts';
export { INVARIANTS, FIX_PATTERNS, explainInvariant } from './knowledge.ts';
export { runMcpMain, parseMcpArgs } from './main.ts';
export type { ClientJob, ClientContext, ClientRequest } from './subject/runtime.ts';
