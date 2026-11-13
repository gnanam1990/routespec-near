/**
 * Test driver (M48): loads a fixture tree through the confined loader in a real Node process and
 * prints one JSON line. The fixture files are written by the test itself; no third-party code is
 * involved.
 *
 * argv: <pins file> <pin id> <dir>
 */
import { readFileSync } from 'node:fs';
import { loadPinnedEntry } from '../../../../examples/third-party/support/confined.ts';
import { parsePins, pinById } from '../../../../examples/third-party/support/pins.ts';

const [pinsFile, id, dir] = process.argv.slice(2) as [string, string, string];
const pin = pinById(id, parsePins(JSON.parse(readFileSync(pinsFile, 'utf8'))));
const marker = globalThis as { __m48Fixture?: unknown; __m48Late?: unknown };
try {
  const record = await loadPinnedEntry(pin, { dir, resolveFrom: import.meta.url });
  // Give an import the fixture makes after its first await time to be resolved or refused.
  await new Promise((r) => setTimeout(r, 400));
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      record,
      fixture: marker.__m48Fixture ?? null,
      late: marker.__m48Late ?? null,
    })}\n`,
  );
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      code: (error as { code?: string }).code ?? null,
      message: (error as Error).message,
      fixture: marker.__m48Fixture ?? null,
    })}\n`,
  );
}
