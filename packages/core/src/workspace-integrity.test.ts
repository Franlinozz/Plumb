import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('workspace integrity', () => {
  it('allows only real npm workspaces directly under packages/', () => {
    const packagesRoot = join(repoRoot, 'packages');
    const directories = readdirSync(packagesRoot)
      .filter((name) => statSync(join(packagesRoot, name)).isDirectory())
      .sort();

    for (const name of directories) {
      expect(
        () => JSON.parse(readFileSync(join(packagesRoot, name, 'package.json'), 'utf8')),
        `packages/${name} must be a valid npm workspace; put non-package assets outside packages/`,
      ).not.toThrow();
    }
  });

  it('keeps the strategy no-order-path guardrail discoverable', () => {
    const testFiles = collectTests(join(repoRoot, 'packages'));
    expect(testFiles).toContain('packages/strategy/src/no-order-path.test.ts');
    expect(testFiles.length).toBeGreaterThanOrEqual(38);
  });
});

function collectTests(root: string): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.name.endsWith('.test.ts')) found.push(absolute.slice(repoRoot.length + 1));
    }
  };
  visit(root);
  return found.sort();
}
