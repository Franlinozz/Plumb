#!/usr/bin/env node
/**
 * Honest placeholder for a root script whose implementation lands in a later phase.
 *
 * It exits NON-ZERO on purpose. A script that printed nothing and exited 0 would let
 * `npm run backtest` look like it ran a backtest, which is exactly the class of silent
 * false-success this project exists to eliminate (AGENTS.md guardrail 8).
 */

const [name = 'this script', phase = '?', summary = ''] = process.argv.slice(2);

process.stderr.write(
  [
    ``,
    `  npm run ${name} — NOT IMPLEMENTED YET (lands in Phase ${phase}).`,
    summary ? `  Scope: ${summary}` : ``,
    ``,
    `  Nothing was run and no result was produced. This exits 1 so that no caller,`,
    `  human or automated, can mistake it for a completed run.`,
    ``,
  ]
    .filter((line) => line !== ``)
    .join('\n') + '\n',
);

process.exit(1);
