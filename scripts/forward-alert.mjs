#!/usr/bin/env node
/** Best-effort post-competition recorder alert. Never logs or persists the webhook credential. */

const webhook = (process.env.PLUMB_ALERT_WEBHOOK ?? process.env.PLUMB_DISCORD_WEBHOOK ?? '').trim();
const isTest = process.argv.includes('--test');
const result = process.env.SERVICE_RESULT ?? 'unknown';

if (!isTest && result === 'success') process.exit(0);
if (webhook === '') {
  console.log(JSON.stringify({ event: 'forward_alert_skipped', reason: 'webhook_not_configured', serviceResult: result }));
  process.exit(0);
}

let endpoint;
try {
  endpoint = new URL(webhook);
} catch {
  throw new Error('PLUMB_ALERT_WEBHOOK is not a valid URL');
}
if (endpoint.protocol !== 'https:') throw new Error('PLUMB_ALERT_WEBHOOK must use HTTPS');
const discord = /(^|\.)discord\.com$/u.test(endpoint.hostname);
if (discord) endpoint.searchParams.set('wait', 'true');

const content = isTest
  ? '✅ **Plumb forward alerts connected**\nThis is a notification test. No signal was emitted and no trade was placed.'
  : [
      '🚨 **PLUMB FORWARD RECORDER FAILED**',
      `Host: ${process.env.PLUMB_HOST_LABEL ?? 'plumb-vps'}`,
      `Service result: ${result}`,
      `Exit: ${process.env.EXIT_CODE ?? 'unknown'} / ${process.env.EXIT_STATUS ?? 'unknown'}`,
      `Time: ${new Date().toISOString()}`,
      'Forward evidence is paused until the recorder is healthy. Live execution remains locked.',
    ].join('\n');

let response;
try {
  response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(discord
      ? { username: 'Plumb Monitor', content, allowed_mentions: { parse: [] } }
      : { event: isTest ? 'plumb_forward_alert_test' : 'plumb_forward_recorder_failed', content }),
    signal: AbortSignal.timeout(15_000),
  });
} catch {
  throw new Error('forward alert delivery failed before an HTTP response');
}
if (!response.ok) throw new Error(`forward alert delivery failed with HTTP ${response.status}`);
console.log(JSON.stringify({ event: isTest ? 'forward_alert_test_delivered' : 'forward_alert_delivered', ok: true }));
