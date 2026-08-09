/**
 * BAR-BY-BAR REPLAY OF THE FULL PIPELINE.
 *
 * snapshot → strategy → gate → portfolio → governor → simulated execution.
 *
 * The governor is IN THE LOOP. A backtest that skips it is measuring a system we will never run,
 * and would report the returns of a strategy we would never be allowed to trade.
 *
 * **Strict causality.** At bar N the engine may only see data through bar N's close. Every window
 * handed to the strategy passes `assertNoLookahead` before it is used, so a lookahead bug throws
 * instead of quietly producing a wonderful result.
 */

import type { Instrument } from '@plumb/core';
import { specFor, snapshotFromCandles, type Candle, type Timeframe } from '@plumb/market';
import {
  DEFAULT_STRATEGY_CONFIG,
  createSeededIdFactory,
  runCycle,
  type EngineState,
  type OpenPosition as StrategyPosition,
  type StrategyConfig,
  type StrategyModule,
} from '@plumb/strategy';
import {
  DEFAULT_RISK_CONFIG,
  assessDrawdown,
  evaluate as governorEvaluate,
  initialState,
  rollDailyIfNeeded,
  updatePeak,
  type GovernorState,
  type OpenPosition,
  type RiskConfig,
  type RiskSnapshot,
} from '@plumb/risk';

import {
  DEFAULT_COSTS,
  entryFillPrice,
  exitFillPrice,
  feeUsdt,
  fundingOverHold,
  slippageBps,
  stopFillPrice,
  type CostModel,
  type FundingSeries,
} from './costs.js';

export class LookaheadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LookaheadError';
  }
}

/**
 * The causality assertion.
 *
 * Deliberately cheap and deliberately called on every window: a lookahead bug is invisible in the
 * output (it just makes the numbers better) so it has to be caught structurally.
 */
export function assertNoLookahead(
  window: readonly Candle[],
  currentTs: number,
  label = 'window',
): void {
  for (const candle of window) {
    if (candle.ts > currentTs) {
      throw new LookaheadError(
        `${label} contains a bar at ${new Date(candle.ts).toISOString()}, after the current bar ` +
          `at ${new Date(currentTs).toISOString()} — this is lookahead`,
      );
    }
  }
}

export interface BacktestTrade {
  readonly signalId: string;
  readonly strategyId: string;
  readonly instId: Instrument;
  readonly side: 'long' | 'short';
  readonly regime: string;
  readonly openedAt: number;
  readonly closedAt: number;
  readonly holdBars: number;
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly contracts: number;
  readonly notionalUsdt: number;
  readonly grossPnlUsdt: number;
  readonly feesUsdt: number;
  readonly fundingUsdt: number;
  readonly netPnlUsdt: number;
  readonly exitReason: 'stop' | 'timeout' | 'flatten';
  readonly equityAfter: number;
  readonly fundingFallbackSettlements: number;
}

export interface EquityPoint {
  readonly ts: number;
  readonly equity: number;
}

export interface BacktestResult {
  readonly startingEquity: number;
  readonly finalEquity: number;
  readonly trades: readonly BacktestTrade[];
  readonly equityCurve: readonly EquityPoint[];
  readonly cycles: number;
  readonly signalsEmitted: number;
  readonly gateRejections: Readonly<Record<string, number>>;
  readonly governorVetoes: Readonly<Record<string, number>>;
  readonly killSwitchTriggers: number;
  readonly dailyLimitTriggers: number;
  readonly fundingFallbackSettlements: number;
  readonly fundingPaidUsdt: number;
  readonly fundingReceivedUsdt: number;
  readonly totalFeesUsdt: number;
  readonly fromTs: number;
  readonly toTs: number;
  readonly state: GovernorState;
}

export interface BacktestOptions {
  readonly candles: Readonly<Partial<Record<Instrument, readonly Candle[]>>>;
  readonly funding?: Readonly<Partial<Record<Instrument, FundingSeries>>>;
  readonly timeframe?: Timeframe;
  readonly lookbackBars?: number;
  readonly startingEquity?: number;
  readonly strategyConfig?: StrategyConfig;
  readonly riskConfig?: RiskConfig;
  readonly costs?: CostModel;
  readonly seed?: number;
  readonly fromTs?: number;
  readonly toTs?: number;
  /** Override the strategy set — used by tests to drive the harness with a permissive strategy. */
  readonly modules?: readonly StrategyModule[];
  /** Injected for the lookahead test: receives every window the strategy is given. */
  readonly onWindow?: (instId: Instrument, window: readonly Candle[], currentTs: number) => void;
}

interface LivePosition extends OpenPosition {
  readonly strategyId: string;
  readonly regime: string;
  readonly openedAtBar: number;
  readonly maxHoldBars: number;
  readonly entryFeeUsdt: number;
}

export function runBacktest(options: BacktestOptions): BacktestResult {
  const tf = options.timeframe ?? '1H';
  const lookback = options.lookbackBars ?? (options.strategyConfig ?? DEFAULT_STRATEGY_CONFIG).lookbackBars;
  const startingEquity = options.startingEquity ?? 400;
  const strategyConfig = options.strategyConfig ?? DEFAULT_STRATEGY_CONFIG;
  const riskConfig = options.riskConfig ?? DEFAULT_RISK_CONFIG;
  const costs = options.costs ?? DEFAULT_COSTS;

  const instruments = (Object.keys(options.candles) as Instrument[]).filter(
    (i) => (options.candles[i]?.length ?? 0) > lookback,
  );
  const series = new Map<Instrument, readonly Candle[]>();
  for (const instId of instruments) series.set(instId, options.candles[instId] as readonly Candle[]);

  const bars = Math.min(...instruments.map((i) => series.get(i)?.length ?? 0));

  let state: GovernorState = initialState(0, startingEquity);
  const open = new Map<string, LivePosition>();
  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  const gateRejections: Record<string, number> = {};
  const governorVetoes: Record<string, number> = {};
  let cycles = 0;
  let signalsEmitted = 0;
  let killSwitchTriggers = 0;
  let dailyLimitTriggers = 0;
  let fundingFallbackSettlements = 0;
  let fundingPaidUsdt = 0;
  let fundingReceivedUsdt = 0;
  let totalFeesUsdt = 0;
  let fromTs = Number.POSITIVE_INFINITY;
  let toTs = 0;

  const bump = (map: Record<string, number>, key: string): void => {
    map[key] = (map[key] ?? 0) + 1;
  };

  const closePosition = (
    position: LivePosition,
    exitPrice: number,
    reason: BacktestTrade['exitReason'],
    closedAt: number,
    bar: number,
  ): void => {
    const spec = specFor(position.instId);
    const direction = position.side === 'long' ? 1 : -1;
    const gross = (exitPrice - position.entryPrice) * direction * position.contracts * spec.ctVal;
    const exitNotional = position.contracts * spec.ctVal * exitPrice;
    const exitFee = feeUsdt(exitNotional, costs);
    const funding = fundingOverHold(
      position.side,
      position.notionalUsdt,
      position.openedAt,
      closedAt,
      options.funding?.[position.instId],
      costs,
    );

    const fees = position.entryFeeUsdt + exitFee;
    const net = gross - fees - funding.usdt;
    totalFeesUsdt += fees;
    fundingFallbackSettlements += funding.fallbackSettlements;
    if (funding.usdt >= 0) fundingPaidUsdt += funding.usdt;
    else fundingReceivedUsdt += -funding.usdt;

    state = {
      ...updatePeak(state, state.equity + net),
      realisedPnlToday: state.realisedPnlToday + net,
      consecutiveLosses: net < 0 ? state.consecutiveLosses + 1 : 0,
    };

    trades.push({
      signalId: position.signalId,
      strategyId: position.strategyId,
      instId: position.instId,
      side: position.side,
      regime: position.regime,
      openedAt: position.openedAt,
      closedAt,
      holdBars: bar - position.openedAtBar,
      entryPrice: position.entryPrice,
      exitPrice,
      contracts: position.contracts,
      notionalUsdt: position.notionalUsdt,
      grossPnlUsdt: gross,
      feesUsdt: fees,
      fundingUsdt: funding.usdt,
      netPnlUsdt: net,
      exitReason: reason,
      equityAfter: state.equity,
      fundingFallbackSettlements: funding.fallbackSettlements,
    });
    open.delete(position.signalId);
  };

  const syncBook = (): void => {
    const positions = [...open.values()];
    state = {
      ...state,
      openPositions: positions,
      totalNotional: positions.reduce((sum, p) => sum + p.notionalUsdt, 0),
    };
  };

  for (let bar = lookback; bar < bars; bar += 1) {
    const anchor = series.get(instruments[0] as Instrument)?.[bar];
    if (anchor === undefined) continue;
    const now = anchor.ts;
    if (options.fromTs !== undefined && now < options.fromTs) continue;
    if (options.toTs !== undefined && now > options.toTs) break;

    fromTs = Math.min(fromTs, now);
    toTs = Math.max(toTs, now);
    state = rollDailyIfNeeded(state, now);

    // ── 1. Manage open positions on THIS bar. Stops first — they are what protects us. ──────
    for (const position of [...open.values()]) {
      const candle = series.get(position.instId)?.[bar];
      if (candle === undefined) continue;
      const hitStop =
        position.side === 'long' ? candle.low <= position.stopPrice : candle.high >= position.stopPrice;
      const heldFor = bar - position.openedAtBar;
      const barRangePct = candle.close > 0 ? (candle.high - candle.low) / candle.close : 0;
      const slip = slippageBps({ notionalUsdt: position.notionalUsdt, barRangePct, costs });

      if (hitStop) {
        closePosition(
          position,
          stopFillPrice(position.side, position.stopPrice, candle.open, slip),
          'stop',
          candle.ts,
          bar,
        );
      } else if (heldFor >= position.maxHoldBars) {
        closePosition(position, exitFillPrice(position.side, candle.close, slip), 'timeout', candle.ts, bar);
      }
    }
    syncBook();

    // ── 2. Kill switch and daily limit, evaluated every bar, not only when a signal arrives. ─
    if (state.equity <= 335 && !state.haltFlags.killSwitch) {
      killSwitchTriggers += 1;
      state = {
        ...state,
        haltFlags: { ...state.haltFlags, killSwitch: true },
        haltReason: `equity ${state.equity.toFixed(2)} <= 335`,
        haltedAt: now,
      };
      for (const position of [...open.values()]) {
        const candle = series.get(position.instId)?.[bar];
        if (candle === undefined) continue;
        const barRangePct = candle.close > 0 ? (candle.high - candle.low) / candle.close : 0;
        const slip = slippageBps({ notionalUsdt: position.notionalUsdt, barRangePct, costs });
        closePosition(position, exitFillPrice(position.side, candle.close, slip), 'flatten', candle.ts, bar);
      }
      syncBook();
    }
    if (state.realisedPnlToday <= -20 && !state.haltFlags.dailyLimit && !state.haltFlags.killSwitch) {
      dailyLimitTriggers += 1;
      state = {
        ...state,
        haltFlags: { ...state.haltFlags, dailyLimit: true },
        haltReason: `daily loss ${state.realisedPnlToday.toFixed(2)}`,
        haltedAt: now,
      };
      for (const position of [...open.values()]) {
        const candle = series.get(position.instId)?.[bar];
        if (candle === undefined) continue;
        const barRangePct = candle.close > 0 ? (candle.high - candle.low) / candle.close : 0;
        const slip = slippageBps({ notionalUsdt: position.notionalUsdt, barRangePct, costs });
        closePosition(position, exitFillPrice(position.side, candle.close, slip), 'flatten', candle.ts, bar);
      }
      syncBook();
    }

    equityCurve.push({ ts: now, equity: state.equity });
    cycles += 1;

    if (state.haltFlags.killSwitch) continue;

    // ── 3. The pipeline, per instrument. ────────────────────────────────────────────────────
    for (const instId of instruments) {
      const all = series.get(instId);
      const candle = all?.[bar];
      const nextBar = all?.[bar + 1];
      if (all === undefined || candle === undefined || nextBar === undefined) continue;

      // CAUSALITY: the window ends at THIS bar, inclusive. Nothing after it exists yet.
      const window = all.slice(bar - lookback + 1, bar + 1);
      assertNoLookahead(window, candle.ts, `${instId} window`);
      options.onWindow?.(instId, window, candle.ts);

      const strategyState: EngineState = {
        openPositions: [...open.values()].map(
          (p): StrategyPosition => ({
            instId: p.instId,
            side: p.side,
            notional: p.notionalUsdt,
            openedAt: p.openedAt,
            signalId: p.signalId,
          }),
        ),
        lastSignalAt: {},
      };

      const snapshot = snapshotFromCandles({
        now: candle.ts,
        instId,
        candles: [{ tf, ohlcv: window }],
        fundingRate: currentFundingRate(options.funding?.[instId], candle.ts) ?? 0,
        fundingHistory: fundingHistoryFor(options.funding?.[instId], candle.ts),
      });

      const cycle = runCycle(snapshot, {
        now: candle.ts,
        newId: createSeededIdFactory((options.seed ?? 1) + bar * 31 + instruments.indexOf(instId)),
        config: strategyConfig,
        state: strategyState,
        ...(options.modules === undefined ? {} : { modules: options.modules }),
      });
      for (const rejection of cycle.rejected) bump(gateRejections, rejection.code);

      for (const signal of cycle.signals) {
        signalsEmitted += 1;
        const riskSnapshot: RiskSnapshot = {
          instId,
          ts: candle.ts,
          degraded: false,
          degradedFields: [],
          last: candle.close,
          funding: { current: snapshot.funding.current },
        };

        const verdict = governorEvaluate(signal, state, riskSnapshot, candle.ts, riskConfig);
        state = verdict.state;
        if (!verdict.approved) {
          bump(governorVetoes, verdict.code);
          continue;
        }

        // ── Simulated execution: fill at the NEXT bar's open, never this bar's close. ──────
        const barRangePct = nextBar.close > 0 ? (nextBar.high - nextBar.low) / nextBar.close : 0;
        const slip = slippageBps({ notionalUsdt: verdict.sizing.notionalUsdt, barRangePct, costs });
        const fillPrice = entryFillPrice(signal.side, nextBar.open, slip);
        const spec = specFor(instId);
        const notional = verdict.sizing.contracts * spec.ctVal * fillPrice;
        const entryFee = feeUsdt(notional, costs);
        totalFeesUsdt += 0; // counted when the trade closes, so it appears once

        open.set(signal.id, {
          instId,
          side: signal.side,
          contracts: verdict.sizing.contracts,
          notionalUsdt: notional,
          entryPrice: fillPrice,
          stopPrice: signal.stop.price,
          openedAt: nextBar.ts,
          signalId: signal.id,
          strategyId: signal.strategyId,
          regime: signal.regime,
          openedAtBar: bar + 1,
          maxHoldBars: signal.invalidation.maxHoldBars,
          entryFeeUsdt: entryFee,
        });
        syncBook();
      }
    }
  }

  // Close anything still open at the end, at the last close. An open position is not a result.
  for (const position of [...open.values()]) {
    const all = series.get(position.instId);
    const last = all?.[bars - 1];
    if (last === undefined) continue;
    const barRangePct = last.close > 0 ? (last.high - last.low) / last.close : 0;
    const slip = slippageBps({ notionalUsdt: position.notionalUsdt, barRangePct, costs });
    closePosition(position, exitFillPrice(position.side, last.close, slip), 'flatten', last.ts, bars - 1);
  }
  syncBook();

  return {
    startingEquity,
    finalEquity: state.equity,
    trades,
    equityCurve,
    cycles,
    signalsEmitted,
    gateRejections,
    governorVetoes,
    killSwitchTriggers,
    dailyLimitTriggers,
    fundingFallbackSettlements,
    fundingPaidUsdt,
    fundingReceivedUsdt,
    totalFeesUsdt,
    fromTs: Number.isFinite(fromTs) ? fromTs : 0,
    toTs,
    state,
  };
}

function currentFundingRate(series: FundingSeries | undefined, ts: number): number | undefined {
  if (series === undefined) return undefined;
  let found: number | undefined;
  for (const entry of series.entries) {
    if (entry.fundingTime > ts) break;
    found = entry.fundingRate;
  }
  return found;
}

/** Past funding settlements only — the strategy may not see a rate that has not settled yet. */
function fundingHistoryFor(
  series: FundingSeries | undefined,
  ts: number,
): ReadonlyArray<{ instId: Instrument; fundingRate: number; realizedRate: number; fundingTime: number }> {
  if (series === undefined) return [];
  const past = series.entries.filter((e) => e.fundingTime <= ts).slice(-100);
  return past.map((e) => ({
    instId: series.instId,
    fundingRate: e.fundingRate,
    realizedRate: e.fundingRate,
    fundingTime: e.fundingTime,
  }));
}

export { assessDrawdown };
