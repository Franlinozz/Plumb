import { mkdirSync, renameSync, rmdirSync, statSync } from 'node:fs';

export interface DeliveryLockOptions {
  readonly timeoutMs?: number;
  readonly staleMs?: number;
  readonly pollMs?: number;
  readonly now?: () => number;
}

const pause = (milliseconds: number): void => {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, milliseconds);
};

/**
 * Cross-process mutex for every OKX.AI deliver command.
 *
 * `onchainos agent deliver` uses shared local/runtime state and must never be invoked concurrently
 * by the scheduled no-trade daemon and the on-demand executable-signal publisher. The lock is a
 * directory because mkdir is atomic across processes. A very old orphan can be quarantined after
 * the maximum plausible delivery batch duration; live locks are never removed.
 */
export function acquireDeliveryLock(
  lockPath: string,
  options: DeliveryLockOptions = {},
): () => void {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const staleMs = options.staleMs ?? 600_000;
  const pollMs = options.pollMs ?? 100;
  const now = options.now ?? Date.now;
  const startedAt = now();

  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        rmdirSync(lockPath);
      };
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : '';
      if (code !== 'EEXIST') throw error;
    }

    try {
      const ageMs = now() - statSync(lockPath).mtimeMs;
      if (ageMs > staleMs) {
        const quarantined = `${lockPath}.stale-${process.pid}-${now()}`;
        try {
          renameSync(lockPath, quarantined);
          rmdirSync(quarantined);
          continue;
        } catch (error) {
          const code = error instanceof Error && 'code' in error ? String(error.code) : '';
          if (!['ENOENT', 'EEXIST'].includes(code)) throw error;
        }
      }
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : '';
      if (code !== 'ENOENT') throw error;
    }

    if (now() - startedAt >= timeoutMs) {
      throw new Error('timed out waiting for the exclusive A2A delivery lock');
    }
    pause(pollMs);
  }
}
