import { describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import {
  ActionType,
  Composite,
  ConstantPrice,
  GBM,
  JumpDiffusion,
  ManualAction,
  MeanReversion,
  OrderSide,
  RandomWalk,
  Replay,
  Scenario,
  Scripted,
  TraderGraph,
  TraderProfile,
  TradingAgent,
  computeMetrics,
  make,
  makeMarketMaker,
  spotPreset,
  type RiskConfig,
  type StepActions,
} from "../src/index.ts";

function freshDb(name: string): string {
  const path = `./data/test_${name}_${Date.now()}_${Math.floor(Math.random() * 1e6)}.db`;
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // Windows lock — ignore.
    }
  }
  return path;
}

describe("PriceSimulators", () => {
  it("GBM is deterministic given seed and respects steps", () => {
    const a = new GBM({ start: 100, mu: 0, sigma: 0.01, steps: 10, seed: 7 });
    const b = new GBM({ start: 100, mu: 0, sigma: 0.01, steps: 10, seed: 7 });
    for (let i = 0; i < 10; i++) {
      expect(a.next()!.price).toBeCloseTo(b.next()!.price, 9);
    }
    expect(a.next()).toBe(null);
  });

  it("MeanReversion pulls toward mu", () => {
    const sim = new MeanReversion({
      start: 200,
      mu: 100,
      theta: 0.5, // strong reversion
      sigma: 0.01,
      steps: 100,
      seed: 1,
    });
    let last = 200;
    for (let i = 0; i < 100; i++) {
      const t = sim.next();
      if (!t) break;
      last = t.price;
    }
    // After 100 steps with strong reversion, price should be near mu.
    expect(Math.abs(last - 100)).toBeLessThan(10);
  });

  it("Composite chains simulators back-to-back", () => {
    const sim = new Composite([
      new ConstantPrice({ price: 50, steps: 2 }),
      new ConstantPrice({ price: 200, steps: 2 }),
    ]);
    expect(sim.next()!.price).toBe(50);
    expect(sim.next()!.price).toBe(50);
    expect(sim.next()!.price).toBe(200);
    expect(sim.next()!.price).toBe(200);
    expect(sim.next()).toBe(null);
  });

  it("Scripted applies multiplier at the right step", () => {
    const sim = new Scripted({
      base: new ConstantPrice({ price: 100, steps: 5 }),
      shocks: [{ atStep: 2, multiplier: 0.5 }],
    });
    expect(sim.next()!.price).toBe(100);
    expect(sim.next()!.price).toBe(100);
    expect(sim.next()!.price).toBe(50); // step 2 → shock
    expect(sim.next()!.price).toBe(100);
    expect(sim.next()!.price).toBe(100);
    expect(sim.next()).toBe(null);
  });

  it("JumpDiffusion is deterministic given seed", () => {
    const baseA = new ConstantPrice({ price: 100, steps: 50 });
    const baseB = new ConstantPrice({ price: 100, steps: 50 });
    const a = new JumpDiffusion({ base: baseA, jumpProb: 0.3, jumpStd: 0.05, seed: 9 });
    const b = new JumpDiffusion({ base: baseB, jumpProb: 0.3, jumpStd: 0.05, seed: 9 });
    for (let i = 0; i < 50; i++) {
      expect(a.next()!.price).toBeCloseTo(b.next()!.price, 9);
    }
  });

  it("RandomWalk respects floor", () => {
    const sim = new RandomWalk({
      start: 1,
      sigma: 100, // huge volatility
      drift: -10,
      steps: 50,
      seed: 5,
      floor: 0.01,
    });
    for (let i = 0; i < 50; i++) {
      const t = sim.next();
      if (!t) break;
      expect(t.price).toBeGreaterThanOrEqual(0.01);
    }
  });

  it("Replay reset() rewinds to start", () => {
    const sim = new Replay({ ticks: [{ price: 1 }, { price: 2 }, { price: 3 }] });
    sim.next();
    sim.next();
    sim.reset();
    expect(sim.next()!.price).toBe(1);
  });
});

describe("Risk gate + drawdown", () => {
  it("blocks order when notional exceeds maxOrderNotional", async () => {
    const traders = new TraderGraph();
    traders.addAgent(
      new TradingAgent({
        agentId: 0,
        profile: new TraderProfile({ handle: "alice", initialCash: 100_000 }),
      }),
    );
    const risk = new Map<number, RiskConfig>([[0, { maxOrderNotional: 500 }]]);
    const env = make({
      traders,
      market: spotPreset({ symbol: "TEST/USDT" }),
      databasePath: freshDb("risk_notional"),
      initialPrice: 100,
      risk,
    });
    await env.reset();

    const alice = traders.getAgent(0);
    const res = await alice.performActionByData(ActionType.PLACE_LIMIT_ORDER, {
      side: OrderSide.BUY,
      price: 100,
      size: 10, // notional 1000 > limit 500
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe("order_exceeds_max_notional");
    await env.close();
  });

  it("blocks order when projected position exceeds maxPosition", async () => {
    const traders = new TraderGraph();
    traders.addAgent(
      new TradingAgent({
        agentId: 0,
        profile: new TraderProfile({ handle: "alice", initialCash: 100_000 }),
      }),
    );
    traders.addAgent(makeMarketMaker({ agentId: 1, cash: 1_000_000, position: 100 }));
    const risk = new Map<number, RiskConfig>([[0, { maxPosition: 1 }]]);
    const env = make({
      traders,
      market: spotPreset({ symbol: "TEST/USDT" }),
      databasePath: freshDb("risk_pos"),
      initialPrice: 100,
      risk,
    });
    await env.reset();

    const mm = traders.getAgent(1);
    await mm.performActionByData(ActionType.PLACE_LIMIT_ORDER, {
      side: OrderSide.SELL,
      price: 101,
      size: 10,
    });

    const alice = traders.getAgent(0);
    const res = await alice.performActionByData(ActionType.PLACE_MARKET_ORDER, {
      side: OrderSide.BUY,
      size: 5, // would push position to 5 > limit 1
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe("position_limit_exceeded");
    await env.close();
  });
});

describe("Metrics — FIFO win-rate pairing", () => {
  it("counts wins on round-trips", async () => {
    const traders = new TraderGraph();
    traders.addAgent(
      new TradingAgent({
        agentId: 0,
        profile: new TraderProfile({ handle: "alice", initialCash: 1_000_000 }),
      }),
    );
    traders.addAgent(makeMarketMaker({ agentId: 1, cash: 1_000_000, position: 100 }));
    const env = make({
      traders,
      market: spotPreset({ symbol: "TEST/USDT", takerFeeBps: 0, makerFeeBps: 0 }),
      databasePath: freshDb("metrics_fifo"),
      initialPrice: 100,
    });
    await env.reset();

    const mm = traders.getAgent(1);
    const alice = traders.getAgent(0);

    // MM offers a ladder of asks (101,102,103) and bids (100,99,98).
    const t1: StepActions = new Map();
    t1.set(mm, [
      new ManualAction({
        actionType: ActionType.PLACE_LIMIT_ORDER,
        actionArgs: { side: OrderSide.SELL, price: 101, size: 1 },
      }),
      new ManualAction({
        actionType: ActionType.PLACE_LIMIT_ORDER,
        actionArgs: { side: OrderSide.SELL, price: 103, size: 1 },
      }),
      new ManualAction({
        actionType: ActionType.PLACE_LIMIT_ORDER,
        actionArgs: { side: OrderSide.BUY, price: 105, size: 2 },
      }),
    ]);
    await env.step(t1);

    // Alice buys 1 @ 101 then sells 1 @ 105 → roundtrip win.
    await alice.performActionByData(ActionType.PLACE_LIMIT_ORDER, {
      side: OrderSide.BUY,
      price: 101,
      size: 1,
    });
    await alice.performActionByData(ActionType.PLACE_LIMIT_ORDER, {
      side: OrderSide.SELL,
      price: 105,
      size: 1,
    });

    // Then buys 1 @ 103 and sells 1 @ 105 → roundtrip win again.
    await alice.performActionByData(ActionType.PLACE_LIMIT_ORDER, {
      side: OrderSide.BUY,
      price: 103,
      size: 1,
    });
    await alice.performActionByData(ActionType.PLACE_LIMIT_ORDER, {
      side: OrderSide.SELL,
      price: 105,
      size: 1,
    });

    const m = computeMetrics(env.exchange.db, 0, 1_000_000);
    // 4 fills → 2 round-trips, both wins.
    expect(m.numTrades).toBe(4);
    expect(m.winRate).toBeCloseTo(1.0, 6);
    await env.close();
  });
});

describe("Scenario — pricer-driven", () => {
  it("ends early when pricer exhausts before opts.steps", async () => {
    const traders = new TraderGraph();
    traders.addAgent(
      new TradingAgent({
        agentId: 0,
        profile: new TraderProfile({ handle: "alice", initialCash: 10_000 }),
      }),
    );
    const sc = new Scenario({
      market: spotPreset({ symbol: "TEST/USDT" }),
      databasePath: freshDb("scenario_exhaust"),
      fresh: true,
      traders,
      pricer: new ConstantPrice({ price: 100, steps: 3 }),
      initialPrice: 100,
      steps: 100, // request 100 but pricer only has 3
    });
    const result = await sc.run();
    expect(result.steps).toBe(3);
  });

  it("MarketMakerBot auto-quotes around mark with no decideAction", async () => {
    const traders = new TraderGraph();
    traders.addAgent(
      makeMarketMaker({ agentId: 0, cash: 1_000_000, position: 10, spreadBps: 100 }),
    );
    const sc = new Scenario({
      market: spotPreset({ symbol: "TEST/USDT", takerFeeBps: 0, makerFeeBps: 0 }),
      databasePath: freshDb("scenario_mm"),
      fresh: true,
      traders,
      pricer: new ConstantPrice({ price: 100, steps: 3 }),
      initialPrice: 100,
      steps: 3,
    });
    const result = await sc.run();
    expect(result.steps).toBe(3);
    // After 3 steps of cancel-all + post around 100, MM should have working orders.
    const openOrders = result.env.exchange.db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM "order" WHERE status IN ('open','partial')`,
      )
      .get();
    expect(openOrders!.n).toBeGreaterThan(0);
  });
});

describe("Mastra integration", () => {
  it("collectMastraAgents skips traders without a model", async () => {
    const { collectMastraAgents } = await import("../src/index.ts");
    const traders = new TraderGraph();
    traders.addAgent(
      new TradingAgent({
        agentId: 0,
        profile: new TraderProfile({ handle: "no_model" }),
        // no model
      }),
    );
    traders.addAgent(
      new TradingAgent({
        agentId: 1,
        profile: new TraderProfile({ handle: "with_model" }),
        model: "openai/gpt-4o-mini",
      }),
    );
    const agents = collectMastraAgents(traders);
    // Only the one with a model is collected.
    expect(Object.keys(agents)).toEqual(["trader-1"]);
  });

  it("sealionObservabilityConfig returns Mastra-compatible shape", async () => {
    const { sealionObservabilityConfig } = await import("../src/index.ts");
    const cfg = sealionObservabilityConfig({ serviceName: "mysim" });
    expect(cfg.configs.default.serviceName).toBe("mysim");
    expect(cfg.configs.default.exporters).toEqual([]);
    expect(cfg.configs.default.spanOutputProcessors).toEqual([]);
  });
});

describe("Env validation", () => {
  it("throws when both exchange and market are passed", () => {
    const { Channel, Exchange } = require("../src/index.ts");
    const traders = new TraderGraph();
    const ex = new Exchange({
      dbPath: freshDb("validation_both"),
      market: spotPreset({ symbol: "TEST/USDT" }),
      channel: new Channel(),
    });
    expect(() =>
      make({
        traders,
        market: spotPreset({ symbol: "TEST/USDT" }),
        exchange: ex,
      } as never),
    ).toThrow();
  });

  it("throws when neither exchange nor market is passed", () => {
    const traders = new TraderGraph();
    expect(() => make({ traders, databasePath: "./data/x.db" } as never)).toThrow();
  });
});
