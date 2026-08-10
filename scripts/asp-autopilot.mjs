#!/usr/bin/env node
/**
 * Plumb OKX.AI subscription delivery daemon.
 *
 * This process is deliberately separate from P8. It holds no venue credentials, never places an
 * order, and only uses the official identity and communication CLIs for subscription delivery.
 * Executable signals will arrive through the on-demand DecisionEvent publisher; until that gate
 * exists, new subscribers receive one non-executable Copy-Trading Notice.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

import Database from 'better-sqlite3';

const DEFAULT_NOTICE =
  '[Copy-Trading Notice] Plumb Perpetual Signals: No new position is recommended for this period. Stay on the sidelines and manage position size carefully.';
const WELCOME_KEY = 'subscription-welcome-v1';

function parseArgs(argv) {
  const out = {
    once: false,
    dryRun: false,
    state: process.env.PLUMB_A2A_STATE ?? '/var/lib/plumb-okxai/asp-delivery.db',
    intervalMs: Number(process.env.PLUMB_A2A_INTERVAL_MS ?? 60_000),
    heartbeatMs: Number(process.env.PLUMB_A2A_HEARTBEAT_MS ?? 45_000),
    agentId: process.env.PLUMB_ASP_AGENT_ID ?? '',
    chainIndex: process.env.PLUMB_ASP_CHAIN_INDEX ?? '196',
    markDelivered: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--once') out.once = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--state') out.state = argv[++i] ?? '';
    else if (arg === '--interval-ms') out.intervalMs = Number(argv[++i]);
    else if (arg === '--heartbeat-ms') out.heartbeatMs = Number(argv[++i]);
    else if (arg === '--agent-id') out.agentId = argv[++i] ?? '';
    else if (arg === '--chain-index') out.chainIndex = argv[++i] ?? '';
    else if (arg === '--mark-delivered') out.markDelivered.push(argv[++i] ?? '');
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!/^\d+$/.test(out.agentId)) throw new Error('PLUMB_ASP_AGENT_ID or --agent-id is required');
  if (!/^\d+$/.test(out.chainIndex)) throw new Error('chain index must be numeric');
  if (!Number.isFinite(out.intervalMs) || out.intervalMs < 10_000) throw new Error('interval must be at least 10000ms');
  if (!Number.isFinite(out.heartbeatMs) || out.heartbeatMs < 10_000) throw new Error('heartbeat must be at least 10000ms');
  if (DEFAULT_NOTICE.length > 200) throw new Error('fallback notice exceeds 200 characters');
  return out;
}

function log(level, event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })}\n`);
}

function lastJson(text) {
  const lines = String(text).trim().split(/\r?\n/u).reverse();
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch {
      // Some commands emit progress lines before their final JSON object.
    }
  }
  throw new Error('command returned no JSON response');
}

function runJson(command, args, timeoutMs = 30_000) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw new Error(`${command} failed: ${result.error.message}`);
  const payload = lastJson(result.stdout);
  if (result.status !== 0 || payload.ok === false) {
    const reason = typeof payload.error === 'string' ? payload.error : 'business response was not successful';
    throw new Error(`${command} failed: ${reason.slice(0, 240)}`);
  }
  return payload;
}

function openState(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      job_id TEXT PRIMARY KEY,
      buyer_agent_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      job_id TEXT NOT NULL,
      delivery_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','delivered','uncertain')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      error TEXT,
      PRIMARY KEY(job_id, delivery_key)
    );
  `);
  const recovered = db
    .prepare("UPDATE deliveries SET status='uncertain', updated_at=?, error='restart before acknowledgement' WHERE status='pending'")
    .run(new Date().toISOString()).changes;
  if (recovered > 0) log('error', 'delivery_recovery_uncertain', { count: recovered });
  return db;
}

function activeJobIds(agentId) {
  const payload = runJson('onchainos', ['agent', 'subscribe-active', '--agent-id', agentId]);
  return new Set((Array.isArray(payload.data) ? payload.data : []).filter((j) => j?.status === 1).map((j) => String(j.jobId)));
}

function providerSubscriptions() {
  const payload = runJson('onchainos', ['agent', 'my-subscriptions', '--role', 'provider']);
  const list = Array.isArray(payload.data?.list) ? payload.data.list : [];
  return new Map(list.map((s) => [String(s.jobId), s]));
}

function ensureSession(db, jobId, buyerAgentId, agentId, dryRun) {
  if (db.prepare('SELECT 1 FROM sessions WHERE job_id=?').get(jobId)) return;
  if (dryRun) {
    log('info', 'session_dry_run', { jobId, buyerAgentId });
    return;
  }
  const payload = runJson('okx-a2a', [
    'session',
    'create',
    '--job-id',
    jobId,
    '--my-agent-id',
    agentId,
    '--to-agent-id',
    buyerAgentId,
    '--json',
  ]);
  if (payload.ok !== true) throw new Error('session creation was not acknowledged');
  db.prepare('INSERT INTO sessions(job_id,buyer_agent_id,created_at) VALUES(?,?,?)').run(
    jobId,
    buyerAgentId,
    new Date().toISOString(),
  );
  log('info', 'session_created', { jobId, buyerAgentId });
}

function deliverWelcome(db, jobId, agentId, dryRun) {
  const existing = db.prepare('SELECT status FROM deliveries WHERE job_id=? AND delivery_key=?').get(jobId, WELCOME_KEY);
  if (existing) {
    log('info', 'delivery_suppressed', { jobId, deliveryKey: WELCOME_KEY, status: existing.status });
    return;
  }
  if (dryRun) {
    log('info', 'delivery_dry_run', { jobId, deliveryKey: WELCOME_KEY, body: DEFAULT_NOTICE });
    return;
  }
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO deliveries(job_id,delivery_key,status,created_at,updated_at) VALUES(?,?,'pending',?,?)",
  ).run(jobId, WELCOME_KEY, now, now);
  try {
    const payload = runJson('onchainos', [
      'agent',
      'deliver',
      jobId,
      '--deliverable-text',
      DEFAULT_NOTICE,
      '--agent-id',
      agentId,
    ]);
    if (payload.ok !== true || payload.delivered !== true) throw new Error('delivery was not acknowledged');
    db.prepare("UPDATE deliveries SET status='delivered',updated_at=?,error=NULL WHERE job_id=? AND delivery_key=?").run(
      new Date().toISOString(),
      jobId,
      WELCOME_KEY,
    );
    log('info', 'delivery_succeeded', { jobId, deliveryKey: WELCOME_KEY });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.prepare("UPDATE deliveries SET status='uncertain',updated_at=?,error=? WHERE job_id=? AND delivery_key=?").run(
      new Date().toISOString(),
      message.slice(0, 240),
      jobId,
      WELCOME_KEY,
    );
    log('error', 'delivery_uncertain', { jobId, deliveryKey: WELCOME_KEY, error: message.slice(0, 240) });
  }
}

function heartbeat(chainIndex) {
  runJson('onchainos', ['agent', 'heartbeat', '--chain-index', chainIndex]);
  log('info', 'heartbeat_succeeded', { chainIndex });
}

function scan(db, options) {
  const active = activeJobIds(options.agentId);
  const subscriptions = providerSubscriptions();
  log('info', 'subscription_scan', { activeCount: active.size, providerCount: subscriptions.size });
  for (const jobId of active) {
    const subscription = subscriptions.get(jobId);
    if (!subscription || subscription.status !== 1) {
      log('warn', 'subscription_suppressed_uncertain', { jobId });
      continue;
    }
    const buyerAgentId = String(subscription.buyerAgentId ?? '');
    if (!/^\d+$/.test(buyerAgentId)) {
      log('warn', 'subscription_missing_buyer', { jobId });
      continue;
    }
    ensureSession(db, jobId, buyerAgentId, options.agentId, options.dryRun);
    deliverWelcome(db, jobId, options.agentId, options.dryRun);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const db = openState(options.state);
  for (const jobId of options.markDelivered.filter(Boolean)) {
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO deliveries(job_id,delivery_key,status,created_at,updated_at) VALUES(?,?,'delivered',?,?) ON CONFLICT(job_id,delivery_key) DO UPDATE SET status='delivered',updated_at=excluded.updated_at,error=NULL",
    ).run(jobId, WELCOME_KEY, now, now);
    log('info', 'delivery_marked_delivered', { jobId, deliveryKey: WELCOME_KEY });
  }
  if (options.markDelivered.length > 0 && options.once) {
    db.close();
    return;
  }

  log('info', 'asp_autopilot_started', {
    agentId: options.agentId,
    dryRun: options.dryRun,
    intervalMs: options.intervalMs,
    heartbeatMs: options.heartbeatMs,
  });
  let lastHeartbeat = 0;
  do {
    const now = Date.now();
    if (now - lastHeartbeat >= options.heartbeatMs) {
      try {
        heartbeat(options.chainIndex);
        lastHeartbeat = now;
      } catch (error) {
        log('error', 'heartbeat_failed', { error: (error instanceof Error ? error.message : String(error)).slice(0, 240) });
      }
    }
    try {
      scan(db, options);
    } catch (error) {
      log('error', 'subscription_scan_failed', { error: (error instanceof Error ? error.message : String(error)).slice(0, 240) });
    }
    if (options.once) break;
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
  } while (true);
  db.close();
}

main().catch((error) => {
  log('error', 'asp_autopilot_fatal', { error: (error instanceof Error ? error.message : String(error)).slice(0, 240) });
  process.exitCode = 1;
});
