/**
 * M54: policy checks of the npm publish workflow (runs only when the owner starts it, pins every
 * action by commit, keeps expressions out of scripts, `id-token` only in the publish job, the npm
 * token only in the publish step) and of the console demo step that M54 adds to the M49 Pages
 * workflow (it builds from the committed recording and records nothing; M49's own test covers
 * that workflow's triggers and permissions).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseScenarioSource } from '@routespec/scenario';
import { ROOT } from '../src/npm-package.ts';

type J = Record<string, unknown>;
const LIMITS = { maxSourceBytes: 256 * 1024, maxDepth: 32, maxAliases: 0, maxStringLength: 16 * 1024 };

function load(name: string): { text: string; doc: J } {
  const text = readFileSync(join(ROOT, '.github', 'workflows', name), 'utf8');
  return { text, doc: parseScenarioSource(text, 'yaml', LIMITS) as J };
}
const jobs = (doc: J): Record<string, J> => doc['jobs'] as Record<string, J>;
const steps = (job: J): J[] => (job['steps'] as J[] | undefined) ?? [];

describe('M54 release workflows', () => {
  for (const name of ['npm-publish.yml']) {
    it(`${name}: manual trigger, read-only default, pinned actions, no expressions in scripts`, () => {
      const { doc } = load(name);
      expect(Object.keys(doc['on'] as J)).toEqual(['workflow_dispatch']);
      expect(doc['permissions']).toEqual({ contents: 'read' });
      for (const job of Object.values(jobs(doc))) {
        for (const s of steps(job)) {
          if (typeof s['uses'] === 'string') expect(s['uses']).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
          if (typeof s['run'] === 'string') expect(s['run']).not.toContain('${{');
          if (s['uses'] && String(s['uses']).startsWith('actions/checkout@')) {
            expect((s['with'] as J)['persist-credentials']).toBe(false);
          }
        }
      }
    });
  }

  it('npm-publish: provenance from the single publish job, the npm token only in the publish step', () => {
    const { text, doc } = load('npm-publish.yml');
    const publish = jobs(doc)['publish'] as J;
    expect(publish['permissions']).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(text.match(/secrets\./g)).toHaveLength(1);
    const step = steps(publish).find((s) => String(s['run'] ?? '').includes('npm publish')) as J;
    expect(step['env']).toEqual({ NODE_AUTH_TOKEN: '${{ secrets.NPM_TOKEN }}' });
    expect(step['run']).toContain('--provenance');
    const names = steps(publish).map((s) => s['name']);
    // The suite that installs and runs the tarball comes before the publish step.
    expect(
      names.indexOf('Distribution suite (installed tarball, Marketplace step, console demo)'),
    ).toBeLessThan(names.indexOf('Publish the packed tarball with provenance'));
  });

  it('routespec-pages: builds the demo from the committed recording below the verify page', () => {
    const { text, doc } = load('routespec-pages.yml');
    expect(text).not.toContain('secrets.');
    const build = jobs(doc)['build'] as J;
    const names = steps(build).map((s) => s['name'] as string);
    const demo = steps(build).find((s) => String(s['run'] ?? '').includes('pnpm run demo:console')) as J;
    expect(demo['run']).toContain('--out apps/verify/dist/console --base /routespec-near/console/');
    expect(demo['run']).toContain('--root-fallback apps/verify/dist');
    expect(names.indexOf(demo['name'] as string)).toBeLessThan(names.indexOf('Upload the site'));
    expect(text).not.toContain('demo:record');
  });
});
