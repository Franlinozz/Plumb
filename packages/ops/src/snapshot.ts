/**
 * NIGHTLY STATE BACKUP, AND THE RESTORE.
 *
 * A backup nobody has restored is a hypothesis. The restore path is exercised in the P7 drills,
 * and `verifyRestore` compares content hashes rather than file sizes — a truncated SQLite file is
 * exactly the same size as a good one for most of its length.
 *
 * SQLite in WAL mode cannot be copied by simply reading the `.db` file: the newest writes live in
 * the `-wal` sidecar. `VACUUM INTO` is used instead, which produces a consistent single-file copy
 * of a live database without stopping the writer.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import Database from 'better-sqlite3';

export interface BackupTarget {
  /** Path to a SQLite database, or any file. */
  readonly path: string;
  readonly label: string;
}

export interface BackupResult {
  readonly label: string;
  readonly source: string;
  readonly destination: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly ok: boolean;
  readonly error?: string;
}

export interface BackupManifest {
  readonly at: number;
  readonly directory: string;
  readonly entries: readonly BackupResult[];
  readonly ok: boolean;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Back up each target into `destinationDir`.
 *
 * SQLite files go through `VACUUM INTO`, which is the only safe way to copy a live WAL database.
 * Anything else is copied byte-for-byte.
 */
export function backup(targets: readonly BackupTarget[], destinationDir: string, now: number): BackupManifest {
  mkdirSync(destinationDir, { recursive: true });
  const entries: BackupResult[] = [];

  for (const target of targets) {
    const destination = join(destinationDir, basename(target.path));
    if (!existsSync(target.path)) {
      entries.push({
        label: target.label,
        source: target.path,
        destination,
        bytes: 0,
        sha256: '',
        ok: false,
        error: 'source does not exist',
      });
      continue;
    }

    try {
      if (target.path.endsWith('.db')) {
        // VACUUM INTO: a consistent snapshot of a live WAL database, sidecars folded in.
        const db = new Database(target.path, { readonly: true });
        try {
          if (existsSync(destination)) rmSync(destination);
          db.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`);
        } finally {
          db.close();
        }
      } else {
        copyFileSync(target.path, destination);
      }
      entries.push({
        label: target.label,
        source: target.path,
        destination,
        bytes: statSync(destination).size,
        sha256: sha256File(destination),
        ok: true,
      });
    } catch (error) {
      entries.push({
        label: target.label,
        source: target.path,
        destination,
        bytes: 0,
        sha256: '',
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { at: now, directory: destinationDir, entries, ok: entries.every((e) => e.ok) };
}

export interface RestoreResult {
  readonly label: string;
  readonly restoredTo: string;
  readonly ok: boolean;
  readonly error?: string;
}

/** Restore a manifest into a directory. Refuses to overwrite unless told to. */
export function restore(
  manifest: BackupManifest,
  targetDir: string,
  options: { readonly overwrite?: boolean } = {},
): readonly RestoreResult[] {
  mkdirSync(targetDir, { recursive: true });
  return manifest.entries.map((entry) => {
    const destination = join(targetDir, basename(entry.destination));
    try {
      if (!entry.ok) throw new Error(`backup entry was not ok: ${entry.error ?? 'unknown'}`);
      if (existsSync(destination) && options.overwrite !== true) {
        throw new Error('destination exists and overwrite was not requested');
      }
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(entry.destination, destination);
      return { label: entry.label, restoredTo: destination, ok: true };
    } catch (error) {
      return {
        label: entry.label,
        restoredTo: destination,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

export interface RestoreVerification {
  readonly label: string;
  readonly expectedSha256: string;
  readonly actualSha256: string;
  readonly identical: boolean;
}

/**
 * Verify a restore by CONTENT HASH.
 *
 * Not by size: a truncated database has the same size as a healthy one right up to the point it
 * was cut, and "the file is there and looks about right" is how a bad backup survives until the
 * day it is needed.
 */
export function verifyRestore(manifest: BackupManifest, targetDir: string): readonly RestoreVerification[] {
  return manifest.entries
    .filter((e) => e.ok)
    .map((entry) => {
      const path = join(targetDir, basename(entry.destination));
      const actual = existsSync(path) ? sha256File(path) : '';
      return {
        label: entry.label,
        expectedSha256: entry.sha256,
        actualSha256: actual,
        identical: actual !== '' && actual === entry.sha256,
      };
    });
}

/** Keep the most recent N nightly directories; delete the rest. */
export function pruneBackups(rootDir: string, keep: number): readonly string[] {
  if (!existsSync(rootDir)) return [];
  const dirs = readdirSync(rootDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const removed: string[] = [];
  while (dirs.length > keep) {
    const oldest = dirs.shift();
    if (oldest === undefined) break;
    rmSync(join(rootDir, oldest), { recursive: true, force: true });
    removed.push(oldest);
  }
  return removed;
}

/** A SQLite file that opens and answers a query is a file that actually restored. */
export function databaseIsReadable(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const db = new Database(path, { readonly: true });
    try {
      db.prepare('SELECT name FROM sqlite_master LIMIT 1').get();
      return true;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}
