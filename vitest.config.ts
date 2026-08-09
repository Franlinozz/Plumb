import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const WORKSPACES = [
  'core',
  'market',
  'strategy',
  'risk',
  'backtest',
  'executor',
  'asp',
  'ops',
] as const;

/**
 * Tests resolve `@plumb/*` straight to source, so `npm test` never needs a prior
 * build and can never run against a stale `dist`. The typecheck (`tsc -b`) uses
 * the real project references instead, which is what enforces build order.
 */
const alias = Object.fromEntries(
  WORKSPACES.map((name) => [
    `@plumb/${name}`,
    fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url)),
  ]),
);

export default defineConfig({
  resolve: { alias },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    environment: 'node',
    // Guardrail: fake mode is the default for every test. Zero network, zero spend.
    env: { PLUMB_MODE: 'fake' },
    clearMocks: true,
    restoreMocks: true,
  },
});
