#!/usr/bin/env node
// RouteSpec CI entry shim: runs the TypeScript entry with Node's built-in type stripping.
import { runCiMain } from '../src/main.ts';

await runCiMain();
