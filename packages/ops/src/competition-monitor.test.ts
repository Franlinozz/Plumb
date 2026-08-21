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
    expect(autoSource).toContain("'--unattended-second-entry'");
    expect(autoSource).toContain("runNode('competition-reconcile-exits.mjs'");
    expect(autoSource).toContain("runNode('competition-time-stop.mjs'");
    expect(autoSource.indexOf("runNode('competition-reconcile-exits.mjs'"))
      .toBeLessThan(autoSource.indexOf("runNode('competition-v3-monitor.mjs'"));
    expect(autoSource).not.toContain('direct REST');
    expect(autoUnit).toContain('competition-auto.env');
    expect(autoUnit).not.toContain('secrets.env');
    expect(autoUnit).toContain('competition-second-entry-auto.mjs');
  });

  it('routes the pre-authorised hard exit through the executor package', () => {
    expect(timeStopScriptSource).toContain('CompetitionTimeStopExecutor');
    expect(timeStopScriptSource).toContain('SECOND_ENTRY_AMENDMENT.hardExitAt');
    expect(timeStopScriptSource).not.toContain('.placeOrder(');
    expect(timeStopScriptSource).not.toContain('.closePosition(');
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
