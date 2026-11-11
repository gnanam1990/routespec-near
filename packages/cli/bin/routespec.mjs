#!/usr/bin/env node
// RouteSpec CLI launcher shim: runs the TypeScript entry with Node's built-in type stripping.
import { runMain } from '../src/main.ts';

await runMain();
