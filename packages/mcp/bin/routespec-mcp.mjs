#!/usr/bin/env node
// RouteSpec MCP server launcher shim: runs the TypeScript entry with Node's built-in type stripping.
import { runMcpMain } from '../src/main.ts';

await runMcpMain(process.argv.slice(2));
