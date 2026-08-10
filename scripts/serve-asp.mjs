#!/usr/bin/env node
/**
 * The ASP server process — the public surface on plumb.assayed.xyz.
 *
 * Read-only. It never places an order and never reads a trading credential; it serves the
 * published feed, the track record and the manifest. Structured JSON logs, no bodies, no keys.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { FeedStore, createApp } from '@plumb/asp';

const PORT = Number(process.env.PLUMB_ASP_PORT ?? 8432);
const FEED_PATH = process.env.PLUMB_FEED_PATH ?? '/var/lib/plumb/feed.db';
const STATUS_PATH = process.env.PLUMB_STATUS_PATH ?? '/var/lib/plumb/status.json';
const MODE = process.env.PLUMB_MODE ?? 'demo';
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

mkdirSync(dirname(FEED_PATH), { recursive: true });
const store = new FeedStore(FEED_PATH);
const startedAt = Date.now();

const log = (level, event, fields = {}) => {
  // Structured JSON. Never a request body, never key material.
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }));
};

/** The runner writes this file; the ASP only reads it. No model call, no venue call. */
function status() {
  try {
    if (!existsSync(STATUS_PATH)) return { lastCycleAt: undefined, haltFlags: {} };
    const raw = JSON.parse(readFileSync(STATUS_PATH, 'utf8'));
    return { lastCycleAt: raw.lastCycleAt, haltFlags: raw.haltFlags ?? {} };
  } catch {
    return { lastCycleAt: undefined, haltFlags: {} };
  }
}

const app = createApp({
  store,
  version: VERSION,
  mode: MODE,
  startedAt,
  now: () => Date.now(),
  status,
});

const server = app.listen(PORT, '127.0.0.1', () => {
  log('info', 'asp_started', { port: PORT, mode: MODE, version: VERSION, feed: FEED_PATH });
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    log('info', 'asp_stopping', { signal });
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
