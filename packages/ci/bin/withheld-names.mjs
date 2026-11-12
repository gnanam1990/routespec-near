#!/usr/bin/env node
// Prints, one per line, the names of the step-environment variables the gate withholds (names
// only, never values). The composite action's step shell removes them before it starts the entry
// point, so they never reach the action process's environment block.
import { withheldNames } from '../src/secrets.ts';

for (const name of withheldNames(process.env)) process.stdout.write(`${name}\n`);
