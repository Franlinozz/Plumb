#!/usr/bin/env node
/**
 * COMPETITION PRE-FLIGHT — run this the moment the `competition` profile exists.
 *
 * Read-only. It places no orders and changes no state. It answers, in one shot, every question
 * that must be true before the competition snapshot at 2026-08-11T04:00Z:
 *
 *   1. Does the key authenticate at all?
 *   2. Is it bound to the registered uid supplied securely at runtime? Funding the wrong account is the
 *      one mistake here that costs real money and cannot be fixed by 04:00.
 *   3. Account level >= 2, or swaps cannot be traded at all (gotcha 13, sCode 51010).
 *   4. Is the >= 300 USDT in the TRADING account? A deposit lands in FUNDING, which does not
 *      count for perps and is not the same balance.
 *   5. Position mode — the whole net_mode class of bug (gotcha 19) depends on knowing this.
 *   6. Does the key carry withdrawal permission? It must NOT.
 *
 * Usage:  node scripts/competition-preflight.mjs
 */

import { execFileSync } from 'node:child_process';

const PROFILE = process.env.PLUMB_COMP_PROFILE ?? 'competition';
const REGISTERED_UID = process.env.PLUMB_COMPETITION_UID?.trim() ?? '';
const MIN_USDT = 300;
const TARGET_USDT = 400;

if (!/^\d+$/.test(REGISTERED_UID)) {
  console.error('PLUMB_COMPETITION_UID is required and must be supplied outside the repository');
  process.exit(2);
}

function okx(args) {
  try {
    const out = execFileSync('okx', ['--profile', PROFILE, '--live', '--json', ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      // execFileSync inherits stderr by default, which dumps the CLI's multi-line error on top of
      // the checklist and makes it unreadable. Capture it instead.
      stdio: ['ignore', 'pipe', 'pipe'],
      // The runner's sanitizeEnv lesson (gotcha 16) in reverse: make sure a stray OKX_API_* in the
      // ambient environment cannot silently override the profile we are trying to test.
      env: Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !/^OKX_(API_KEY|API_SECRET|API_PASSPHRASE)$/.test(k)),
      ),
    });
    return { ok: true, data: JSON.parse(out) };
  } catch (error) {
    const text = String(error.stdout ?? '') + String(error.stderr ?? '') + String(error.message ?? '');
    // One line. A pre-flight read at 3am is a checklist, not a stack trace.
    const first = text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !/^Version:/.test(l));
    return { ok: false, error: (first ?? 'unknown error').slice(0, 160) };
  }
}

const checks = [];
function check(name, status, detail) {
  checks.push({ name, status, detail });
  const mark = status === 'PASS' ? '  OK  ' : status === 'FAIL' ? ' FAIL ' : ' WARN ';
  console.log(`[${mark}] ${name.padEnd(34)} ${detail}`);
}

console.log(`\ncompetition pre-flight — profile "${PROFILE}", live\n${'-'.repeat(78)}`);

// ── 1 & 2 & 3 & 5. Account configuration. ──────────────────────────────────────────────────
const cfg = okx(['account', 'config']);
let acctLv;
if (!cfg.ok) {
  check('key authenticates', 'FAIL', cfg.error);
} else {
  const row = (Array.isArray(cfg.data) ? cfg.data[0] : (cfg.data?.data?.[0] ?? cfg.data)) ?? {};
  check('key authenticates', 'PASS', 'account config returned');

  const uid = String(row.uid ?? row.mainUid ?? '');
  check(
    'bound to REGISTERED uid',
    uid === REGISTERED_UID ? 'PASS' : 'FAIL',
    uid === REGISTERED_UID ? `…${uid.slice(-4)} matches registration` : `key reports …${uid.slice(-4)}, registration bound …${REGISTERED_UID.slice(-4)}`,
  );

  acctLv = String(row.acctLv ?? '');
  check(
    'account level >= 2 (swaps)',
    Number(acctLv) >= 2 ? 'PASS' : 'FAIL',
    `acctLv ${acctLv || '?'}${Number(acctLv) >= 2 ? '' : ' — swaps return sCode 51010 at this level'}`,
  );

  const posMode = String(row.posMode ?? '');
  check('position mode', 'PASS', `${posMode || 'unknown'}${posMode === 'net_mode' ? ' — opposing orders CLOSE, they do not open (gotcha 19)' : ''}`);

  const perm = String(row.perm ?? '');
  if (perm) {
    check(
      'no withdrawal permission',
      /withdraw/i.test(perm) ? 'FAIL' : 'PASS',
      `perm="${perm}"`,
    );
  } else {
    check('no withdrawal permission', 'WARN', 'perm not reported — confirm in the OKX key settings');
  }
}

// ── 4. Where the money actually is. ────────────────────────────────────────────────────────
function usdtFrom(payload) {
  const rows = Array.isArray(payload) ? payload : (payload?.data ?? []);
  for (const row of rows) {
    for (const d of row?.details ?? [row]) {
      if (String(d?.ccy).toUpperCase() === 'USDT') {
        return Number(d.eq ?? d.cashBal ?? d.availBal ?? d.bal ?? 0);
      }
    }
  }
  return 0;
}

const trading = okx(['account', 'balance', 'USDT']);
const funding = okx(['account', 'asset-balance', '--ccy', 'USDT']);

if (trading.ok) {
  const amount = usdtFrom(trading.data);
  check(
    `TRADING balance >= ${MIN_USDT} USDT`,
    amount >= MIN_USDT ? 'PASS' : 'FAIL',
    `${amount.toFixed(2)} USDT${amount >= MIN_USDT ? '' : ` — short by ${(TARGET_USDT - amount).toFixed(2)} of the ${TARGET_USDT} target`}`,
  );
} else {
  check(`TRADING balance >= ${MIN_USDT} USDT`, 'FAIL', trading.error);
}

if (funding.ok) {
  const amount = usdtFrom(funding.data);
  check(
    'funding account is empty',
    amount > 1 ? 'WARN' : 'PASS',
    amount > 1
      ? `${amount.toFixed(2)} USDT is sitting in FUNDING — it does NOT count for perps, transfer it to Trading`
      : `${amount.toFixed(2)} USDT`,
  );
}

// ── 6. The account must be flat at the snapshot. ───────────────────────────────────────────
const positions = okx(['account', 'positions', '--instType', 'SWAP']);
if (positions.ok) {
  const rows = Array.isArray(positions.data) ? positions.data : (positions.data?.data ?? []);
  const open = rows.filter((p) => Math.abs(Number(p.pos ?? 0)) > 0);
  check('no pre-existing positions', open.length === 0 ? 'PASS' : 'WARN',
    open.length === 0 ? 'flat' : open.map((p) => `${p.instId} ${p.pos}`).join(', '));
}

const failed = checks.filter((c) => c.status === 'FAIL');
const warned = checks.filter((c) => c.status === 'WARN');

console.log('-'.repeat(78));
console.log(`${checks.length} checks · ${failed.length} FAIL · ${warned.length} WARN`);
console.log(
  failed.length === 0
    ? '\nREADY for the snapshot. This says the ACCOUNT is ready. It says nothing about\nwhether a strategy is approved to trade — that gate is separate and still RED.\n'
    : `\nNOT READY. Fix: ${failed.map((c) => c.name).join('; ')}\n`,
);
process.exit(failed.length === 0 ? 0 : 1);
