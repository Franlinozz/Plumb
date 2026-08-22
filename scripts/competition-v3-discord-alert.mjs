#!/usr/bin/env node
/** Discord alert wrapper for the public-data-only frozen v3 opportunity monitor. */

import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const webhook = process.env.PLUMB_DISCORD_WEBHOOK?.trim() ?? '';
if (!/^https:\/\/(?:www\.)?discord\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/u.test(webhook)) {
  throw new Error('PLUMB_DISCORD_WEBHOOK is missing or malformed');
}

const statePath = process.env.PLUMB_DISCORD_ALERT_STATE ??
  '/var/lib/plumb-okxai/v3-discord-alert-state.json';
const monitorPath = resolve(import.meta.dirname, 'competition-v3-monitor.mjs');

async function postDiscord(content) {
  const endpoint = new URL(webhook);
  endpoint.searchParams.set('wait', 'true');
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'Plumb Monitor',
        content,
        allowed_mentions: { parse: [] },
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error('Discord webhook delivery failed before an HTTP response');
  }
  if (!response.ok) throw new Error(`Discord webhook delivery failed with HTTP ${response.status}`);
}

if (process.argv[2] === '--test') {
  await postDiscord([
    '✅ **Plumb alerts connected**',
    'The VPS can notify this channel when the frozen BTC/ETH/SOL public setup becomes ready.',
    'This was a notification test. No signal was published and no trade was placed.',
  ].join('\n'));
  console.log(JSON.stringify({ event: 'discord_test_delivered', ok: true }));
  process.exit(0);
}

const instrument = process.argv[2];
if (!['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP'].includes(instrument)) {
  throw new Error('usage: competition-v3-discord-alert.mjs <BTC-USDT-SWAP|ETH-USDT-SWAP|SOL-USDT-SWAP>');
}

const { stdout } = await executeFile(process.execPath, [monitorPath, instrument], {
  cwd: resolve(import.meta.dirname, '..'),
  timeout: 60_000,
  maxBuffer: 1024 * 1024,
  env: { PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_OPTIONS: '--dns-result-order=ipv4first' },
});
const line = stdout.trim().split('\n').at(-1);
if (line === undefined) throw new Error('v3 monitor returned no result');
const result = JSON.parse(line);
console.log(line);
if (result.publicPreparationReady !== true) process.exit(0);

const side = result.strategyProbe?.side;
const closedAt = result.closedBars?.oneHourAt;
if (!['long', 'short'].includes(side) || typeof closedAt !== 'string') {
  throw new Error('ready monitor result lacks a side or closed-bar timestamp');
}
const key = `${instrument}:${closedAt}:${side}`;
let state = { delivered: {} };
try {
  state = JSON.parse(readFileSync(statePath, 'utf8'));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
if (state.delivered?.[key] !== undefined) {
  console.log(JSON.stringify({ event: 'discord_setup_alert_deduplicated', key }));
  process.exit(0);
}

const display = (value, digits = 4) => Number.isFinite(value) ? Number(value).toFixed(digits) : 'n/a';
await postDiscord([
  '🟢 **PLUMB PUBLIC SETUP READY — OPEN CODEX NOW**',
  `Instrument: **${instrument}**`,
  `Direction: **${side.toUpperCase()}**`,
  `Closed 1H bar: ${closedAt}`,
  `Reference / stop / TP: ${display(result.strategyProbe.entry, 2)} / ${display(result.strategyProbe.stop, 2)} / ${display(result.strategyProbe.takeProfit, 2)}`,
  `OI 1h / 4h / 24h: ${display(result.market.openInterestChangePct1h * 100, 3)}% / ${display(result.market.openInterestChangePct4h * 100, 3)}% / ${display(result.market.openInterestChangePct24h * 100, 3)}%`,
  'This is **not an order**. Private account reconciliation, A2A publication and an exact `CONFIRM LIVE <decisionId>` are still required.',
].join('\n'));

mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
const next = { delivered: { ...(state.delivered ?? {}), [key]: new Date().toISOString() } };
const temporary = `${statePath}.${process.pid}.tmp`;
writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
renameSync(temporary, statePath);
console.log(JSON.stringify({ event: 'discord_setup_alert_delivered', key }));
