import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'scripts/competition-v2-monitor.mjs'), 'utf8');
const v3Source = readFileSync(resolve(process.cwd(), 'scripts/competition-v3-monitor.mjs'), 'utf8');
const alertSource = readFileSync(
  resolve(process.cwd(), 'scripts/competition-v3-discord-alert.mjs'), 'utf8',
);
const autoSource = readFileSync(
  resolve(process.cwd(), 'scripts/competition-second-entry-auto.mjs'), 'utf8',
);
const autoUnit = readFileSync(
  resolve(process.cwd(), 'deploy/plumb-okxai-v3-opportunity-monitor.service'), 'utf8',
);
const exitReconcilerSource = readFileSync(
  resolve(process.cwd(), 'scripts/competition-reconcile-exits.mjs'), 'utf8',
);
const timeStopScriptSource = readFileSync(
  resolve(process.cwd(), 'scripts/competition-time-stop.mjs'), 'utf8',
);
const contingencyMonitorSource = readFileSync(
  resolve(process.cwd(), 'scripts/competition-deadline-contingency-monitor.mjs'), 'utf8',
);
const contingencyAutoSource = readFileSync(
  resolve(process.cwd(), 'scripts/competition-deadline-contingency-auto.mjs'), 'utf8',
);
const contingencyUnit = readFileSync(
  resolve(process.cwd(), 'deploy/plumb-okxai-deadline-contingency.service'), 'utf8',
);
const publisherSource = readFileSync(
  resolve(process.cwd(), 'scripts/asp-push-decision.mjs'), 'utf8',
);
const autopilotSource = readFileSync(
  resolve(process.cwd(), 'scripts/asp-autopilot.mjs'), 'utf8',
);
const reconciledResumeSource = readFileSync(
  resolve(process.cwd(), 'scripts/resume-reconciled-contingency.mjs'), 'utf8',
);

describe('the automated competition monitor is read-only by construction', () => {
  it('has no executor, A2A, account, credential, child-process, or order path', () => {
    for (const forbidden of [
      '@plumb/executor',
      '@plumb/asp',
      'child_process',
      'spawn',
      'execFile',
      'onchainos',
      'okx swap',
      'placeOrder',
      'process.env',
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it('keeps the authorised v3 opportunity monitor public-data-only', () => {
    for (const forbidden of [
      '@plumb/executor',
      '@plumb/asp',
      'child_process',
      'spawn',
      'execFile',
      'onchainos',
      'okx swap',
      'placeOrder',
      'process.env',
    ]) {
      expect(v3Source, forbidden).not.toContain(forbidden);
    }
    expect(v3Source).toContain('publicPreparationReady');
    expect(v3Source).toContain('executionEligible: false');
    expect(v3Source).toContain('exact live confirmation remain required');
  });

  it('keeps the Discord wrapper notification-only and idempotent', () => {
    for (const forbidden of ['@plumb/executor', '@plumb/asp', 'onchainos', 'okx swap', 'placeOrder']) {
      expect(alertSource, forbidden).not.toContain(forbidden);
    }
    expect(alertSource).toContain('publicPreparationReady !== true');
    expect(alertSource).toContain('discord_setup_alert_deduplicated');
    expect(alertSource).toContain('This is **not an order**');
    expect(alertSource).toContain('allowed_mentions: { parse: [] }');
  });

  it('makes unattended execution one-shot, publication-first, and no-retry on uncertainty', () => {
    expect(autoSource).toContain("status: 'prepared'");
    expect(autoSource.indexOf("save(state); // Durable one-shot claim"))
      .toBeLessThan(autoSource.indexOf("runNode('asp-push-decision.mjs'"));
    expect(autoSource.indexOf("runNode('asp-push-decision.mjs'"))
      .toBeLessThan(autoSource.indexOf("runNode('competition-execute-decision.mjs'"));
    expect(autoSource).toContain("status: 'executing'");
    expect(autoSource).toContain("status: 'uncertain'");
    expect(autoSource).toContain('NO AUTOMATIC RETRY');
    expect(autoSource).toContain('incidentAlertedAt');
    expect(autoSource).toContain('REQUIRES MANUAL RECONCILIATION');
    expect(autoSource).toContain('second_entry_public_check_rejected_no_write');
    expect(autoSource).toContain('second_entry_private_preflight_rejected_no_write');
    expect(autoSource).toContain('The other authorised instrument may still be evaluated');
    expect(autoSource).toContain("'--unattended-second-entry'");
    expect(autoSource).toContain("runNode('competition-reconcile-exits.mjs'");
    expect(autoSource).toContain("runNode('competition-time-stop.mjs'");
    expect(autoSource.indexOf("runNode('competition-reconcile-exits.mjs'"))
      .toBeLessThan(autoSource.indexOf("runNode('competition-v3-monitor.mjs'"));
    expect(autoSource).not.toContain('direct REST');
    expect(autoUnit).toContain('competition-auto.env');
    expect(autoUnit).not.toContain('secrets.env');
    expect(autoUnit).toContain('competition-second-entry-auto.mjs');
    expect(autoUnit.match(/competition-second-entry-auto\.mjs (?:BTC|ETH|SOL)-USDT-SWAP/gu))
      .toEqual([
        'competition-second-entry-auto.mjs BTC-USDT-SWAP',
        'competition-second-entry-auto.mjs ETH-USDT-SWAP',
        'competition-second-entry-auto.mjs SOL-USDT-SWAP',
      ]);
  });

  it('routes the pre-authorised hard exit through the executor package', () => {
    expect(timeStopScriptSource).toContain('CompetitionTimeStopExecutor');
    expect(timeStopScriptSource).toContain('SECOND_ENTRY_AMENDMENT.hardExitAt');
    expect(timeStopScriptSource).not.toContain('.placeOrder(');
    expect(timeStopScriptSource).not.toContain('.closePosition(');
  });

  it('keeps the deadline contingency mutually exclusive, time-gated and publication-first', () => {
    for (const forbidden of ['@plumb/executor', '@plumb/asp', 'child_process', 'process.env', 'placeOrder']) {
      expect(contingencyMonitorSource, forbidden).not.toContain(forbidden);
    }
    expect(contingencyMonitorSource).toContain('executionEligible: false');
    expect(contingencyAutoSource).toContain("statePath = `${stateDir}/second-entry-auto.json`");
    expect(contingencyAutoSource.indexOf('now < DEADLINE_CONTINGENCY_AMENDMENT.earliestEntryAt'))
      .toBeLessThan(contingencyAutoSource.indexOf("runNode('competition-deadline-contingency-monitor.mjs'"));
    expect(contingencyAutoSource.indexOf('save(state); // Durable shared one-shot claim'))
      .toBeLessThan(contingencyAutoSource.indexOf("runNode('asp-push-decision.mjs'"));
    expect(contingencyAutoSource.indexOf("runNode('asp-push-decision.mjs'"))
      .toBeLessThan(contingencyAutoSource.indexOf("runNode('competition-execute-decision.mjs'"));
    expect(contingencyAutoSource).toContain("'--unattended-deadline-contingency'");
    expect(contingencyAutoSource).toContain("status: 'uncertain'");
    expect(contingencyUnit).toContain('competition-auto.env');
    expect(contingencyUnit).not.toContain('secrets.env');
    expect(contingencyUnit).not.toContain('BTC-USDT-SWAP');
  });

  it('reconciles publication failures and suppresses contradictory no-trade notices', () => {
    expect(publisherSource).toContain('deliverWithPostcondition');
    expect(publisherSource).toContain('task-deliverable-list');
    expect(publisherSource).toContain('exactRemoteDeliveryExists');
    expect(publisherSource).toContain('error.retryable');
    expect(publisherSource).toContain('Date.now() + 60_000 < event.validUntil');
    expect(publisherSource).toContain('acquireDeliveryLock');
    expect(autopilotSource).toContain('competitionClaimBlocksNoTrade');
    expect(autopilotSource).toContain('acquireDeliveryLock');
    expect(autopilotSource.match(/competitionClaimBlocksNoTrade\(options\.state\)/gu)?.length)
      .toBeGreaterThanOrEqual(2);
    expect(autopilotSource).toContain('no_trade_suppressed_competition_claim');
    expect(autopilotSource).toContain("['prepared', 'published', 'executing', 'complete', 'uncertain']");
  });

  it('makes the incident resume exact, recoverable, and P8-gated', () => {
    expect(reconciledResumeSource).toContain("'DEC-ru44MLpWgI'");
    expect(reconciledResumeSource).toContain("'DEC-POXps1ql_X'");
    expect(reconciledResumeSource).toContain("state.status !== 'uncertain'");
    expect(reconciledResumeSource).toContain("state.failedStage !== 'prepared'");
    expect(reconciledResumeSource).toContain("publication.delivered_count !== 0");
    expect(reconciledResumeSource).toContain('exactLocalCopies.length !== 0');
    expect(reconciledResumeSource).toContain("run('is-active', 'plumb-runner.service')");
    expect(reconciledResumeSource).toContain('renameSync(statePath, archivePath)');
    expect(reconciledResumeSource).toContain("run('restart', 'plumb-okxai-a2a.service')");
    expect(reconciledResumeSource).toContain("run('start', 'plumb-okxai-deadline-contingency.timer')");
    expect(reconciledResumeSource).not.toContain('unlinkSync');
  });

  it('keeps native-exit reconciliation read-only at the venue and proof-gated', () => {
    expect(exitReconcilerSource).toContain("['tp', 'sl'].includes(candidate.actualSide)");
    expect(exitReconcilerSource).toContain("candidate.reduceOnly === 'true'");
    expect(exitReconcilerSource).toContain('closed-position history does not match');
    expect(exitReconcilerSource).toContain("kind: 'competition_protective_exit_reconciled'");
    expect(exitReconcilerSource).not.toContain('.placeOrder(');
    expect(exitReconcilerSource).not.toContain('.closePosition(');
    expect(exitReconcilerSource).not.toContain('fetch(');
  });

  it('prints an unconditional non-execution blocker while exposing public candidate readiness', () => {
    expect(source).toContain('executionEligible: false');
    expect(source).toContain('publicCandidateReady');
    expect(source).toContain('read-only monitor cannot query the account');
  });
});
