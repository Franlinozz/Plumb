/**
 * A mock Agent Trade Kit, for tests and fault injection.
 *
 * It implements the same `AtkClient` interface the CLI wrapper does, so the fault-injection tests
 * exercise the real executor code paths rather than a parallel imitation. Every failure mode the
 * executor claims to handle can be injected here: a rejected order, a timeout, a stop that will
 * not place, a fill that belongs to nobody, a position that drifts.
 */

import {
  AtkError,
  type AtkClient,
  type OrderRef,
  type PlaceOrderRequest,
  type VenueBalance,
  type VenueFill,
  type VenueOrder,
  type VenuePosition,
} from './atk.js';

export interface MockFaults {
  /** Fail any place whose clOrdId starts with this prefix. */
  readonly rejectPlaceFor?: (request: PlaceOrderRequest) => AtkError | undefined;
  /** Fail `closePosition`. */
  readonly failClose?: boolean;
  /** Fail `getFills`. */
  readonly failFills?: boolean;
}

export class MockAtk implements AtkClient {
  readonly demo = true;
  readonly placed: PlaceOrderRequest[] = [];
  readonly closes: string[] = [];

  private orders = new Map<string, VenueOrder>();
  private positions = new Map<string, VenuePosition>();
  private fills: VenueFill[] = [];
  private balances: VenueBalance[] = [{ ccy: 'USDT', eq: 400, availEq: 400 }];
  private nextOrdId = 1;
  private clock = Date.parse('2026-08-09T12:00:00Z');

  constructor(private faults: MockFaults = {}) {}

  setFaults(faults: MockFaults): void {
    this.faults = faults;
  }

  tick(ms = 1_000): number {
    this.clock += ms;
    return this.clock;
  }

  async placeOrder(request: PlaceOrderRequest): Promise<OrderRef> {
    const failure = this.faults.rejectPlaceFor?.(request);
    if (failure !== undefined) throw failure;

    // The venue rejects a duplicate client order id — the last line of idempotency defence.
    if (this.orders.has(request.clOrdId)) {
      throw new AtkError('rejected', `duplicate clOrdId ${request.clOrdId}`);
    }

    this.placed.push(request);
    const ordId = `ORD${this.nextOrdId++}`;
    const order: VenueOrder = {
      ordId,
      clOrdId: request.clOrdId,
      instId: request.instId,
      state: 'filled',
      side: request.side,
      sz: request.sz,
      avgPx: request.px ?? 65_000,
      ts: this.clock,
      ...(request.slTriggerPx === undefined ? {} : { slTriggerPx: request.slTriggerPx }),
    };
    this.orders.set(request.clOrdId, order);
    this.fills.push({
      instId: request.instId,
      ordId,
      clOrdId: request.clOrdId,
      side: request.side,
      fillSz: request.sz,
      fillPx: order.avgPx,
      fee: order.avgPx * request.sz * 0.0005,
      ts: this.clock,
    });

    if (request.reduceOnly !== true && request.slTriggerPx === undefined) {
      this.openPosition(request);
    } else if (request.reduceOnly !== true) {
      this.openPosition(request);
    }
    return { ordId, clOrdId: request.clOrdId, instId: request.instId };
  }

  private openPosition(request: PlaceOrderRequest): void {
    const signed = request.side === 'buy' ? request.sz : -request.sz;
    const existing = this.positions.get(request.instId);
    const pos = (existing?.pos ?? 0) + signed;
    this.positions.set(request.instId, {
      instId: request.instId,
      posSide: request.posSide,
      pos,
      avgPx: request.px ?? 65_000,
      upl: 0,
    });
  }

  async cancelOrder(_instId: string, ordId: string): Promise<void> {
    for (const [clOrdId, order] of this.orders) {
      if (order.ordId === ordId) this.orders.set(clOrdId, { ...order, state: 'canceled' });
    }
  }

  async amendOrder(): Promise<void> {
    // Not exercised in P5 — the executor cancels and replaces rather than amending a stop.
  }

  async getOrder(
    _instId: string,
    params: { ordId?: string; clOrdId?: string },
  ): Promise<VenueOrder | undefined> {
    if (params.clOrdId !== undefined) return this.orders.get(params.clOrdId);
    return [...this.orders.values()].find((o) => o.ordId === params.ordId);
  }

  async getOpenOrders(instId?: string): Promise<readonly VenueOrder[]> {
    return [...this.orders.values()].filter(
      (o) => o.state === 'live' && (instId === undefined || o.instId === instId),
    );
  }

  async getPositions(instId?: string): Promise<readonly VenuePosition[]> {
    return [...this.positions.values()].filter((p) => instId === undefined || p.instId === instId);
  }

  async getFills(instId?: string): Promise<readonly VenueFill[]> {
    if (this.faults.failFills === true) throw new AtkError('transport', 'fills unavailable');
    return this.fills.filter((f) => instId === undefined || f.instId === instId);
  }

  async getBalance(): Promise<readonly VenueBalance[]> {
    return this.balances;
  }

  async closePosition(instId: string): Promise<void> {
    if (this.faults.failClose === true) throw new AtkError('rejected', 'close refused');
    this.closes.push(instId);
    this.positions.delete(instId);
  }

  // ── fault-injection helpers ───────────────────────────────────────────────────────────────

  /** A fill that belongs to no signal — what reconciliation must catch. */
  injectOrphanFill(instId: string, clOrdId = 'MANUALTRADE1'): void {
    this.fills.push({
      instId,
      ordId: `ORD${this.nextOrdId++}`,
      clOrdId,
      side: 'buy',
      fillSz: 1,
      fillPx: 65_000,
      fee: 0.3,
      ts: this.clock,
    });
  }

  /**
   * Make the venue disagree with our recorded size. `posSide` accepts `net` because the live
   * demo account runs in `net_mode` and reports one signed figure per instrument — the shape
   * that produced the P8 run-1 halt.
   */
  setPosition(instId: string, pos: number, posSide: 'long' | 'short' | 'net' = 'long'): void {
    this.positions.set(instId, { instId, posSide, pos, avgPx: 65_000, upl: 0 });
  }

  clearPositions(): void {
    this.positions.clear();
  }

  setBalance(eq: number): void {
    this.balances = [{ ccy: 'USDT', eq, availEq: eq }];
  }
}
