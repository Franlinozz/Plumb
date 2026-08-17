import { createHash } from 'node:crypto';

import type { Instrument } from '@plumb/core';

import type { BacktestTrade } from './engine.js';
import { percentile } from './monte_carlo.js';

export interface EdgeCalibrationRecord {
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly configHash: string;
  readonly instrument: Instrument;
  readonly sampleSize: number;
  readonly method: 'circular-block-bootstrap-gross-return';
  readonly blockSize: number;
  readonly iterations: number;
  readonly seed: number;
  readonly grossMeanBps: number;
  /** Predeclared 50% haircut; this is the executable edge estimate, not the statistical CI. */
  readonly conservativeExpectedEdgeBps: number;
  readonly analyticalLowerConfidenceBoundBps: number;
  readonly lowerConfidenceBoundBps: number;
  readonly calculatedAt: number;
  readonly signature: string;
}

export interface EdgeCalibrationInput {
  readonly trades: readonly BacktestTrade[];
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly configHash: string;
  readonly instrument: Instrument;
  readonly calculatedAt: number;
  readonly blockSize?: number;
  readonly iterations?: number;
  readonly seed?: number;
}

type UnsignedCalibration = Omit<EdgeCalibrationRecord, 'signature'>;

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const signatureOf = (record: UnsignedCalibration): string =>
  createHash('sha256').update(JSON.stringify(record)).digest('hex');

export function verifyEdgeCalibration(record: EdgeCalibrationRecord): boolean {
  const { signature: _signature, ...unsigned } = record;
  return record.signature === signatureOf(unsigned);
}

/**
 * Conservative expected gross edge per instrument. Resampling contiguous circular blocks keeps
 * clusters of wins/losses together instead of pretending every trade is independent. Gross edge
 * is intentional: the live decision gate compares it with a fresh, explicit friction estimate.
 */
export function calibrateExpectedGrossEdge(input: EdgeCalibrationInput): EdgeCalibrationRecord {
  const rows = input.trades
    .filter((trade) => trade.strategyId === input.strategyId && trade.instId === input.instrument)
    .sort((a, b) => a.closedAt - b.closedAt);
  if (rows.length === 0) throw new Error(`no calibration trades for ${input.instrument}`);
  const returns = rows.map((trade) => {
    if (!Number.isFinite(trade.notionalUsdt) || trade.notionalUsdt <= 0) {
      throw new Error(`invalid calibration notional for ${trade.signalId}`);
    }
    return trade.grossPnlUsdt / trade.notionalUsdt * 10_000;
  });
  const blockSize = input.blockSize ?? 5;
  const iterations = input.iterations ?? 10_000;
  const seed = input.seed ?? 20260817;
  if (!Number.isInteger(blockSize) || blockSize < 2 || blockSize > returns.length) {
    throw new Error('calibration block size is invalid');
  }
  if (!Number.isInteger(iterations) || iterations < 1_000) {
    throw new Error('calibration iterations are insufficient');
  }

  const random = prng(seed);
  const means: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let total = 0;
    let sampled = 0;
    while (sampled < returns.length) {
      const start = Math.floor(random() * returns.length);
      for (let offset = 0; offset < blockSize && sampled < returns.length; offset += 1) {
        total += returns[(start + offset) % returns.length]!;
        sampled += 1;
      }
    }
    means.push(total / returns.length);
  }

  const grossMeanBps = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const sampleVariance = returns.length < 2 ? 0 : returns.reduce(
    (sum, value) => sum + (value - grossMeanBps) ** 2,
    0,
  ) / (returns.length - 1);
  const analyticalLowerConfidenceBoundBps = grossMeanBps -
    1.96 * Math.sqrt(sampleVariance / returns.length);
  const unsigned: UnsignedCalibration = {
    strategyId: input.strategyId,
    strategyVersion: input.strategyVersion,
    configHash: input.configHash,
    instrument: input.instrument,
    sampleSize: returns.length,
    method: 'circular-block-bootstrap-gross-return',
    blockSize,
    iterations,
    seed,
    grossMeanBps,
    conservativeExpectedEdgeBps: Math.max(0, grossMeanBps * 0.5),
    analyticalLowerConfidenceBoundBps,
    // Circular blocks can be slightly biased for periodic samples. A lower bound must never be
    // more optimistic than the observed mean, regardless of the resampling geometry.
    lowerConfidenceBoundBps: Math.min(
      analyticalLowerConfidenceBoundBps,
      grossMeanBps,
      percentile(means, 0.05),
    ),
    calculatedAt: input.calculatedAt,
  };
  return { ...unsigned, signature: signatureOf(unsigned) };
}
