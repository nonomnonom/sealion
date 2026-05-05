import { describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import {
  ActionType,
  ConstantPrice,
  Exchange,
  ManualAction,
  OrderSide,
  Scenario,
  TraderGraph,
  TraderProfile,
  TradingAgent,
  computeMetrics,
  generateTraderGraph,
  make,
  makeMarketMaker,
  spotPreset,
  type RiskConfig,
} from "../src/index.ts";

function freshDb(name: string): string {
  const path = `./data/test_${name}_${Date.now()}_${Math.floor(Math.random() * 1e6)}.db`;
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // Windows lock — fine to ignore.
    }
  }
  return path;
}

describe("Partial fills", () => {
  it("limit BUY of 5 against ask of 3 fills 3 and rests 2", async () => {
    const traders = new TraderGraph();
    traders.addAgent(makeMarketMaker({ agentId: 0, cash: 1_000_000, position: 100 }));
    traders.addAgent(
      new TradingAgent({
        agentId: 1,
        profile: new TraderProfile({ handle: "taker", initialCash: 100_000 }),
      }),
    );
    const env = make({
      traders,
      market: spotPreset({ symbol: "TEST/USDT", takerFeeBps: 0, makerFeeBps: 0 }),
      databasePath: freshDb("partial_fill"),
      initialPrice: 100,
    });
    await env.reset();

    const mm = traders.getAgent(0);
    const taker = traders.getAgent(1);

    await mm.performActionByData(ActionType.PLACE_LIMIT_ORDER, {
      side: OrderSide.SELL,
      price: 101,
      size: 3,
    });

    const buyRes = await taker.performActionByData(ActionType.PLACE_LIMIT_ORDER, {
      side: OrderSide.BUY,
      price: 101,
      size: 5,
    });
    expect(buyRes.success).toBe(true);
    const data = buyRes.data as { filled_size: number; resting_order_id: number | null };
    expect(data.filled_size).toBe(3);
    expect(data.resting_order_id).toBeGreaterThan(0); // 2 still resting on book

    const ob = await taker.performActionByData(ActionType.GET_ORDERBOOK);
    const obData = ob.data as { bids: [number, number][] };
    expect(obData.bids[0]?.[1]).toBe(2); // 2 remaining at 101

    await env.close();
  });
});

describe("Self-trade prevention", () => {
  it("agent's BUY does not match its own SELL", async () => {
    const traders = new TraderGraph();
    traders.addAgent(
      new TradingAgent({
        agentId: 0,
        profile: new TraderProfile({
          handle: "alice",
          initialCash: 1_000_000,
          initialPosition: 100,
        }),
      }),
    );
    const env = make({
      traders,
      market: spotPreset({ symbol: "TEST/USDT" }),
      databasePath: freshDb("self_trade"),
      initialPrice: 100,
    });
    await env.reset();

    const alice = traders.getAgent(0);

    // Alice places SELL @ 101 then BUY @ 105 — should NOT cross self.
    await alice.performActionByData(ActionType.PLACE_LIMIT_ORDER, {
      side: OrderSide.SELL,
      price: 101,
      size: 1,
    });
    const buyRes = await alice.performActionByData(ActionType.PLACE_LIMIT_ORDER, {
      side: OrderSide.BUY,
      price: 105,
      size: 1,
    });
    expect(buyRes.success).toBe(true);
    expect((buyRes.data as { num_fills: number }).num_fills).toBe(0);

    // Both orders rest on the book.
    const ob = await alice.performActionByData(ActionType.GET_ORDERBOOK);
    const data = ob.data as { bids: [number, number][]; asks: [number, number][] };
    expect(data.bids.length).toBe(1);
    expect(data.asks.length).toBe(1);
    await env.close();
  });
});

describe("Mark price cache", () => {
  it("updates cached mark when injectPrice is called", async () => {
    const ex = new Exchange({
      dbPath: freshDb("mark_cache"),
      market: spotPreset({ symbol: "TEST/USDT" }),
      initialPrice: 100,
    });
    expect(ex.markPrice()).toBe(100);
    ex.injectPrice(200);
    expect(ex.markPrice()).toBe(200);
    ex.injectPrice(50);
    expect(ex.markPrice()).toBe(50);
  });
});

describe("Exchange.isFrozen", () => {
  it("freezes agent when drawdown exceeds maxDrawdown", async () => {
    const traders = new TraderGraph();
    traders.addAgent(makeMarketMaker({ agentId: 0, cash: 1_000_000, position: 100 }));
    traders.addAgent(
      new TradingAgent({
        agentId: 1,
        profile: new TraderProfile({ handle: "loser", initialCash: 10_000 }),
      }),
    );
    const risk = new Map<number, RiskConfig>([[1, { maxDrawdown: 50 }]]);
    const env = make({
      traders,
      market: spotPreset({ symbol: "TEST/USDT", takerFeeBps: 100, makerFeeBps: 0 }), // 1% taker fee
      databasePath: freshDb("frozen"),
      initialPrice: 100,
      risk,
    });
    await env.reset();

    const mm = traders.getAgent(0);
    const loser = traders.getAgent(1);

    await mm.performActionByData(ActionType.PLACE_LIMIT_ORDER, {
      side: OrderSide.SELL,
      price: 100,
      size: 10,
    });

    // Loser buys: instant -1% fee on $1000 = -$10. Then market moves down via
    // another tick. After enough fees, drawdown > 50.
    await loser.performActionByData(ActionType.PLACE_MARKET_ORDER, {
      side: OrderSide.BUY,
      size: 10,
    });
    // Inject a much lower price to trigger drawdown via unrealized loss.
    env.exchange.injectPrice(85);

    // Trigger drawdown evaluation by attempting another order.
    await mm.performActionByData(ActionType.PLACE_LIMIT_ORDER, {
      side: OrderSide.SELL,
      price: 85,
      size: 1,
    });
    await loser.performActionByData(ActionType.PLACE_MARKET_ORDER, {
      side: OrderSide.BUY,
      size: 1,
    });

    expect(env.exchange.isFrozen(1)).toBe(true);

    // A new order from loser should be rejected.
    const rejected = await loser.performActionByData(ActionType.PLACE_LIMIT_ORDER, {
      side: OrderSide.BUY,
      price: 80,
      size: 1,
    });
    expect(rejected.success).toBe(false);
    expect(rejected.error).toBe("agent_frozen");

    await env.close();
  });
});

describe("MarketEnvironment.toTextPrompt", () => {
  it("includes mark, account, open orders, and recent trades", async () => {
    const traders = new TraderGraph();
    traders.addAgent(makeMarketMaker({ agentId: 0, cash: 1_000_000, position: 100 }));
    traders.addAgent(
      new TradingAgent({
        agentId: 1,
        profile: new TraderProfile({ handle: "alice", initialCash: 10_000 }),
      }),
    );
    const env = make({
      traders,
      market: spotPreset({ symbol: "TEST/USDT", takerFeeBps: 0, makerFeeBps: 0 }),
      databasePath: freshDb("toTextPrompt"),
      initialPrice: 100,
    });
    await env.reset();

    const mm = traders.getAgent(0);
    const alice = traders.getAgent(1);

    await mm.performActionByData(ActionType.PLACE_LIMIT_ORDER, {
      side: OrderSide.SELL,
      price: 101,
      size: 1,
    });
    await alice.performActionByData(ActionType.PLACE_LIMIT_ORDER, {
      side: OrderSide.BUY,
      price: 101,
      size: 1,
    });

    const text = await alice.market.toTextPrompt();
    expect(text).toContain("Mark price");
    expect(text).toContain("Your account");
    expect(text).toContain("position=");
    expect(text).toContain("Recent trades");
    await env.close();
  });
});

describe("SealionEnv.close idempotency", () => {
  it("close() called twice does not throw", async () => {
    const traders = new TraderGraph();
    traders.addAgent(
      new TradingAgent({
        agentId: 0,
        profile: new TraderProfile({ handle: "alice", initialCash: 1_000 }),
      }),
    );
    const env = make({
      traders,
      market: spotPreset({ symbol: "TEST/USDT" }),
      databasePath: freshDb("close_idem"),
      initialPrice: 100,
    });
    await env.reset();
    await env.close();
    await env.close(); // Should not throw.
    expect(true).toBe(true);
  });
});

describe("generateTraderGraph", () => {
  it("uses custom profiles when provided", () => {
    const graph = generateTraderGraph({
      profiles: [
        { trader_id: 7, handle: "custom_a", initial_cash: 5000 },
        { trader_id: 8, handle: "custom_b", initial_cash: 3000 },
      ],
    });
    expect(graph.getNumNodes()).toBe(2);
    expect(graph.getAgent(7).profile.handle).toBe("custom_a");
    expect(graph.getAgent(8).profile.handle).toBe("custom_b");
    expect(graph.getAgent(7).profile.initialCash).toBe(5000);
  });

  it("returns synchronously (no await needed)", () => {
    const graph = generateTraderGraph({ count: 2 });
    // Sync return — TraderGraph instance, not Promise.
    expect(graph).toBeInstanceOf(TraderGraph);
    expect(graph.getNumNodes()).toBe(2);
  });
});

describe("computeMetrics on empty trade history", () => {
  it("returns zero metrics without errors", async () => {
    const traders = new TraderGraph();
    traders.addAgent(
      new TradingAgent({
        agentId: 0,
        profile: new TraderProfile({ handle: "noop", initialCash: 1_000 }),
      }),
    );
    const sc = new Scenario({
      market: spotPreset({ symbol: "TEST/USDT" }),
      databasePath: freshDb("empty_metrics"),
      fresh: true,
      traders,
      pricer: new ConstantPrice({ price: 100, steps: 5 }),
      initialPrice: 100,
      steps: 5,
    });
    const result = await sc.run();

    const m = result.metrics.get(0)!;
    expect(m.numTrades).toBe(0);
    expect(m.winRate).toBe(0);
    expect(m.totalReturn).toBe(0);
    expect(m.sharpe).toBe(0); // returns array length < 2 guard
    expect(m.feesPaid).toBe(0);
  });
});

describe("safeNumber & safeStringify", () => {
  it("safeNumber rejects NaN", async () => {
    const { safeNumber } = await import("../src/utils.ts");
    expect(safeNumber(42)).toBe(42);
    expect(safeNumber(undefined, 10)).toBe(10);
    expect(() => safeNumber("abc")).toThrow();
    expect(() => safeNumber(NaN)).toThrow();
    expect(safeNumber(NaN, 7)).toBe(7);
  });

  it("safeStringify handles circular refs", async () => {
    const { safeStringify } = await import("../src/utils.ts");
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    const out = safeStringify(obj);
    expect(out).toContain('"a":1');
    expect(out).toContain("[Circular]");
  });

  it("safeStringify handles BigInt", async () => {
    const { safeStringify } = await import("../src/utils.ts");
    expect(safeStringify({ big: 9999999999999999999n })).toContain("9999999999999999999");
  });
});

describe("Order rejection paths", () => {
  it("invalid side rejected", async () => {
    const traders = new TraderGraph();
    traders.addAgent(
      new TradingAgent({
        agentId: 0,
        profile: new TraderProfile({ handle: "alice", initialCash: 1_000 }),
      }),
    );
    const env = make({
      traders,
      market: spotPreset({ symbol: "TEST/USDT" }),
      databasePath: freshDb("bad_side"),
      initialPrice: 100,
    });
    await env.reset();
    const alice = traders.getAgent(0);
    const res = await alice.performActionByData(ActionType.PLACE_LIMIT_ORDER, {
      side: "diagonal", // not buy/sell
      price: 100,
      size: 1,
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe("invalid_side");
    await env.close();
  });

  it("non-numeric size rejected", async () => {
    const traders = new TraderGraph();
    traders.addAgent(
      new TradingAgent({
        agentId: 0,
        profile: new TraderProfile({ handle: "alice", initialCash: 1_000 }),
      }),
    );
    const env = make({
      traders,
      market: spotPreset({ symbol: "TEST/USDT" }),
      databasePath: freshDb("bad_num"),
      initialPrice: 100,
    });
    await env.reset();
    const alice = traders.getAgent(0);
    const res = await alice.performActionByData(ActionType.PLACE_LIMIT_ORDER, {
      side: OrderSide.BUY,
      price: 100,
      size: "abc",
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("invalid number");
    await env.close();
    void computeMetrics; // satisfies import
    void ManualAction;
  });
});
