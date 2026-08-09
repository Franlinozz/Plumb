import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * GUARDRAIL 1, ENFORCED STRUCTURALLY.
 *
 * "`strategy` emits Signal objects and CANNOT place orders."
 *
 * A comment cannot enforce that and a code review will eventually miss it. What actually
 * enforces it is the dependency graph: if `@plumb/executor` is not reachable from
 * `@plumb/strategy`, then no amount of code inside strategy can reach an order, because
 * the module simply cannot be imported.
 *
 * This test walks the real workspace manifests and fails the moment that stops being true.
 */

const PACKAGES_DIR = fileURLToPath(new URL('../../', import.meta.url));

type Manifest = { name: string; dependencies?: Record<string, string> };

function readGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const dir of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const manifestPath = join(PACKAGES_DIR, dir.name, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
    const deps = Object.keys(manifest.dependencies ?? {}).filter((d) => d.startsWith('@plumb/'));
    graph.set(manifest.name, deps);
  }
  return graph;
}

function reachableFrom(graph: Map<string, string[]>, start: string): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const dep of graph.get(current) ?? []) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      queue.push(dep);
    }
  }
  return seen;
}

describe('signal primacy is structural', () => {
  const graph = readGraph();

  it('reads the real workspace graph', () => {
    // Sanity: if the loader broke, every assertion below would pass vacuously.
    expect(graph.size).toBe(8);
    expect(graph.has('@plumb/strategy')).toBe(true);
    expect(graph.has('@plumb/executor')).toBe(true);
  });

  it('cannot reach @plumb/executor from @plumb/strategy, at any depth', () => {
    const reachable = reachableFrom(graph, '@plumb/strategy');
    expect([...reachable].sort()).toEqual(['@plumb/core', '@plumb/market']);
    expect(reachable.has('@plumb/executor')).toBe(false);
  });

  it('cannot reach @plumb/executor from @plumb/market or @plumb/core either', () => {
    // The whole upstream half of the pipeline is order-free, not just strategy itself.
    for (const upstream of ['@plumb/core', '@plumb/market']) {
      expect(reachableFrom(graph, upstream).has('@plumb/executor')).toBe(false);
    }
  });

  it('keeps the executor downstream of the published feed (guardrail 2)', () => {
    // PUBLISH BEFORE EXECUTE: the executor reads approved signals out of @plumb/asp,
    // so it must depend on it — and must NOT depend on strategy internals.
    const executorDeps = graph.get('@plumb/executor') ?? [];
    expect(executorDeps).toContain('@plumb/asp');
    expect(executorDeps).not.toContain('@plumb/strategy');
    expect(reachableFrom(graph, '@plumb/executor').has('@plumb/strategy')).toBe(false);
  });
});
