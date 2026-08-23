#!/usr/bin/env node
/** One-shot unattended ETH/SOL contingency; inactive until the frozen v3 cutoff. */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { DEADLINE_CONTINGENCY_AMENDMENT, finalizeDecisionEvent } from '@plumb/core';
import { redactDeliveryDiagnostic } from '@plumb/asp';

const executeFile = promisify(execFile);
const instrument = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
if (!DEADLINE_CONTINGENCY_AMENDMENT.instruments.includes(instrument)) {
  throw new Error('usage: competition-deadline-contingency-auto.mjs <ETH-USDT-SWAP|SOL-USDT-SWAP> [--dry-run]');
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
const statePath = `${stateDir}/second-entry-auto.json`; // Shared claim: v3 and contingency are exclusive.
const environment = {
  ...process.env,
  PLUMB_COMPETITION_UID: expectedUid,
  PLUMB_ASP_AGENT_ID: agentId,
  PLUMB_COMPETITION_STATE_DIR: stateDir,
  PLUMB_A2A_STATE: process.env.PLUMB_A2A_STATE ?? `${stateDir}/asp-delivery.db`,
  NODE_OPTIONS: '--dns-result-order=ipv4first',
};
delete environment.PLUMB_LIVE_CONFIRMATION;

const parseLastJson = (value) => {
  for (const line of String(value).trim().split(/\r?\n/u).reverse()) {
    try { return JSON.parse(line); } catch { /* progress output */ }
  }
  throw new Error('child process returned no JSON result');
};

async function runNode(script, args) {
  try {
    return await executeFile(process.execPath, [resolve(root, 'scripts', script), ...args], {
      cwd: root,
      env: environment,
      timeout: 180_000,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    const combined = String(error?.stderr || error?.stdout || '').trim();
    const lines = combined.split(/\r?\n/u).filter(Boolean);
    const primary = lines.find((line) => /(?:Error|failed|rejected|invalid|timeout)/iu.test(line)) ??
      lines.find((line) => !/^\s*at\s/u.test(line) && !/^Node\.js\s/u.test(line)) ?? '';
    throw new Error(`${script} failed: ${redactDeliveryDiagnostic(primary || 'no diagnostic')}`);
  }
}

async function notify(content) {
  const endpoint = new URL(webhook);
  endpoint.searchParams.set('wait', 'true');
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'Plumb Deadline Contingency',
        content,
        allowed_mentions: { parse: [] },
      }),
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
  console.log(JSON.stringify({
    event: 'deadline_contingency_blocked_by_shared_claim',
    status: existing.status ?? 'unknown',
    decisionId: existing.decisionId ?? null,
  }));
  process.exit(0);
}
const now = Date.now();
if (now < DEADLINE_CONTINGENCY_AMENDMENT.earliestEntryAt) {
  console.log(JSON.stringify({
    event: 'deadline_contingency_waiting_for_v3_cutoff',
    opensAt: new Date(DEADLINE_CONTINGENCY_AMENDMENT.earliestEntryAt).toISOString(),
  }));
  process.exit(0);
}
if (now >= DEADLINE_CONTINGENCY_AMENDMENT.latestEntryAt) {
  console.log(JSON.stringify({ event: 'deadline_contingency_window_closed' }));
  process.exit(0);
}

let publicResult;
try {
  const monitor = await runNode('competition-deadline-contingency-monitor.mjs', [instrument]);
  publicResult = parseLastJson(monitor.stdout);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  await notify([
    '⚠️ **PLUMB CONTINGENCY PUBLIC CHECK FAILED — NO WRITE ATTEMPTED**',
    `${instrument} · ${detail.slice(0, 500)}`,
  ].join('\n'));
  console.log(JSON.stringify({
    event: 'deadline_contingency_public_check_rejected_no_write', instrument,
    detail: detail.slice(0, 500),
  }));
  process.exit(0);
}
console.log(JSON.stringify(publicResult));
if (publicResult.publicPreparationReady !== true) process.exit(0);

const closedAt = Date.parse(publicResult.closedBars?.oneHourAt ?? '');
if (!Number.isFinite(closedAt)) throw new Error('public-ready result lacks a closed 1H timestamp');
const bundlePath = `${stateDir}/deadline-contingency-${instrument}-${closedAt}.json`;
let state;
try {
  await runNode('prepare-deadline-contingency.mjs', [instrument, bundlePath]);
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  const event = finalizeDecisionEvent(bundle.event);
  if (event.instrument !== instrument || event.direction !== publicResult.strategyProbe.side ||
      event.approvalBasis !== DEADLINE_CONTINGENCY_AMENDMENT.approvalBasis) {
    throw new Error('public monitor and private contingency DecisionEvent disagree');
  }
  state = {
    status: 'prepared',
    workflow: 'deadline-contingency-v1',
    decisionId: event.decisionId,
    instrument,
    direction: event.direction,
    bundlePath,
    closedAt: publicResult.closedBars.oneHourAt,
    authorisedAt: new Date(DEADLINE_CONTINGENCY_AMENDMENT.unattendedExecutionAuthorisedAt).toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (dryRun) {
    console.log(JSON.stringify({ event: 'deadline_contingency_auto_dry_run_ready', ...state }));
    process.exit(0);
  }
  save(state); // Durable shared one-shot claim BEFORE publication or order writes.
  await notify([
    '🟡 **PLUMB DEADLINE CONTINGENCY STARTED**',
    `${instrument} ${event.direction.toUpperCase()} · Decision ${event.decisionId}`,
    `Entry ${event.entryLow.toFixed(2)}–${event.entryHigh.toFixed(2)} · SL ${event.stopPrice.toFixed(2)} · TP ${event.takeProfit.toFixed(2)}`,
    `Maximum stop risk ${event.riskUsd.toFixed(2)} USDT. This is an operator-authorised contest-risk event with expected edge recorded as zero.`,
  ].join('\n'));

  await runNode('asp-push-decision.mjs', [bundlePath]);
  state = { ...state, status: 'published', updatedAt: new Date().toISOString() };
  save(state);
  state = { ...state, status: 'executing', updatedAt: new Date().toISOString() };
  save(state);
  const execution = await runNode('competition-execute-decision.mjs', [
    bundlePath, '--execute', '--unattended-deadline-contingency',
  ]);
  const result = parseLastJson(execution.stdout);
  if (result.event !== 'competition_execution_complete' || result.decisionId !== event.decisionId) {
    throw new Error('execution process did not return the exact contingency acknowledgement');
  }
  state = {
    ...state,
    status: 'complete',
    orderId: result.orderId,
    contracts: result.contracts,
    venueSignedPositionAfter: result.venueSignedPositionAfter,
    updatedAt: new Date().toISOString(),
  };
  save(state);
  await notify([
    '✅ **PLUMB DEADLINE CONTINGENCY EXECUTED AND RECONCILED**',
    `${instrument} ${event.direction.toUpperCase()} · Decision ${event.decisionId}`,
    `Contracts ${result.contracts} · SL ${event.stopPrice.toFixed(2)} · TP ${event.takeProfit.toFixed(2)}`,
    `Order ${result.orderId} used Agent Trade Kit after complete A2A acknowledgement.`,
  ].join('\n'));
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  if (state === undefined) {
    await notify([
      '⚠️ **PLUMB CONTINGENCY PRIVATE CHECK REJECTED — NO WRITE ATTEMPTED**',
      `${instrument} · ${detail.slice(0, 500)}`,
    ].join('\n'));
    console.log(JSON.stringify({
      event: 'deadline_contingency_private_preflight_rejected_no_write', instrument,
      detail: detail.slice(0, 500),
    }));
    process.exit(0);
  }
  state = {
    ...state,
    status: 'uncertain',
    failedStage: state.status,
    error: detail.slice(0, 500),
    updatedAt: new Date().toISOString(),
  };
  save(state);
  await notify([
    '🚨 **PLUMB DEADLINE CONTINGENCY STOPPED — NO AUTOMATIC RETRY**',
    `${instrument} · Decision ${state.decisionId}`,
    `Stage ${state.failedStage} · ${detail.slice(0, 500)}`,
    'Inspect publication, venue and signed ledger before any further action.',
  ].join('\n'));
  throw error;
}
