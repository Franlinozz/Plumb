#!/usr/bin/env node
/**
 * NIGHTLY BACKUP.
 *
 * `VACUUM INTO` rather than a file copy, because the databases are live and in WAL mode — copying
 * `feed.db` while the runner holds it gives you a file that opens fine and is missing the last
 * transactions. Verification compares CONTENT HASHES, not sizes: a same-size corrupt file is
 * exactly the case a size check waves through.
 *
 * A backup that has never been restored is a hope, so this script restores every run into a scratch
 * directory and checks the hashes before it prunes anything.
 */

import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { backup, databaseIsReadable, pruneBackups, restore, verifyRestore } from '@plumb/ops';

const STATE_DIR = process.env.PLUMB_STATE_DIR ?? '/var/lib/plumb';
const BACKUP_ROOT = process.env.PLUMB_BACKUP_DIR ?? '/var/backups/plumb';
const KEEP = Number(process.env.PLUMB_BACKUP_KEEP ?? 14);

const now = Date.now();
const stamp = new Date(now).toISOString().slice(0, 19).replace(/[:T]/g, '-');
const targets = ['feed.db', 'governor.db', 'intents.db'].map((f) => ({
  label: f,
  path: join(STATE_DIR, f),
}));

const manifest = backup(targets, join(BACKUP_ROOT, stamp), now);

// Prove the backup restores before trusting it enough to prune older ones.
const scratch = join(tmpdir(), `plumb-backup-verify-${stamp}`);
rmSync(scratch, { recursive: true, force: true });
restore(manifest, scratch);
const verified = verifyRestore(manifest, scratch);
const readable = manifest.entries
  .filter((e) => e.ok)
  .map((e) => databaseIsReadable(join(scratch, e.label)));
rmSync(scratch, { recursive: true, force: true });

const allGood = verified.every((v) => v.identical) && readable.every(Boolean);

// Only prune once this run's backup has proven restorable. Otherwise a run of silent backup
// failures would quietly delete the last good copy.
const pruned = allGood ? pruneBackups(BACKUP_ROOT, KEEP) : [];

console.log(
  JSON.stringify({
    event: 'backup',
    stamp,
    ok: allGood,
    entries: manifest.entries.map((e) => ({ label: e.label, ok: e.ok, bytes: e.bytes })),
    verified: verified.map((v) => ({ label: v.label, identical: v.identical })),
    pruned: pruned.length,
    keep: KEEP,
  }),
);

if (!allGood) process.exit(1);
