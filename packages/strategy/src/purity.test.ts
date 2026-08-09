import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { STRATEGY_PACKAGE } from './index.js';

/**
 * PURITY, ENFORCED STRUCTURALLY.
 *
 * "@plumb/strategy has ZERO I/O, ZERO network, ZERO clock reads, ZERO randomness without an
 * injected seed." That is the property P4's backtest rests on: if a strategy can read the clock or
 * the network, then replaying it over history is running a *different program* from the live one,
 * and the backtest stops being evidence.
 *
 * A comment cannot enforce it. This reads the package's own source and fails on any forbidden
 * token — the same pattern as P1's `no-credentials.test.ts`.
 */

const SRC_DIR = fileURLToPath(new URL('./', import.meta.url));

interface Rule {
  readonly label: string;
  readonly pattern: RegExp;
  /**
   * False → the rule is not applied to `*.test.ts`. Tests legitimately read the filesystem to
   * perform structural checks. They still may not read a clock, roll a die, or open a socket:
   * a non-deterministic test is worse than no test.
   */
  readonly appliesToTests?: boolean;
}

const FORBIDDEN: readonly Rule[] = [
  { label: 'clock read (Date.now)', pattern: /\bDate\.now\s*\(/ },
  { label: 'clock read (new Date)', pattern: /\bnew\s+Date\s*\(/ },
  { label: 'clock read (performance.now)', pattern: /\bperformance\s*\.\s*now\s*\(/ },
  { label: 'unseeded randomness', pattern: /\bMath\.random\s*\(/ },
  { label: 'crypto randomness', pattern: /\bcrypto\b/ },
  { label: 'network (fetch)', pattern: /\bfetch\s*\(/ },
  { label: 'network (XMLHttpRequest)', pattern: /XMLHttpRequest/ },
  { label: 'network (WebSocket)', pattern: /WebSocket/ },
  { label: 'node http', pattern: /['"]node:https?['"]/ },
  { label: 'filesystem', pattern: /['"]node:fs['"]/, appliesToTests: false },
  { label: 'path module', pattern: /['"]node:path['"]/, appliesToTests: false },
  { label: 'child process', pattern: /['"]node:child_process['"]/ },
  { label: 'environment read', pattern: /process\s*\.\s*env/, appliesToTests: false },
  { label: 'timer', pattern: /\bset(?:Timeout|Interval|Immediate)\s*\(/ },
  { label: 'database', pattern: /better-sqlite3/ },
];

/** This file names every forbidden token on purpose. */
const EXEMPT = new Set(['purity.test.ts']);

/**
 * Strip comments and string literals before scanning.
 *
 * Without this the scan matches its own documentation — a comment reading "`Date.now()` appears
 * nowhere in this package" would fail the test that proves it. A scanner that cannot tell code
 * from prose reports failures that are not real, and a test that cries wolf gets muted.
 */
function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

function sourceFiles(dir: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('@plumb/strategy is pure', () => {
  const files = sourceFiles(SRC_DIR);

  it('declares itself pure and order-free', () => {
    expect(STRATEGY_PACKAGE.isPure).toBe(true);
    expect(STRATEGY_PACKAGE.canPlaceOrders).toBe(false);
  });

  it('reads its own source — the scan is not vacuous', () => {
    expect(files.length).toBeGreaterThan(12);
    expect(files.some((f) => f.endsWith('engine.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('trend_ema.ts'))).toBe(true);
    // The matchers really do match when the token is present in CODE...
    expect(FORBIDDEN.some(({ pattern }) => pattern.test(stripCommentsAndStrings('const t = Date.now()')))).toBe(true);
    expect(FORBIDDEN.some(({ pattern }) => pattern.test(stripCommentsAndStrings('Math.random()')))).toBe(true);
    // ...and do NOT match the same words in prose, which is what the stripper is for.
    expect(
      FORBIDDEN.some(({ pattern }) => pattern.test(stripCommentsAndStrings('// Date.now() is banned here'))),
    ).toBe(false);
  });

  it('contains no clock read, no randomness, no network, no I/O', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const name = file.split('/').at(-1) as string;
      if (EXEMPT.has(name)) continue;
      const isTest = name.endsWith('.test.ts');
      const code = stripCommentsAndStrings(readFileSync(file, 'utf8'));
      for (const { label, pattern, appliesToTests } of FORBIDDEN) {
        if (isTest && appliesToTests === false) continue;
        if (pattern.test(code)) offenders.push(`${name}: ${label}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('imports only from @plumb/core, @plumb/market, zod and itself', () => {
    const allowed = /^(?:\.{1,2}\/|@plumb\/(?:core|market)$|zod$)/;
    const offenders: string[] = [];
    for (const file of files) {
      const name = file.split('/').at(-1) as string;
      if (EXEMPT.has(name)) continue;
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
        const specifier = match[1] as string;
        if (name.endsWith('.test.ts') && specifier.startsWith('node:')) continue;
        if (name.endsWith('.test.ts') && specifier === 'vitest') continue;
        if (!allowed.test(specifier)) offenders.push(`${name}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never imports @plumb/executor', () => {
    // Guardrail 1 is proven in full by strategy/src/no-order-path.test.ts against the real
    // workspace manifests; this is the cheap import-level echo of it. It checks IMPORTS, not
    // mentions — the package documentation names the executor to explain why it is unreachable.
    for (const file of files) {
      const code = readFileSync(file, 'utf8');
      expect(code).not.toMatch(/from\s+'@plumb\/executor'/);
      expect(code).not.toMatch(/import\s*\(\s*'@plumb\/executor'/);
    }
  });
});
