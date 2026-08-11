#!/usr/bin/env node
/** Publish one canonical approved DecisionEvent to every ACTIVE Plumb subscriber, then exit. */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import Database from 'better-sqlite3';

import {
  DecisionPublicationStore,
  formatDecisionEventForDelivery,
} from '@plumb/asp';
import { finalizeDecisionEvent } from '@plumb/core';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const inputPath = args.find((arg) => !arg.startsWith('--'));
const agentId = process.env.PLUMB_ASP_AGENT_ID ?? '';
const statePath = process.env.PLUMB_A2A_STATE ?? '/var/lib/plumb-okxai/asp-delivery.db';

if (inputPath === undefined) throw new Error('usage: asp-push-decision.mjs <decision-bundle.json> [--dry-run]');
if (!/^\d+$/u.test(agentId)) throw new Error('PLUMB_ASP_AGENT_ID is required');

const bundle = JSON.parse(readFileSync(inputPath, 'utf8'));
const event = finalizeDecisionEvent(bundle.event);
const now = Date.now();
const signalText = formatDecisionEventForDelivery(event, { ...bundle.gate, now });

function lastJson(text) {
  for (const line of String(text).trim().split(/\r?\n/u).reverse()) {
    try { return JSON.parse(line); } catch { /* progress line */ }
  }
  throw new Error('command returned no JSON response');
}

function runJson(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    encoding: 'utf8', timeout: 30_000, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  const payload = lastJson(result.stdout);
  if (result.status !== 0 || payload.ok === false) {
    throw new Error(typeof payload.error === 'string' ? payload.error : `${command} business response failed`);
  }
  return payload;
}

const activePayload = runJson('onchainos', ['agent', 'subscribe-active', '--agent-id', agentId]);
const active = (Array.isArray(activePayload.data) ? activePayload.data : [])
  .filter((subscription) => subscription?.status === 1)
  .map((subscription) => String(subscription.jobId));

if (active.length === 0) throw new Error('no ACTIVE subscriber; executable publication fails closed');
if (dryRun) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(), event: 'decision_delivery_dry_run', decisionId: event.decisionId,
    activeCount: active.length, signalText,
  }));
  process.exit(0);
}

const providerPayload = runJson('onchainos', ['agent', 'my-subscriptions', '--role', 'provider']);
const providerSubscriptions = new Map(
  (Array.isArray(providerPayload.data?.list) ? providerPayload.data.list : [])
    .map((subscription) => [String(subscription.jobId), subscription]),
);
const runtime = new Database(statePath);
runtime.pragma('journal_mode = WAL');
runtime.pragma('synchronous = FULL');
runtime.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    job_id TEXT PRIMARY KEY, buyer_agent_id TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS deliveries (
    job_id TEXT NOT NULL, delivery_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','delivered','uncertain')),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT,
    PRIMARY KEY(job_id, delivery_key)
  );
`);
const store = new DecisionPublicationStore(statePath);
let delivered = 0;
const startedAt = new Date().toISOString();
try {
  store.begin(event, signalText, active.length, startedAt);
  for (const jobId of active) {
    const deliveryKey = `decision:${event.decisionId}`;
    const subscription = providerSubscriptions.get(jobId);
    const buyerAgentId = String(subscription?.buyerAgentId ?? '');
    if (subscription?.status !== 1 || !/^\d+$/u.test(buyerAgentId)) {
      throw new Error(`active subscription state is uncertain for ${jobId}`);
    }
    if (runtime.prepare('SELECT 1 FROM sessions WHERE job_id=?').get(jobId) === undefined) {
      const session = runJson('okx-a2a', [
        'session', 'create', '--job-id', jobId, '--my-agent-id', agentId,
        '--to-agent-id', buyerAgentId, '--json',
      ]);
      if (session.ok !== true) throw new Error(`session creation not acknowledged for ${jobId}`);
      runtime.prepare('INSERT INTO sessions(job_id,buyer_agent_id,created_at) VALUES(?,?,?)')
        .run(jobId, buyerAgentId, new Date().toISOString());
    }
    const deliveryAt = new Date().toISOString();
    runtime.prepare("INSERT INTO deliveries(job_id,delivery_key,status,created_at,updated_at) VALUES(?,?,'pending',?,?)")
      .run(jobId, deliveryKey, deliveryAt, deliveryAt);
    let payload;
    try {
      payload = runJson('onchainos', [
        'agent', 'deliver', jobId, '--deliverable-text', signalText, '--agent-id', agentId,
      ]);
      if (payload.delivered !== true) throw new Error(`delivery not acknowledged for active subscription ${jobId}`);
      runtime.prepare("UPDATE deliveries SET status='delivered',updated_at=?,error=NULL WHERE job_id=? AND delivery_key=?")
        .run(new Date().toISOString(), jobId, deliveryKey);
    } catch (error) {
      runtime.prepare("UPDATE deliveries SET status='uncertain',updated_at=?,error=? WHERE job_id=? AND delivery_key=?")
        .run(new Date().toISOString(), String(error).slice(0, 500), jobId, deliveryKey);
      throw error;
    }
    delivered += 1;
    console.log(JSON.stringify({
      ts: new Date().toISOString(), event: 'decision_delivery_succeeded',
      decisionId: event.decisionId, deliveryKey, jobId,
    }));
  }
  store.finish(event.decisionId, delivered, new Date().toISOString());
  console.log(JSON.stringify({
    ts: new Date().toISOString(), event: 'decision_publication_complete',
    decisionId: event.decisionId, activeCount: active.length, deliveredCount: delivered,
  }));
} catch (error) {
  if (store.get(event.decisionId) !== undefined) {
    store.uncertain(event.decisionId, delivered, error instanceof Error ? error.message : String(error), new Date().toISOString());
  }
  throw error;
} finally {
  store.close();
  runtime.close();
}
