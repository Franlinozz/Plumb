import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { RISK_PACKAGE } from './index.js';

/**
 * NO MODEL GOES NEAR THE MONEY.
 *
 * Guardrail 4: "LLMs NEVER produce numbers that reach an order." `@plumb/risk` is where numbers
 * become orders, so the strongest form of that guarantee is that this package cannot talk to a
 * model at all — no provider SDK, no API key, no network.
 *
 * Checked by reading the package's own source, the same pattern as P1's `no-credentials.test.ts`
 * and P2's `purity.test.ts`.
 */

const SRC_DIR = fileURLToPath(new URL('./', import.meta.url));

interface Rule {
  readonly label: string;
  readonly pattern: RegExp;
  readonly appliesToTests?: boolean;
}

const FORBIDDEN: readonly Rule[] = [
  { label: 'Anthropic', pattern: /anthropic/i },
  { label: 'OpenAI', pattern: /openai/i },
  { label: 'DeepSeek', pattern: /deepseek/i },
  { label: 'a model client', pattern: /\b(?:completion|chatCompletion|generateText|invokeModel)\b/ },
  { label: 'a prompt', pattern: /\b(?:systemPrompt|userPrompt|promptTemplate)\b/ },
  { label: 'network (fetch)', pattern: /\bfetch\s*\(/ },
  { label: 'node http', pattern: /['"]node:https?['"]/ },
  { label: 'API key', pattern: /API_KEY/ },
  { label: 'environment read', pattern: /process\s*\.\s*env/, appliesToTests: false },
  { label: 'unseeded randomness', pattern: /\bMath\.random\s*\(/ },
  { label: 'clock read (Date.now)', pattern: /\bDate\.now\s*\(/ },
];

const EXEMPT = new Set(['no-llm.test.ts']);

/** Strip comments and strings so the scan reads CODE, not its own documentation. */
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

describe('@plumb/risk has no model anywhere near it', () => {
  const files = sourceFiles(SRC_DIR);

  it('declares itself model-free', () => {
    expect(RISK_PACKAGE.usesModel).toBe(false);
    expect(RISK_PACKAGE.responsibility).toBe('veto');
    expect(RISK_PACKAGE.statePersisted).toBe(true);
  });

  it('reads its own source — the scan is not vacuous', () => {
    expect(files.length).toBeGreaterThan(8);
    expect(files.some((f) => f.endsWith('governor.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('sizing.ts'))).toBe(true);
    expect(
      FORBIDDEN.some(({ pattern }) => pattern.test(stripCommentsAndStrings('const c = anthropic.messages'))),
    ).toBe(true);
    // ...and does not fire on prose that merely mentions the words.
    expect(
      FORBIDDEN.some(({ pattern }) => pattern.test(stripCommentsAndStrings('// no anthropic here'))),
    ).toBe(false);
  });

  it('contains no model client, no prompt, no network call, no key', () => {
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

  it('imports only from @plumb/core, @plumb/market, better-sqlite3 and itself', () => {
    const allowed = /^(?:\.{1,2}\/|@plumb\/(?:core|market)$|better-sqlite3$)/;
    const offenders: string[] = [];
    for (const file of files) {
      const name = file.split('/').at(-1) as string;
      if (EXEMPT.has(name)) continue;
      for (const match of readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)) {
        const specifier = match[1] as string;
        if (name.endsWith('.test.ts') && (specifier.startsWith('node:') || specifier === 'vitest')) continue;
        if (!allowed.test(specifier)) offenders.push(`${name}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never imports @plumb/strategy — the governor vetoes signals, it does not produce them', () => {
    // Also what keeps @plumb/executor from gaining a transitive path back to strategy internals.
    for (const file of files) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/from\s+'@plumb\/strategy'/);
    }
  });
});
