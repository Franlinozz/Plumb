#!/usr/bin/env node
/** Dedicated Agent Trade Kit competition entry point. Default is a non-writing preview. */

import { readFileSync } from 'node:fs';

import { DecisionPublicationStore } from '@plumb/asp';
import { SECOND_ENTRY_AMENDMENT, finalizeDecisionEvent } from '@plumb/core';
import {
  AgentTradeKitCompetitionExecutor,
  CliAtkClient,
  CompetitionLedgerStore,
  IntentStore,
} from '@plumb/executor';

const args = process.argv.slice(2);
const execute = args.includes('--execute');
const unattended = args.includes('--unattended-second-entry');
const inputPath = args.find((arg) => !arg.startsWith('--'));
if (inputPath === undefined) throw new Error('usage: competition-execute-decision.mjs <bundle.json> [--execute]');

const bundle = JSON.parse(readFileSync(inputPath, 'utf8'));
const event = finalizeDecisionEvent(bundle.event);
const expectedUid = process.env.PLUMB_COMPETITION_UID?.trim() ?? '';
const confirmation = process.env.PLUMB_LIVE_CONFIRMATION ?? '';
const stateDir = process.env.PLUMB_COMPETITION_STATE_DIR ?? '/var/lib/plumb-okxai';
const publicationDb = process.env.PLUMB_A2A_STATE ?? `${stateDir}/asp-delivery.db`;

if (!execute) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(), event: 'competition_decision_preview', decisionId: event.decisionId,
    instrument: event.instrument, direction: event.direction, riskUsd: event.riskUsd,
    positionPct: event.positionPct, leverage: event.leverage, validUntil: new Date(event.validUntil).toISOString(),
    note: 'No account query or order was sent. Publish this exact event first, then obtain decision-specific live confirmation.',
  }));
  process.exit(0);
}

if (!/^\d+$/u.test(expectedUid)) throw new Error('PLUMB_COMPETITION_UID is required outside the repository');
if (!unattended && confirmation !== `CONFIRM LIVE ${event.decisionId}`) {
  throw new Error(`PLUMB_LIVE_CONFIRMATION must equal CONFIRM LIVE ${event.decisionId}`);
}
if (unattended && event.approvalBasis !== SECOND_ENTRY_AMENDMENT.approvalBasis) {
  throw new Error('unattended execution is authorised only for the evidence-limited second entry');
}
if (bundle.risk === undefined) throw new Error('bundle.risk is required');

const publications = new DecisionPublicationStore(publicationDb);
const intents = new IntentStore(`${stateDir}/competition-intents.db`);
const ledger = new CompetitionLedgerStore(`${stateDir}/competition-ledger.db`);
const venue = new CliAtkClient({ demo: false, allowLive: true, profile: 'competition', timeoutMs: 60_000 });
const recorded = ledger.get(event.instrument);

try {
  const executor = new AgentTradeKitCompetitionExecutor({ venue, publications, intents });
  const priorLiveEntryCount = intents.all()
    .filter((intent) => intent.status === 'placed' && intent.signalId !== event.decisionId).length;
  const result = await executor.execute({
    event, expectedUid, ledgerSignedPosition: recorded?.signedPosition ?? 0,
    risk: bundle.risk, priorLiveEntryCount, liveConfirmation: confirmation,
    ...(unattended ? { unattendedAuthorizationAt: SECOND_ENTRY_AMENDMENT.unattendedExecutionAuthorisedAt } : {}),
    now: Date.now(),
  });
  ledger.set({ instrument: event.instrument, signedPosition: result.venueSignedPositionAfter,
    decisionId: result.decisionId, orderId: result.orderId, updatedAt: Date.now() });
  console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'competition_execution_complete', ...result }));
} finally {
  publications.close();
  intents.close();
  ledger.close();
}
