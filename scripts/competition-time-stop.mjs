#!/usr/bin/env node
/** Execute the pre-authorised hard time-stop for a surviving second competition entry. */

import { existsSync, readFileSync } from 'node:fs';

import { DecisionPublicationStore } from '@plumb/asp';
import { SECOND_ENTRY_AMENDMENT, finalizeDecisionEvent } from '@plumb/core';
import { CliAtkClient, CompetitionLedgerStore, CompetitionTimeStopExecutor, IntentStore } from '@plumb/executor';

const expectedUid = process.env.PLUMB_COMPETITION_UID?.trim() ?? '';
if (!/^\d+$/u.test(expectedUid)) throw new Error('PLUMB_COMPETITION_UID is required outside the repository');
const stateDir = process.env.PLUMB_COMPETITION_STATE_DIR ?? '/var/lib/plumb-okxai';
const statePath = `${stateDir}/second-entry-auto.json`;
const now = Date.now();
if (!existsSync(statePath)) {
  console.log(JSON.stringify({ event: 'competition_time_stop_no_second_entry' }));
  process.exit(0);
}
const state = JSON.parse(readFileSync(statePath, 'utf8'));
if (state.status !== 'complete' || typeof state.bundlePath !== 'string') {
  throw new Error('second-entry workflow is not complete; time stop refuses uncertain state');
}
if (now < SECOND_ENTRY_AMENDMENT.hardExitAt) {
  console.log(JSON.stringify({ event: 'competition_time_stop_not_due',
    dueAt: new Date(SECOND_ENTRY_AMENDMENT.hardExitAt).toISOString() }));
  process.exit(0);
}

const bundle = JSON.parse(readFileSync(state.bundlePath, 'utf8'));
const event = finalizeDecisionEvent(bundle.event);
if (event.decisionId !== state.decisionId || event.instrument !== state.instrument) {
  throw new Error('time-stop state and immutable DecisionEvent disagree');
}
const publications = new DecisionPublicationStore(
  process.env.PLUMB_A2A_STATE ?? `${stateDir}/asp-delivery.db`,
);
const intents = new IntentStore(`${stateDir}/competition-exit-intents.db`);
const ledger = new CompetitionLedgerStore(`${stateDir}/competition-ledger.db`);
try {
  const venue = new CliAtkClient({ demo: false, allowLive: true,
    profile: 'competition', timeoutMs: 60_000 });
  const result = await new CompetitionTimeStopExecutor({ venue, publications, intents, ledger })
    .execute({ event, expectedUid, now });
  console.log(JSON.stringify({ event: 'competition_time_stop_complete', ...result }));
} finally {
  publications.close(); intents.close(); ledger.close();
}
