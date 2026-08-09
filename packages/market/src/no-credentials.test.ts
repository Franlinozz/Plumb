import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { MARKET_PACKAGE } from './index.js';

/**
 * GUARDRAIL 10, ENFORCED STRUCTURALLY.
 *
 * "LIVE KEYS DO NOT EXIST until Phase 9." Market data is the one thing that genuinely needs no
 * credential — every OKX endpoint this package calls is public. So the phase's non-negotiable
 * is not "we did not use a key", it is "a key cannot be used from here", and that is checkable.
 *
 * This test reads the package's own source and fails if a credential name, a signing header or
 * an authenticated OKX path ever appears in it.
 */

const SRC_DIR = fileURLToPath(new URL('./', import.meta.url));

/** Patterns that would mean this package had grown the ability to authenticate. */
const FORBIDDEN: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
  { label: 'OKX API key env var', pattern: /OKX_API_KEY/ },
  { label: 'OKX API secret env var', pattern: /OKX_API_SECRET/ },
  { label: 'OKX API passphrase env var', pattern: /OKX_API_PASSPHRASE/ },
  { label: 'OKX UID env var', pattern: /OKX_UID/ },
  { label: 'OKX signing header', pattern: /OK-ACCESS-/i },
  { label: 'HMAC signing', pattern: /createHmac/ },
  { label: 'Authorization header', pattern: /['"]authorization['"]/i },
  // Every OKX v5 path that requires a signature lives under /account, /trade or /asset.
  { label: 'authenticated OKX path', pattern: /\/api\/v5\/(account|trade|asset)\// },
];

function sourceFiles(): readonly string[] {
  return readdirSync(SRC_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(SRC_DIR, name));
}

describe('@plumb/market uses no credentials', () => {
  it('declares itself credential-free', () => {
    expect(MARKET_PACKAGE.requiresCredentials).toBe(false);
  });

  it('reads its own source — the scan is not vacuous', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(8);
    expect(files.some((f) => f.endsWith('client.ts'))).toBe(true);
    // Proof the matcher works: the pattern list does find a string when one is present.
    expect(FORBIDDEN.some(({ pattern }) => pattern.test('OKX_API_KEY=abc'))).toBe(true);
  });

  it('contains no credential name, signing header or authenticated endpoint', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (file.endsWith('no-credentials.test.ts')) continue; // this file names them on purpose
      const source = readFileSync(file, 'utf8');
      for (const { label, pattern } of FORBIDDEN) {
        if (pattern.test(source)) offenders.push(`${file.split('/').at(-1)}: ${label}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('only ever targets OKX public endpoints', () => {
    const client = readFileSync(join(SRC_DIR, 'client.ts'), 'utf8');
    const paths = [...client.matchAll(/'(\/api\/v5\/[^']+)'/g)].map((m) => m[1] as string);
    expect(paths.length).toBeGreaterThanOrEqual(9);
    for (const path of paths) {
      expect(path).toMatch(/^\/api\/v5\/(market|public|rubik)\//);
    }
  });
});
