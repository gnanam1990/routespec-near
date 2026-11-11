/**
 * T-040 — Path traversal and symlink escape are blocked. Covers FR-17, FR-18.
 *
 * Real product surfaces only: a real gate evaluation produced by the `routespec` CLI through
 * the reviewed launcher (proxy, journal, kernel, a separately launched official-SDK subject),
 * its export plan, `writeExport`, `verifyBundle`, the CLI `scenario validate` / `export verify`
 * commands, and the import pipeline. Every hostile path is aimed at a temporary tree that has an
 * `outside` directory next to the chosen targets; after each attempt the whole tree is listed
 * again and must be unchanged except for the one explicitly chosen target.
 *
 * Links: this host refuses unprivileged file and directory symbolic links (EPERM), so links are
 * exercised with NTFS junctions, which the product must treat as links. Where a sub-case needs
 * a file symbolic link and the host cannot create one, it is recorded as not run.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkLocalPathSyntax } from '@routespec/hardening';
import { importUserFile } from '@routespec/regressions';
import { planExport, verifyBundle, writeExport } from '@routespec/runner';
import { GateJournal, RouteSpecStore } from '@routespec/store';
import { runCliProcess, runGateWithSubjects, setupJournal, tempDir } from '../../cli/test/support/product.ts';
import { rawTar } from './support/tar.ts';

let tmp: ReturnType<typeof tempDir>;
let dataDir = '';
let work = '';
let outside = '';
let gateEvaluationId = '';
let store: RouteSpecStore;
let projectId = '';
let planDigest = '';
let exportId = '';
let keyN = 0;
const key = () => `t040-key-${process.pid}-${++keyN}`;

/** Every path under `root` (relative, sorted), so an unexpected write anywhere is visible. */
function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const full = join(d, n);
      out.push(relative(root, full).split('\\').join('/'));
      let st;
      try {
        st = statSync(full);
      } catch {
        continue; // dangling junction
      }
      if (st.isDirectory()) walk(full);
    }
  };
  walk(root);
  return out;
}

function junction(target: string, at: string): void {
  symlinkSync(target, at, 'junction');
}

function canFileSymlink(dir: string): boolean {
  const target = join(dir, 'probe-target.txt');
  writeFileSync(target, 'x');
  try {
    symlinkSync(target, join(dir, 'probe-link.txt'), 'file');
    rmSync(join(dir, 'probe-link.txt'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(target, { force: true });
  }
}

beforeAll(async () => {
  tmp = tempDir('routespec-t040-');
  dataDir = join(tmp.dir, 'data');
  work = join(tmp.dir, 'work');
  outside = join(tmp.dir, 'outside');
  mkdirSync(work);
  mkdirSync(outside);
  writeFileSync(join(outside, 'sentinel.txt'), 'outside the chosen target');
  const j = setupJournal(dataDir, { scenarios: ['happy-path'], build: 'reconciling-client', label: 't040' });
  projectId = j.projectId;
  const r = await runGateWithSubjects(j);
  expect(r.exitCode).toBe(0);
  gateEvaluationId = (r.json?.['report'] as { gateEvaluationId: string }).gateEvaluationId;
  store = RouteSpecStore.open({ path: join(dataDir, 'journal.db') });
  const plan = planExport(store, gateEvaluationId, { idempotencyKey: key() });
  expect(plan.blocked).toBe(false);
  planDigest = plan.planDigest;
  exportId = plan.exportId;
}, 180_000);

afterAll(() => {
  store?.close();
  tmp?.cleanup();
});

function attemptWrite(outPath: string, overwrite = false): { code: string | null; rule: string | null } {
  try {
    writeExport(store, exportId, { outPath, confirm: planDigest, overwrite, idempotencyKey: key() });
    return { code: null, rule: null };
  } catch (error) {
    const e = error as { code?: string; details?: { rule?: string } };
    return { code: e.code ?? 'THROWN', rule: e.details?.rule ?? null };
  }
}

describe('T-040 — Path traversal and symlink escape are blocked', () => {
  it('local output paths: hostile syntax is refused before any file-system write', () => {
    const before = tree(tmp.dir);
    const hostile: Array<[string, string]> = [
      ['\\\\routespec-t040.invalid\\share\\bundle.tar', 'NETWORK_PATH'],
      ['//routespec-t040.invalid/share/bundle.tar', 'NETWORK_PATH'],
      [`\\\\?\\${join(work, 'bundle.tar')}`, 'DEVICE_NAMESPACE'],
      ['\\\\.\\pipe\\routespec-t040', 'DEVICE_NAMESPACE'],
      ['\\??\\C:\\routespec-t040.tar', 'DEVICE_NAMESPACE'],
      ['C:routespec-t040.tar', 'DRIVE_RELATIVE'],
      [`${join(work, 'bundle.tar')}:hidden`, 'ALTERNATE_DATA_STREAM'],
      [join(work, 'NUL'), 'RESERVED_DEVICE_NAME'],
      [join(work, 'con.tar'), 'RESERVED_DEVICE_NAME'],
      [join(work, 'COM1.json'), 'RESERVED_DEVICE_NAME'],
      [join(work, 'aux', 'bundle.tar'), 'RESERVED_DEVICE_NAME'],
      [`${join(work, 'bundle.tar')}.`, 'TRAILING_DOT_OR_SPACE'],
      [`${join(work, 'bundle.tar')} `, 'TRAILING_DOT_OR_SPACE'],
      [join(work, 'bun\u0000dle.tar'), 'CONTROL_CHARACTER'],
      [join(work, 'bundle\u202erat.json'), 'BIDI_CHARACTER'],
      [`${work}\\${'a'.repeat(1100)}.tar`, 'TOO_LONG'],
    ];
    const results = hostile.map(([p, rule]) => ({ p, rule, got: attemptWrite(p) }));
    for (const r of results) {
      expect.soft(r.got, `path rule ${r.rule}`).toEqual({ code: 'RS_EXPORT_PATH_INVALID', rule: r.rule });
    }
    // The syntax policy is the same pure function on every platform.
    for (const [p, rule] of hostile) expect(checkLocalPathSyntax(p)).toEqual({ ok: false, rule });
    expect(tree(tmp.dir)).toEqual(before);
  });

  it('a network path is refused without waiting on name resolution or an SMB connection', () => {
    const started = Date.now();
    expect(attemptWrite('\\\\192.0.2.1\\share\\bundle.tar').code).toBe('RS_EXPORT_PATH_INVALID');
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('links at the final component are refused, dangling ones included; the target never changes', () => {
    const victimDir = join(outside, 'victim-dir');
    mkdirSync(victimDir);
    junction(victimDir, join(work, 'to-outside.tar'));
    const gone = join(outside, 'gone');
    mkdirSync(gone);
    junction(gone, join(work, 'dangling.tar'));
    rmSync(gone, { recursive: true });
    const before = tree(tmp.dir);
    expect(attemptWrite(join(work, 'to-outside.tar'))).toEqual({
      code: 'RS_EXPORT_PATH_INVALID',
      rule: 'LINK',
    });
    expect(attemptWrite(join(work, 'to-outside.tar'), true)).toEqual({
      code: 'RS_EXPORT_PATH_INVALID',
      rule: 'LINK',
    });
    expect(attemptWrite(join(work, 'dangling.tar'))).toEqual({
      code: 'RS_EXPORT_PATH_INVALID',
      rule: 'LINK',
    });
    expect(attemptWrite(join(work, 'dangling.tar'), true)).toEqual({
      code: 'RS_EXPORT_PATH_INVALID',
      rule: 'LINK',
    });
    expect(tree(tmp.dir)).toEqual(before);
    expect(readdirSync(victimDir)).toEqual([]);
    expect(existsSync(gone)).toBe(false);
    rmSync(join(work, 'to-outside.tar'));
    rmSync(join(work, 'dangling.tar'));
    rmSync(victimDir, { recursive: true });
  });

  it('a file symbolic link at the final component is refused (needs an unprivileged file link)', (ctx) => {
    if (!canFileSymlink(work)) {
      ctx.skip(); // NOT_RUN on this host: file symbolic links need Developer Mode or elevation.
      return;
    }
    const victim = join(outside, 'victim.txt');
    writeFileSync(victim, 'victim');
    symlinkSync(victim, join(work, 'link.tar'), 'file');
    expect(attemptWrite(join(work, 'link.tar'), true).code).toBe('RS_EXPORT_PATH_INVALID');
    expect(readFileSync(victim, 'utf8')).toBe('victim');
  });

  it('a valid explicit target receives exactly one file; overwrite needs its own confirmation', () => {
    const chosen = join(work, 'sub', '..', 'bundle.tar'); // separators and dot segments resolve to one target
    const before = tree(tmp.dir);
    expect(attemptWrite(chosen)).toEqual({ code: null, rule: null });
    expect(tree(tmp.dir)).toEqual([...before, 'work/bundle.tar'].sort());
    expect(attemptWrite(chosen)).toEqual({ code: 'RS_EXPORT_OVERWRITE_DENIED', rule: null });
    expect(attemptWrite(chosen, true)).toEqual({ code: null, rule: null });
    expect(tree(tmp.dir)).toEqual([...before, 'work/bundle.tar'].sort());
    const gates = new GateJournal(store);
    expect(gates.getExportPlan(exportId).planDigest).toBe(planDigest);
  });

  it('archive entries cannot escape, alias, or name devices during disposable extraction', () => {
    const ok = { name: 'manifest.json', content: '{}' };
    const hostile: Array<[string, Parameters<typeof rawTar>[0]]> = [
      ['dot-dot', [ok, { name: '../escaped.json', content: 'x' }]],
      ['nested dot-dot', [ok, { name: 'a/../../escaped.json', content: 'x' }]],
      ['absolute', [ok, { name: '/escaped.json', content: 'x' }]],
      ['drive', [ok, { name: 'c:/escaped.json', content: 'x' }]],
      ['backslash', [ok, { name: 'a\\..\\..\\escaped.json', content: 'x' }]],
      ['unc', [ok, { name: '//host/share/escaped.json', content: 'x' }]],
      ['device nul', [ok, { name: 'nul', content: 'x' }]],
      ['device con.json', [ok, { name: 'con.json', content: 'x' }]],
      ['device in directory', [ok, { name: 'aux/report.json', content: 'x' }]],
      ['device com1', [ok, { name: 'reports/com1.txt', content: 'x' }]],
      ['trailing dot alias', [ok, { name: 'manifest.json.', content: 'x' }]],
      ['trailing dot directory', [ok, { name: 'reports./a.json', content: 'x' }]],
      ['symlink entry', [ok, { name: 'escape', type: '2', linkname: '../../outside/sentinel.txt' }]],
      ['hard link entry', [ok, { name: 'escape', type: '1', linkname: '../outside/sentinel.txt' }]],
      ['directory entry', [ok, { name: 'reports/', type: '5' }]],
      ['pax header', [ok, { name: 'pax', type: 'x', content: '30 path=../../outside/x.json\n' }]],
      ['duplicate name', [ok, ok]],
    ];
    const results: Array<{ label: string; code: string | null; escaped: boolean }> = [];
    for (const [label, entries] of hostile) {
      const caseDir = join(tmp.dir, `x-${results.length}`);
      mkdirSync(caseDir);
      const bundle = join(caseDir, 'hostile.tar');
      writeFileSync(bundle, rawTar(entries));
      const before = tree(tmp.dir);
      const outsideBefore = tree(outside);
      let code: string | null = null;
      try {
        verifyBundle(bundle, join(caseDir, 'extract'));
      } catch (error) {
        code = (error as { code?: string }).code ?? 'THROWN';
      }
      const after = tree(tmp.dir);
      const added = after.filter((p) => !before.includes(p));
      const escaped =
        added.some((p) => !p.startsWith(`x-${results.length}/extract`)) ||
        JSON.stringify(tree(outside)) !== JSON.stringify(outsideBefore);
      results.push({ label, code, escaped });
    }
    for (const r of results)
      expect.soft(r, r.label).toEqual({ label: r.label, code: 'RS_BUNDLE_VERIFY_FAILED', escaped: false });
    expect(readFileSync(join(outside, 'sentinel.txt'), 'utf8')).toBe('outside the chosen target');
  });

  it('the extraction directory must be a real directory, never a junction to another place', () => {
    const bundle = join(work, 'bundle.tar');
    expect(existsSync(bundle)).toBe(true);
    const redirected = join(outside, 'redirected');
    mkdirSync(redirected);
    junction(redirected, join(work, 'extract-link'));
    let code: string | null = null;
    try {
      verifyBundle(bundle, join(work, 'extract-link'));
    } catch (error) {
      code = (error as { code?: string }).code ?? 'THROWN';
    }
    expect(code).toBe('RS_EXPORT_PATH_INVALID');
    expect(readdirSync(redirected)).toEqual([]);
    // Positive control: a fresh real directory verifies, and only it receives files.
    const before = tree(outside);
    const v = verifyBundle(bundle, join(work, 'extract-ok'));
    expect(v.verified).toBe(true);
    expect(tree(outside)).toEqual(before);
    rmSync(join(work, 'extract-link'));
  });

  it('input paths (bundle, scenario file) refuse network and device namespaces through the CLI', async () => {
    const started = Date.now();
    const unc = await runCliProcess([
      'export',
      'verify',
      '--bundle',
      '\\\\192.0.2.1\\share\\bundle.tar',
      '--extract-to',
      join(work, 'extract-unc'),
    ]);
    const scenario = await runCliProcess(['scenario', 'validate', '\\\\192.0.2.1\\share\\scenario.yaml']);
    const device = await runCliProcess(['scenario', 'validate', '\\\\.\\pipe\\routespec-t040']);
    const elapsed = Date.now() - started;
    const err = (r: { json: Record<string, unknown> | null }) =>
      r.json?.['error'] as { code?: string; details?: { rule?: string } } | undefined;
    expect(err(unc)).toMatchObject({ code: 'RS_EXPORT_PATH_INVALID', details: { rule: 'NETWORK_PATH' } });
    expect(err(scenario)).toMatchObject({ details: { rule: 'NETWORK_PATH' } });
    expect(err(device)).toMatchObject({ details: { rule: 'DEVICE_NAMESPACE' } });
    expect(existsSync(join(work, 'extract-unc'))).toBe(false);
    // Three CLI processes; no SMB timeout was waited on.
    expect(elapsed).toBeLessThan(20_000);
  });

  it('import file names never reach the file system and keep only a sanitized base name', async () => {
    const { ImportJournal } = await import('@routespec/store');
    const imports = new ImportJournal(store);
    const names = [
      '../../outside/trace.json',
      'C:\\Windows\\System32\\trace.json',
      '\\\\host\\share\\trace.json',
      'nul.json',
      'trace.json:stream',
      'trace.json.',
      'trace.json ',
      'trace\u202enosj.json',
    ];
    const before = tree(tmp.dir);
    const stored: Array<{ name: string; filename: string | null; unsafe: boolean }> = [];
    for (const name of names) {
      const r = await importUserFile(imports, {
        projectId,
        filename: name,
        source: [Buffer.from('{"schema":"routespec.trace/1"}', 'utf8')],
        idempotencyKey: key(),
      });
      const view = imports.getImport(r.importId);
      stored.push({
        name,
        filename: view.sourceFilename,
        unsafe: view.findings.some((f) => f.category === 'PATH_UNSAFE'),
      });
    }
    const after = tree(tmp.dir).filter((p) => !p.startsWith('data/'));
    expect(after).toEqual(before.filter((p) => !p.startsWith('data/')));
    for (const s of stored) {
      expect.soft(s.unsafe, s.name).toBe(true);
      expect.soft(checkLocalPathSyntax(s.filename ?? '').ok, `${s.name} -> ${s.filename}`).toBe(true);
      expect.soft(/[\\/:]/.test(s.filename ?? ''), s.name).toBe(false);
    }
  });
});
