/**
 * HOSTILE-STRATEGY SIMULATION.
 *
 * Replays real market history against a strategy designed to be as dangerous as the rules allow:
 * it tries to open the maximum permitted size on every single bar, on every instrument, with the
 * tightest stop that will pass. It is not trying to make money. It is trying to find the hole.
 *
 * The governor must survive it. Specifically: no approval may breach a locked parameter, and the
 * account must not run past the kill switch.
 *
 * Pure — candles in, result out. No clock, no I/O, no randomness.
 */

import type { Instrument, Signal } from '@plumb/core';
import { contractsToNotional, specFor } from '@plumb/market';

import { assessDrawdown, updatePeak } from './drawdown.js';
import { evaluate, type RiskSnapshot } from './governor.js';
import { DEFAULT_RISK_CONFIG, LOCKED, type RiskConfig } from './params.js';
import { initialState, rollDailyIfNeeded, type GovernorState, type OpenPosition } from './state.js';

export interface SimCandle {
  readonly ts: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

export interface SimOptions {
  readonly candles: Readonly<Partial<Record<Instrument, readonly SimCandle[]>>>;
  readonly startingEquity?: number;
  /** Adverse fill on a stop, as a fraction. Real stops do not fill at the printed price. */
  readonly slippagePct?: number;
  /**
   * Stop distances the hostile strategy will try, TIGHTEST FIRST, taking the first one the
   * governor approves. A tight stop demands a huge notional, so this is "give me the biggest
   * position you will actually let me have" — which is what an adversary does, rather than
   * asking once for the impossible and giving up.
   */
  readonly stopDistancePct?: number | readonly number[];
  readonly maxHoldBars?: number;
  readonly fundingRate?: number;
  readonly config?: RiskConfig;
}

export interface SimTrade {
  readonly instId: Instrument;
  readonly side: 'long' | 'short';
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly contracts: number;
  readonly pnlUsdt: number;
  readonly reason: 'stop' | 'timeout';
  readonly openedAt: number;
  readonly closedAt: number;
}

export interface SimResult {
  readonly startingEquity: number;
  readonly finalEquity: number;
  readonly minEquity: number;
  readonly bars: number;
  readonly approvals: number;
  readonly trades: readonly SimTrade[];
  readonly wins: number;
  readonly losses: number;
  readonly vetoes: Readonly<Record<string, number>>;
  readonly killSwitchFiredAt: number | undefined;
  readonly approvalsAfterKillSwitch: number;
  readonly worstApprovedRiskUsdt: number;
  readonly worstApprovedLeverage: number;
  readonly maxTotalNotional: number;
  readonly state: GovernorState;
}

/** Veto codes a wider stop (and therefore a smaller position) could plausibly satisfy. */
const RETRY_WITH_WIDER_STOP: ReadonlySet<string> = new Set([
  'max_total_notional',
  'correlated_exposure',
  'below_minimum_size',
  'funding_cost',
  'leverage_ceiling',
  'risk_exceeds_budget',
]);

export function simulateHostile(options: SimOptions): SimResult {
  const startingEquity = options.startingEquity ?? LOCKED.CAPITAL_USDT;
  const slippage = options.slippagePct ?? 0.0005;
  const stopLadder =
    options.stopDistancePct === undefined
      ? [0.002, 0.005, 0.0075, 0.01, 0.015, 0.02, 0.03]
      : Array.isArray(options.stopDistancePct)
        ? options.stopDistancePct
        : [options.stopDistancePct as number];
  const maxHoldBars = options.maxHoldBars ?? 8;
  const fundingRate = options.fundingRate ?? 0;
  const config = options.config ?? DEFAULT_RISK_CONFIG;

  const instruments = (Object.keys(options.candles) as Instrument[]).filter(
    (i) => (options.candles[i]?.length ?? 0) > 0,
  );
  const bars = Math.min(...instruments.map((i) => options.candles[i]?.length ?? 0));

  let state: GovernorState = { ...initialState(0, startingEquity) };
  const trades: SimTrade[] = [];
  const vetoes: Record<string, number> = {};
  let approvals = 0;
  let approvalsAfterKillSwitch = 0;
  let killSwitchFiredAt: number | undefined;
  let minEquity = startingEquity;
  let worstApprovedRiskUsdt = 0;
  let worstApprovedLeverage = 0;
  let maxTotalNotional = 0;
  let idCounter = 0;

  /** Open positions carry the bar index they opened on, for the timeout rule. */
  const openedAtBar = new Map<string, number>();

  for (let bar = 0; bar < bars; bar += 1) {
    const now = options.candles[instruments[0] as Instrument]?.[bar]?.ts ?? bar;
    state = rollDailyIfNeeded(state, now);

    // ── 1. Manage open positions: stop first, then timeout. ────────────────────────────────
    const stillOpen: OpenPosition[] = [];
    for (const position of state.openPositions) {
      const candle = options.candles[position.instId]?.[bar];
      if (candle === undefined) {
        stillOpen.push(position);
        continue;
      }
      const spec = specFor(position.instId);
      const hitStop =
        position.side === 'long' ? candle.low <= position.stopPrice : candle.high >= position.stopPrice;
      const heldFor = bar - (openedAtBar.get(position.signalId) ?? bar);

      if (hitStop || heldFor >= maxHoldBars) {
        // A stop fills WORSE than its printed price. Assuming otherwise flatters every result.
        const exitPrice = hitStop
          ? position.side === 'long'
            ? position.stopPrice * (1 - slippage)
            : position.stopPrice * (1 + slippage)
          : candle.close;
        const direction = position.side === 'long' ? 1 : -1;
        const pnl = (exitPrice - position.entryPrice) * direction * position.contracts * spec.ctVal;

        trades.push({
          instId: position.instId,
          side: position.side,
          entryPrice: position.entryPrice,
          exitPrice,
          contracts: position.contracts,
          pnlUsdt: pnl,
          reason: hitStop ? 'stop' : 'timeout',
          openedAt: position.openedAt,
          closedAt: candle.ts,
        });

        state = {
          ...updatePeak(state, state.equity + pnl),
          realisedPnlToday: state.realisedPnlToday + pnl,
          consecutiveLosses: pnl < 0 ? state.consecutiveLosses + 1 : 0,
        };
        openedAtBar.delete(position.signalId);
      } else {
        stillOpen.push(position);
      }
    }
    state = {
      ...state,
      openPositions: stillOpen,
      totalNotional: stillOpen.reduce((sum, p) => sum + p.notionalUsdt, 0),
    };
    minEquity = Math.min(minEquity, state.equity);

    // ── 2. The kill switch, evaluated every bar rather than only when a signal arrives. ────
    if (state.equity <= LOCKED.KILL_SWITCH_EQUITY_USDT && !state.haltFlags.killSwitch) {
      state = {
        ...state,
        haltFlags: { ...state.haltFlags, killSwitch: true },
        haltReason: `equity ${state.equity.toFixed(2)} <= ${LOCKED.KILL_SWITCH_EQUITY_USDT}`,
        haltedAt: now,
      };
      killSwitchFiredAt = now;
      // Flatten: the hostile sim closes at the current close, as a market order would.
      for (const position of state.openPositions) {
        const candle = options.candles[position.instId]?.[bar];
        if (candle === undefined) continue;
        const spec = specFor(position.instId);
        const direction = position.side === 'long' ? 1 : -1;
        const pnl = (candle.close - position.entryPrice) * direction * position.contracts * spec.ctVal;
        trades.push({
          instId: position.instId,
          side: position.side,
          entryPrice: position.entryPrice,
          exitPrice: candle.close,
          contracts: position.contracts,
          pnlUsdt: pnl,
          reason: 'timeout',
          openedAt: position.openedAt,
          closedAt: candle.ts,
        });
        state = { ...updatePeak(state, state.equity + pnl), realisedPnlToday: state.realisedPnlToday + pnl };
      }
      state = { ...state, openPositions: [], totalNotional: 0 };
      minEquity = Math.min(minEquity, state.equity);
    }

    // ── 3. The hostile strategy: try EVERY instrument, EVERY bar, maximum size. ────────────
    for (const instId of instruments) {
      const candle = options.candles[instId]?.[bar];
      if (candle === undefined) continue;
      const price = candle.close;
      // Alternate direction so the book is not accidentally hedged into safety.
      const side: 'long' | 'short' = (bar + instruments.indexOf(instId)) % 2 === 0 ? 'long' : 'short';

      for (const stopDistance of stopLadder) {
      const stopPrice = side === 'long' ? price * (1 - stopDistance) : price * (1 + stopDistance);

      idCounter += 1;
      const signal: Signal = {
        id: `SIG-${String(idCounter).padStart(10, '0')}`.slice(0, 14),
        ts: candle.ts,
        instId,
        side,
        intent: 'open',
        entry: { type: 'market', price },
        stop: { price: stopPrice, distancePct: stopDistance, basis: 'atr' },
        timeframe: '1H',
        strategyId: 'hostile',
        regime: 'trending_up',
        inputs: {},
        invalidation: { maxHoldBars, conditions: [] },
        expiresAt: candle.ts + 7_200_000,
        version: '0.0.0-hostile',
      };

      const snapshot: RiskSnapshot = {
        instId,
        ts: candle.ts,
        degraded: false,
        degradedFields: [],
        last: price,
        funding: { current: fundingRate },
      };

      const verdict = evaluate(signal, state, snapshot, candle.ts, config);
      state = verdict.state;

      if (!verdict.approved) {
        vetoes[verdict.code] = (vetoes[verdict.code] ?? 0) + 1;
        // Only keep trying when a DIFFERENT STOP could change the answer. A halt, a
        // concurrency cap or an averaging-down veto is not a sizing problem, and retrying it
        // six times would just inflate the veto counts with noise.
        if (!RETRY_WITH_WIDER_STOP.has(verdict.code)) break;
        continue;
      }

      approvals += 1;
      if (state.haltFlags.killSwitch) approvalsAfterKillSwitch += 1;

      const spec = specFor(instId);
      const notional = contractsToNotional(verdict.sizing.contracts, price, spec);
      worstApprovedRiskUsdt = Math.max(worstApprovedRiskUsdt, verdict.sizing.actualRiskUsdt);
      worstApprovedLeverage = Math.max(worstApprovedLeverage, verdict.sizing.leverage);

      const position: OpenPosition = {
        instId,
        side,
        contracts: verdict.sizing.contracts,
        notionalUsdt: notional,
        entryPrice: price,
        stopPrice,
        openedAt: candle.ts,
        signalId: signal.id,
      };
      openedAtBar.set(signal.id, bar);
      state = {
        ...state,
        openPositions: [...state.openPositions, position],
        totalNotional: state.totalNotional + notional,
      };
      maxTotalNotional = Math.max(maxTotalNotional, state.totalNotional);
      break; // position opened for this instrument on this bar
      }
    }
  }

  const wins = trades.filter((t) => t.pnlUsdt > 0).length;
  return {
    startingEquity,
    finalEquity: state.equity,
    minEquity,
    bars,
    approvals,
    trades,
    wins,
    losses: trades.length - wins,
    vetoes,
    killSwitchFiredAt,
    approvalsAfterKillSwitch,
    worstApprovedRiskUsdt,
    worstApprovedLeverage,
    maxTotalNotional,
    state,
  };
}

/** The floor the governor is expected to defend, given one open trade can still be running. */
export function expectedFloor(): number {
  // New positions stop at the −12% rung. From a 400 peak that is 352, and the worst a single
  // remaining position can add is one full per-trade risk plus slippage.
  return LOCKED.KILL_SWITCH_EQUITY_USDT;
}

/** Assess drawdown at a point — re-exported so the sim script can narrate the ladder. */
export { assessDrawdown };
