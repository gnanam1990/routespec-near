/**
 * M54: the GitHub Marketplace action metadata (`packages/distribution/marketplace/`), which is the
 * root of a separate single-action repository. Static checks:
 *
 * - Marketplace listing rules: a name, a description under 125 characters, branding with a
 *   Feather icon and a supported colour, a licence file.
 * - The same inputs and outputs as the in-repository composite action, and the same credential
 *   withholding script, with paths into the installed npm package instead of the checkout.
 * - The npm spec is the exact name and version the package build publishes; install scripts are
 *   disabled and `npm audit signatures` runs before the gate.
 * - Every third-party action is pinned to a full commit SHA; no expression inside a script.
 *
 * The distribution suite runs the gate step's script for real against the installed tarball.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseScenarioSource } from '@routespec/scenario';
import { ROOT, readPublishManifest } from '../src/npm-package.ts';

type J = Record<string, unknown>;
const LIMITS = { maxSourceBytes: 256 * 1024, maxDepth: 32, maxAliases: 0, maxStringLength: 16 * 1024 };
const MARKETPLACE = join(ROOT, 'packages', 'distribution', 'marketplace');
const IN_REPO = join(ROOT, '.github', 'actions', 'routespec-gate', 'action.yml');

function load(file: string): J {
  return parseScenarioSource(readFileSync(file, 'utf8'), 'yaml', LIMITS) as J;
}
function steps(doc: J): J[] {
  return (doc['runs'] as J)['steps'] as J[];
}
function step(doc: J, name: string): J {
  return steps(doc).find((s) => s['name'] === name || s['id'] === name) as J;
}

const market = load(join(MARKETPLACE, 'action.yml'));
const inRepo = load(IN_REPO);

/** A subset of the Feather icon set that GitHub Marketplace branding accepts. */
const ICONS = new Set(['shield', 'check-circle', 'check-square', 'activity', 'alert-triangle', 'zap']);
const COLOURS = new Set([
  'white',
  'black',
  'yellow',
  'blue',
  'green',
  'orange',
  'red',
  'purple',
  'gray-dark',
]);

describe('M54 Marketplace action metadata', () => {
  it('meets the Marketplace listing rules', () => {
    expect(typeof market['name']).toBe('string');
    expect(market['name']).not.toMatch(/github/i);
    const description = market['description'] as string;
    expect(description.length).toBeGreaterThan(20);
    expect(description.length).toBeLessThan(125);
    const branding = market['branding'] as J;
    expect(ICONS.has(branding['icon'] as string)).toBe(true);
    expect(COLOURS.has(branding['color'] as string)).toBe(true);
    expect(readFileSync(join(MARKETPLACE, 'LICENSE'), 'utf8')).toBe(
      readFileSync(join(ROOT, 'LICENSE'), 'utf8'),
    );
    expect(readFileSync(join(MARKETPLACE, 'README.md'), 'utf8')).toContain('uses: gnanam1990/');
  });

  it('exposes exactly the inputs and outputs of the in-repository action', () => {
    expect(market['inputs']).toEqual(inRepo['inputs']);
    expect(market['outputs']).toEqual(inRepo['outputs']);
    expect((market['runs'] as J)['using']).toBe('composite');
  });

  it('installs the exact published package version with scripts disabled and signatures verified', () => {
    const manifest = readPublishManifest();
    const install = step(market, 'Install RouteSpec from npm (exact version, signatures verified)');
    expect((install['env'] as J)['ROUTESPEC_NPM_SPEC']).toBe(`${manifest.name}@${manifest.version}`);
    const script = install['run'] as string;
    expect(script).toContain(
      'npm install --ignore-scripts --no-audit --no-fund --save-exact "$ROUTESPEC_NPM_SPEC"',
    );
    const lines = script.trim().split('\n');
    expect(lines[lines.length - 1]).toBe('npm audit signatures');
  });

  it('runs the same withholding script as the in-repository action, against the installed package', () => {
    const ours = step(market, 'gate')['run'] as string;
    const theirs = (step(inRepo, 'gate')['run'] as string).replaceAll(
      '$ROUTESPEC_ACTION_ROOT/packages/ci/bin/',
      '$ROUTESPEC_PACKAGE_DIR/bin/',
    );
    expect(ours).toBe(theirs);
    expect((step(market, 'gate')['env'] as J)['ROUTESPEC_CI_CONFIG']).toBe('${{ inputs.config }}');
    expect((step(market, 'gate')['env'] as J)['ROUTESPEC_PACKAGE_DIR']).toBe(
      '${{ runner.temp }}/routespec-action/node_modules/routespec',
    );
  });

  it('pins every third-party action by commit and keeps expressions out of scripts', () => {
    for (const s of steps(market)) {
      if (typeof s['uses'] === 'string') expect(s['uses']).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      if (typeof s['run'] === 'string') expect(s['run']).not.toContain('${{');
    }
    expect(step(market, 'Set up Node.js')['uses']).toBe(step(inRepo, 'Set up Node.js')['uses']);
  });
});
