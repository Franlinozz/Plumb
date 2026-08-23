#!/usr/bin/env node
/** Guarded resume for individually reconciled, zero-acknowledgement contingency incidents. */

import { execFileSync } from 'node:child_process';
import { existsSync, globSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';

import Database from 'better-sqlite3';

const RECONCILED_INCIDENTS = Object.freeze({
  'DEC-ru44MLpWgI': Object.freeze({
    instrument: 'SOL-USDT-SWAP',
    archiveName: 'second-entry-auto.DEC-ru44MLpWgI.20260823T1600Z.json',
  }),
  'DEC-POXps1ql_X': Object.freeze({
    instrument: 'ETH-USDT-SWAP',
    archiveName: 'second-entry-auto.DEC-POXps1ql_X.20260823T2200Z.json',
  }),
});
const stateDir = '/var/lib/plumb-okxai';
const statePath = `${stateDir}/second-entry-auto.json`;
const archiveDir = `${stateDir}/incidents`;
const execute = process.argv.includes('--execute');

if (!existsSync(statePath)) throw new Error('shared claim is absent; refusing an ambiguous resume');
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const incident = RECONCILED_INCIDENTS[state.decisionId];
if (incident === undefined || state.status !== 'uncertain' ||
    state.failedStage !== 'prepared' || state.instrument !== incident.instrument) {
  throw new Error('shared claim no longer matches the reconciled incident');
}
const expectedDecision = state.decisionId;
const archivePath = `${archiveDir}/${incident.archiveName}`;
if (existsSync(archivePath)) throw new Error('incident archive already exists; refusing a second resume');
const bundle = JSON.parse(readFileSync(state.bundlePath, 'utf8'));
if (bundle.event?.decisionId !== expectedDecision || Date.now() <= bundle.event.validUntil) {
  throw new Error('incident bundle mismatch or old decision is not yet expired');
}

const db = new Database(`${stateDir}/asp-delivery.db`, { readonly: true, fileMustExist: true });
const publication = db.prepare('SELECT status,active_count,delivered_count,created_at,signal_text FROM decision_publications WHERE decision_id=?')
  .get(expectedDecision);
const deliveryRows = db.prepare('SELECT status FROM deliveries WHERE delivery_key=?')
  .all(`decision:${expectedDecision}`);
db.close();
if (publication?.status !== 'uncertain' || publication.active_count !== 3 ||
    publication.delivered_count !== 0 || deliveryRows.length !== 1 ||
    deliveryRows[0]?.status !== 'uncertain') {
  throw new Error('publication ledger no longer matches the proven zero-acknowledgement incident');
}
const exactLocalCopies = globSync('/root/.onchainos/deliverables/asp/**/*.txt')
  .filter((path) => statSync(path).mtimeMs >= Date.parse(publication.created_at) - 5_000)
  .filter((path) => readFileSync(path, 'utf8') === publication.signal_text);
if (exactLocalCopies.length !== 0) {
  throw new Error('an exact executable deliverable exists locally; automatic incident clearance is forbidden');
}

const run = (...args) => execFileSync('systemctl', args, { encoding: 'utf8' }).trim();
if (!execute) {
  console.log(JSON.stringify({
    event: 'reconciled_contingency_resume_check_passed',
    decisionId: expectedDecision,
    publicationAcknowledgements: 0,
    action: 'rerun with --execute to archive the expired claim and resume the repaired services',
  }));
  process.exit(0);
}

let timerStopped = false;
try {
  if (run('is-active', 'plumb-runner.service') !== 'active') {
    throw new Error('protected P8 runner is not active; refusing unrelated recovery changes');
  }
  run('stop', 'plumb-okxai-deadline-contingency.timer');
  timerStopped = true;
  run('restart', 'plumb-okxai-a2a.service');
  if (run('is-active', 'plumb-okxai-a2a.service') !== 'active') {
    throw new Error('repaired A2A service did not become active');
  }
  mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  renameSync(statePath, archivePath);
  run('start', 'plumb-okxai-deadline-contingency.timer');
  timerStopped = false;
  if (run('is-active', 'plumb-okxai-deadline-contingency.timer') !== 'active') {
    throw new Error('contingency timer did not resume');
  }
  console.log(JSON.stringify({
    event: 'reconciled_contingency_resumed',
    decisionId: expectedDecision,
    archivedClaim: archivePath,
    a2a: 'active',
    timer: 'active',
    oldDecisionReplayable: false,
  }));
} catch (error) {
  if (timerStopped && existsSync(statePath)) {
    try { run('start', 'plumb-okxai-deadline-contingency.timer'); } catch { /* remains fail-closed */ }
  }
  throw error;
}
