import { describe, expect, it } from 'vitest';

import { calibrateExpectedGrossEdge, verifyEdgeCalibration } from './edge_calibration.js';
import type { BacktestTrade } from './engine.js';

const trade = (index: number, grossPnlUsdt: number, instId = 'BTC-USDT-SWAP'): BacktestTrade => ({
  signalId: `SIG-${index}`,
  strategyId: 'vol_expansion',
  instId: instId as BacktestTrade['instId'],
  side: 'long',
  regime: 'trending_up',
  openedAt: index * 2,
  closedAt: index * 2 + 1,
  holdBars: 1,
  entryPrice: 100,
  exitPrice: 101,
  contracts: 1,
  notionalUsdt: 100,
  grossPnlUsdt,
  feesUsdt: 0.1,
  fundingUsdt: 0,
  netPnlUsdt: grossPnlUsdt - 0.1,
  exitReason: 'timeout',
  equityAfter: 400,
  fundingFallbackSettlements: 0,
});

describe('expected gross-edge calibration', () => {
  it('is deterministic, instrument-specific, and tamper evident', () => {
    const trades = Array.from({ length: 40 }, (_, index) => trade(index, index % 4 === 0 ? -0.5 : 1));
    trades.push(trade(99, 100, 'ETH-USDT-SWAP'));
    const input = {
      trades,
      strategyId: 'vol_expansion',
      strategyVersion: '1.1.0',
      configHash: 'abc',
      instrument: 'BTC-USDT-SWAP' as const,
      calculatedAt: 1,
      iterations: 1_000,
      seed: 7,
    };
    const first = calibrateExpectedGrossEdge(input);
    const second = calibrateExpectedGrossEdge(input);
    expect(first).toEqual(second);
    expect(first.sampleSize).toBe(40);
    expect(first.grossMeanBps).toBeCloseTo(62.5, 8);
    expect(first.conservativeExpectedEdgeBps).toBeCloseTo(31.25, 8);
    expect(first.lowerConfidenceBoundBps).toBeLessThan(first.grossMeanBps);
    expect(verifyEdgeCalibration(first)).toBe(true);
    expect(verifyEdgeCalibration({ ...first, lowerConfidenceBoundBps: 999 })).toBe(false);
  });
});
