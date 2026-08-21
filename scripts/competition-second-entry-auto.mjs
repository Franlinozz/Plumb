#!/usr/bin/env node
/** One-shot unattended BTC/SOL competition entry under the recorded 2026-08-21 authorization. */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { SECOND_ENTRY_AMENDMENT, finalizeDecisionEvent } from '@plumb/core';

const executeFile = promisify(execFile);
const instrument = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
if (!SECOND_ENTRY_AMENDMENT.instruments.includes(instrument)) {
  throw new Error('usage: competition-second-entry-auto.mjs <BTC-USDT-SWAP|SOL-USDT-SWAP> [--dry-run]');
}
const expectedUid = process.env.OKX_UID?.trim() ?? '';
const agentId = process.env.PLUMB_ASP_AGENT_ID?.trim() ?? '';
const webhook = process.env.PLUMB_DISCORD_WEBHOOK?.trim() ?? '';
if (!/^\d+$/u.test(expectedUid) || !/^\d+$/u.test(agentId)) {
  throw new Error('dedicated competition UID or Plumb ASP ID is missing');
}
if (!/^https:\/\/(?:www\.)?discord\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/u.test(webhook)) {
  throw new Error('Discord webhook is missing or malformed');
}

const root = resolve(import.meta.dirname, '..');
const stateDir = process.env.PLUMB_COMPETITION_STATE_DIR ?? '/var/lib/plumb-okxai';
const statePath = `${stateDir}/second-entry-auto.json`;
const environment = {
  ...process.env,
  PLUMB_COMPETITION_UID: expectedUid,
  PLUMB_ASP_AGENT_ID: agentId,
  PLUMB_COMPETITION_STATE_DIR: stateDir,
  PLUMB_A2A_STATE: process.env.PLUMB_A2A_STATE ?? `${stateDir}/asp-delivery.db`,
  NODE_OPTIONS: '--dns-result-order=ipv4first',
};
delete environment.PLUMB_LIVE_CONFIRMATION;

const parseLastJson = (text) => {
  for (const line of String(text).trim().split(/\r?\n/u).reverse()) {
    try { return JSON.parse(line); } catch { /* progress output */ }
  }
  throw new Error('child process returned no JSON result');
};

async function runNode(script, args) {
  try {
    return await executeFile(process.execPath, [resolve(root, 'scripts', script), ...args], {
      cwd: root, env: environment, timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = String(error?.stderr ?? '').trim().split(/\r?\n/u).at(-1) ?? '';
    const stdout = String(error?.stdout ?? '').trim().split(/\r?\n/u).at(-1) ?? '';
    throw new Error(`${script} failed: ${stderr || stdout || 'no diagnostic'}`);
  }
}

async function notify(content) {
  const endpoint = new URL(webhook);
  endpoint.searchParams.set('wait', 'true');
  try {
    const response = await fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'Plumb Auto Entry', content,
        allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    console.error(JSON.stringify({ event: 'discord_notification_failed', detail: String(error) }));
  }
}

const save = (state) => {
  const temporary = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, statePath);
};

if (existsSync(statePath)) {
  const existing = JSON.parse(readFileSync(statePath, 'utf8'));
  if (existing.status !== 'complete' && existing.incidentAlertedAt === undefined) {
    await notify([
      '🚨 **PLUMB AUTO ENTRY REQUIRES MANUAL RECONCILIATION**',
      `${existing.instrument ?? instrument}${existing.decisionId ? ` · Decision ${existing.decisionId}` : ''}`,
      `Durable workflow state is ${existing.status ?? 'unknown'} after a prior process ended. No automatic retry will occur.`,
      'Inspect venue, A2A publication and signed ledger state before any further action.',
    ].join('\n'));
    existing.incidentAlertedAt = new Date().toISOString();
    existing.updatedAt = existing.incidentAlertedAt;
    save(existing);
  }
  console.log(JSON.stringify({ event: 'second_entry_auto_already_terminal_or_blocked',
    status: existing.status, decisionId: existing.decisionId ?? null }));
  process.exit(0);
}

const reconciliationRun = await runNode('competition-reconcile-exits.mjs', []);
const reconciliation = parseLastJson(reconciliationRun.stdout);
if (reconciliation.event !== 'competition_exit_reconciliation_complete') {
  throw new Error('competition exit reconciler returned an invalid acknowledgement');
}
for (const exit of reconciliation.reconciled) {
  await notify([
    '✅ **PLUMB PROTECTIVE EXIT VERIFIED AND RECONCILED**',
    `${exit.instrument} · Decision ${exit.decisionId}`,
    `${String(exit.exitKind).toUpperCase()} filled at ${exit.exitPrice} · Realized PnL ${exit.realisedPnl.toFixed(8)} USDT`,
    'Venue is signed-flat and the durable competition ledger now matches.',
  ].join('\n'));
}

if (Date.now() >= SECOND_ENTRY_AMENDMENT.latestEntryAt) {
  console.log(JSON.stringify({ event: 'second_entry_auto_window_closed' }));
  process.exit(0);
}

const monitorRun = await runNode('competition-v3-monitor.mjs', [instrument]);
const publicResult = parseLastJson(monitorRun.stdout);
console.log(JSON.stringify(publicResult));
if (publicResult.publicPreparationReady !== true) process.exit(0);

const closedAt = Date.parse(publicResult.closedBars?.oneHourAt ?? '');
if (!Number.isFinite(closedAt)) throw new Error('public-ready result lacks a closed 1H timestamp');
const bundlePath = `${stateDir}/second-entry-${instrument}-${closedAt}.json`;

let state;
try {
  await runNode('prepare-second-entry.mjs', [instrument, bundlePath]);
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  const event = finalizeDecisionEvent(bundle.event);
  if (event.instrument !== instrument || event.direction !== publicResult.strategyProbe.side ||
      event.approvalBasis !== SECOND_ENTRY_AMENDMENT.approvalBasis) {
    throw new Error('public monitor and private DecisionEvent disagree');
  }
  state = {
    status: 'prepared', decisionId: event.decisionId, instrument, direction: event.direction,
    bundlePath, closedAt: publicResult.closedBars.oneHourAt,
    authorisedAt: new Date(SECOND_ENTRY_AMENDMENT.unattendedExecutionAuthorisedAt).toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (dryRun) {
    console.log(JSON.stringify({ event: 'second_entry_auto_dry_run_ready', ...state }));
    process.exit(0);
  }
  save(state); // Durable one-shot claim BEFORE the first external write.
  await notify([
    '🟡 **PLUMB QUALIFYING SETUP — UNATTENDED WORKFLOW STARTED**',
    `${instrument} ${event.direction.toUpperCase()} · Decision ${event.decisionId}`,
    `Entry ${event.entryLow.toFixed(2)}–${event.entryHigh.toFixed(2)} · SL ${event.stopPrice.toFixed(2)} · TP ${event.takeProfit.toFixed(2)}`,
    `Maximum recorded stop risk: ${event.riskUsd.toFixed(2)} USDT. Publication and venue checks are running now.`,
  ].join('\n'));

  await runNode('asp-push-decision.mjs', [bundlePath]);
  state = { ...state, status: 'published', updatedAt: new Date().toISOString() };
  save(state);

  state = { ...state, status: 'executing', updatedAt: new Date().toISOString() };
  save(state); // A restart from here is UNCERTAIN and is never retried automatically.
  const execution = await runNode('competition-execute-decision.mjs', [
    bundlePath, '--execute', '--unattended-second-entry',
  ]);
  const result = parseLastJson(execution.stdout);
  if (result.event !== 'competition_execution_complete' || result.decisionId !== event.decisionId) {
    throw new Error('execution process did not return the exact completion acknowledgement');
  }
  state = { ...state, status: 'complete', orderId: result.orderId,
    contracts: result.contracts, venueSignedPositionAfter: result.venueSignedPositionAfter,
    updatedAt: new Date().toISOString() };
  save(state);
  await notify([
    '✅ **PLUMB UNATTENDED ENTRY EXECUTED AND RECONCILED**',
    `${instrument} ${event.direction.toUpperCase()} · Decision ${event.decisionId}`,
    `Contracts ${result.contracts} · SL ${event.stopPrice.toFixed(2)} · TP ${event.takeProfit.toFixed(2)}`,
    `Order ${result.orderId} was sent through Agent Trade Kit after complete A2A acknowledgement.`,
  ].join('\n'));
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  if (state !== undefined) {
    state = { ...state, status: 'uncertain', failedStage: state.status,
      error: detail.slice(0, 500), updatedAt: new Date().toISOString() };
    save(state);
  }
  await notify([
    '🚨 **PLUMB AUTO ENTRY STOPPED — NO AUTOMATIC RETRY**',
    `${instrument}${state?.decisionId ? ` · Decision ${state.decisionId}` : ''}`,
    `Stage: ${state?.failedStage ?? 'private preparation'} · ${detail.slice(0, 500)}`,
    'Inspect venue, A2A publication and signed ledger state manually before any further action.',
  ].join('\n'));
  throw error;
}
