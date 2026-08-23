#!/usr/bin/env node
/** Incident-specific, guarded resume after DEC-ru44MLpWgI was proven unpublished and unexecuted. */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';

import Database from 'better-sqlite3';

const EXPECTED_DECISION = 'DEC-ru44MLpWgI';
const stateDir = '/var/lib/plumb-okxai';
const statePath = `${stateDir}/second-entry-auto.json`;
const archiveDir = `${stateDir}/incidents`;
const archivePath = `${archiveDir}/second-entry-auto.${EXPECTED_DECISION}.20260823T1600Z.json`;
const execute = process.argv.includes('--execute');

if (!existsSync(statePath)) throw new Error('shared claim is absent; refusing an ambiguous resume');
if (existsSync(archivePath)) throw new Error('incident archive already exists; refusing a second resume');
const state = JSON.parse(readFileSync(statePath, 'utf8'));
if (state.decisionId !== EXPECTED_DECISION || state.status !== 'uncertain' ||
    state.failedStage !== 'prepared' || state.instrument !== 'SOL-USDT-SWAP') {
  throw new Error('shared claim no longer matches the reconciled incident');
}
const bundle = JSON.parse(readFileSync(state.bundlePath, 'utf8'));
if (bundle.event?.decisionId !== EXPECTED_DECISION || Date.now() <= bundle.event.validUntil) {
  throw new Error('incident bundle mismatch or old decision is not yet expired');
}

const db = new Database(`${stateDir}/asp-delivery.db`, { readonly: true, fileMustExist: true });
const publication = db.prepare('SELECT status,active_count,delivered_count FROM decision_publications WHERE decision_id=?')
  .get(EXPECTED_DECISION);
const deliveryRows = db.prepare('SELECT status FROM deliveries WHERE delivery_key=?')
  .all(`decision:${EXPECTED_DECISION}`);
db.close();
if (publication?.status !== 'uncertain' || publication.active_count !== 3 ||
    publication.delivered_count !== 0 || deliveryRows.length !== 1 ||
    deliveryRows[0]?.status !== 'uncertain') {
  throw new Error('publication ledger no longer matches the proven zero-acknowledgement incident');
}

const run = (...args) => execFileSync('systemctl', args, { encoding: 'utf8' }).trim();
if (!execute) {
  console.log(JSON.stringify({
    event: 'reconciled_contingency_resume_check_passed',
    decisionId: EXPECTED_DECISION,
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
    decisionId: EXPECTED_DECISION,
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
