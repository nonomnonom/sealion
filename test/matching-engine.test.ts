import { describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import {
  Channel,
  Exchange,
  ManualAction,
  OrderSide,
  TraderProfile,
  TraderGraph,
  TradingAgent,
  make,
  ActionType,
  spotPreset,
  type StepActions,
} from "../src/index.ts";

function freshDb(name: string): string {
  const path = `./data/test_${name}_${Date.now()}_${Math.floor(Math.random() * 1e6)}.db`;
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // Windows may hold a lock briefly — fine to ignore.
    }
  }
  return path;
}

function setupEnv(databasePath: string) {
  const registry = new TraderGraph();
  registry.addAgent(
    new TradingAgent({
      agentId: 0,
      profile: new TraderProfile({ handle: "alice", initialCash: 10_000, initialPosition: 100 }),
    }),
  );
  registry.addAgent(
    new TradingAgent({
      agentId: 1,
      profile: new TraderProfile({ handle: "bob", initialCash: 10_000 }),
    }),
  );
  return make({
    traders: registry,
    market: spotPreset({ symbol: "TEST/USDT" }),
    databasePath,
    initialPrice: 100,
  });
}

describe("matching engine", () => {
  it("limit-buy resting on book then taker hits it", async () => {
    const env = setupEnv(freshDb("limit_taker"));
    await env.reset();

    const alice = env.traders.getAgent(0);
    const bob = env.traders.getAgent(1);

    const t1: StepActions = new Map();
    t1.set(
      alice,
      new ManualAction({
        actionType: ActionType.PLACE_LIMIT_ORDER,
        actionArgs: { side: OrderSide.SELL, price: 101, size: 5 },
      }),
    );
    await env.step(t1);

    const t2: StepActions = new Map();
    t2.set(
      bob,
      new ManualAction({
        actionType: ActionType.PLACE_MARKET_ORDER,
        actionArgs: { side: OrderSide.BUY, size: 5 },
      }),
    );
    await env.step(t2);

    const aliceAcct = await alice.performActionByData(ActionType.GET_ACCOUNT);
    const bobAcct = await bob.performActionByData(ActionType.GET_ACCOUNT);
    expect((aliceAcct.data as { position: number }).position).toBe(95);
    expect((bobAcct.data as { position: number }).position).toBe(5);

    await env.close();
  });

  it("limit order does not cross when price is wrong side", async () => {
    const env = setupEnv(freshDb("no_cross"));
    await env.reset();

    const alice = env.traders.getAgent(0);
    const bob = env.traders.getAgent(1);

    const t1: StepActions = new Map();
    t1.set(
      alice,
      new ManualAction({
        actionType: ActionType.PLACE_LIMIT_ORDER,
        actionArgs: { side: OrderSide.SELL, price: 105, size: 5 },
      }),
    );
    await env.step(t1);

    const t2: StepActions = new Map();
    t2.set(
      bob,
      new ManualAction({
        actionType: ActionType.PLACE_LIMIT_ORDER,
        actionArgs: { side: OrderSide.BUY, price: 100, size: 5 },
      }),
    );
    await env.step(t2);

    const aliceAcct = await alice.performActionByData(ActionType.GET_ACCOUNT);
    const bobAcct = await bob.performActionByData(ActionType.GET_ACCOUNT);
    expect((aliceAcct.data as { position: number }).position).toBe(100);
    expect((bobAcct.data as { position: number }).position).toBe(0);

    const ob = await alice.performActionByData(ActionType.GET_ORDERBOOK);
    const data = ob.data as { bids: [number, number][]; asks: [number, number][] };
    expect(data.bids.length).toBe(1);
    expect(data.asks.length).toBe(1);
    expect(data.bids[0]?.[0]).toBe(100);
    expect(data.asks[0]?.[0]).toBe(105);

    await env.close();
  });

  it("cancel removes a working order", async () => {
    const env = setupEnv(freshDb("cancel"));
    await env.reset();

    const alice = env.traders.getAgent(0);
    const placeRes = await alice.performActionByData(ActionType.PLACE_LIMIT_ORDER, {
      side: OrderSide.SELL,
      price: 105,
      size: 1,
    });
    const orderId = (placeRes.data as { resting_order_id: number }).resting_order_id;
    expect(orderId).toBeGreaterThan(0);

    const cancelRes = await alice.performActionByData(ActionType.CANCEL_ORDER, {
      order_id: orderId,
    });
    expect(cancelRes.success).toBe(true);

    const ob = await alice.performActionByData(ActionType.GET_ORDERBOOK);
    expect((ob.data as { asks: [number, number][] }).asks.length).toBe(0);

    await env.close();
  });

  it("market order without liquidity is rejected", async () => {
    const dbPath = freshDb("no_liq");
    const registry = new TraderGraph();
    registry.addAgent(
      new TradingAgent({
        agentId: 0,
        profile: new TraderProfile({ handle: "alice", initialCash: 10_000 }),
      }),
    );
    const channel = new Channel();
    const ex = new Exchange({
      dbPath,
      market: spotPreset({ symbol: "TEST/USDT" }),
      channel,
    });
    const env = make({ traders: registry, exchange: ex });
    await env.reset();

    const alice = registry.getAgent(0);
    const res = await alice.performActionByData(ActionType.PLACE_MARKET_ORDER, {
      side: OrderSide.BUY,
      size: 1,
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe("no_reference_price_for_market_order");

    await env.close();
  });

  it("rejects buy when cash is insufficient", async () => {
    const dbPath = freshDb("no_cash");
    const registry = new TraderGraph();
    registry.addAgent(
      new TradingAgent({
        agentId: 0,
        profile: new TraderProfile({ handle: "alice", initialCash: 50, initialPosition: 0 }),
      }),
    );
    registry.addAgent(
      new TradingAgent({
        agentId: 1,
        profile: new TraderProfile({ handle: "bob", initialCash: 10_000, initialPosition: 100 }),
      }),
    );
    const env = make({
      traders: registry,
      market: spotPreset({ symbol: "TEST/USDT" }),
      databasePath: dbPath,
      initialPrice: 100,
    });
    await env.reset();

    const bob = registry.getAgent(1);
    await bob.performActionByData(ActionType.PLACE_LIMIT_ORDER, {
      side: OrderSide.SELL,
      price: 100,
      size: 1,
    });

    const alice = registry.getAgent(0);
    const res = await alice.performActionByData(ActionType.PLACE_LIMIT_ORDER, {
      side: OrderSide.BUY,
      price: 100,
      size: 1,
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe("insufficient_cash");

    await env.close();
  });
});

describe("copy-trade replication", () => {
  it("follower mirrors leader's market buy at given ratio", async () => {
    const registry = new TraderGraph();
    registry.addAgent(
      new TradingAgent({
        agentId: 0,
        profile: new TraderProfile({ handle: "maker", initialCash: 100_000, initialPosition: 100 }),
      }),
    );
    registry.addAgent(
      new TradingAgent({
        agentId: 1,
        profile: new TraderProfile({ handle: "leader", initialCash: 50_000 }),
      }),
    );
    registry.addAgent(
      new TradingAgent({
        agentId: 2,
        profile: new TraderProfile({ handle: "follower", initialCash: 50_000 }),
      }),
    );
    const env = make({
      traders: registry,
      market: spotPreset({ symbol: "TEST/USDT" }),
      databasePath: freshDb("copy"),
      initialPrice: 100,
    });
    await env.reset();

    const maker = registry.getAgent(0);
    const leader = registry.getAgent(1);
    const follower = registry.getAgent(2);

    await maker.performActionByData(ActionType.PLACE_LIMIT_ORDER, {
      side: OrderSide.SELL,
      price: 101,
      size: 10,
    });

    const copy = await follower.performActionByData(ActionType.COPY_TRADE, {
      leader_id: leader.agentId,
      ratio: 0.5,
    });
    expect(copy.success).toBe(true);

    await leader.performActionByData(ActionType.PLACE_MARKET_ORDER, {
      side: OrderSide.BUY,
      size: 2,
    });

    const leaderAcct = await leader.performActionByData(ActionType.GET_ACCOUNT);
    const followerAcct = await follower.performActionByData(ActionType.GET_ACCOUNT);
    expect((leaderAcct.data as { position: number }).position).toBe(2);
    expect((followerAcct.data as { position: number }).position).toBe(1);

    await env.close();
  });
});

describe("price simulators", () => {
  it("RandomWalk is deterministic given seed", async () => {
    const { RandomWalk } = await import("../src/index.ts");
    const a = new RandomWalk({ start: 100, sigma: 1, seed: 42, steps: 5 });
    const b = new RandomWalk({ start: 100, sigma: 1, seed: 42, steps: 5 });
    for (let i = 0; i < 5; i++) {
      const ta = a.next();
      const tb = b.next();
      expect(ta?.price).toBeCloseTo(tb!.price, 9);
    }
    expect(a.next()).toBe(null);
  });

  it("ConstantPrice yields fixed price for N steps", async () => {
    const { ConstantPrice } = await import("../src/index.ts");
    const c = new ConstantPrice({ price: 50, steps: 3 });
    expect(c.next()?.price).toBe(50);
    expect(c.next()?.price).toBe(50);
    expect(c.next()?.price).toBe(50);
    expect(c.next()).toBe(null);
  });

  it("Replay walks an array of ticks then exhausts", async () => {
    const { Replay } = await import("../src/index.ts");
    const r = new Replay({ ticks: [{ price: 1 }, { price: 2 }, { price: 3 }] });
    expect(r.next()?.price).toBe(1);
    expect(r.next()?.price).toBe(2);
    expect(r.next()?.price).toBe(3);
    expect(r.next()).toBe(null);
  });
});

describe("Scenario", () => {
  it("position-only sim yields equity tied to mark price moves", async () => {
    const { Scenario, ConstantPrice } = await import("../src/index.ts");
    const registry = new TraderGraph();
    registry.addAgent(
      new TradingAgent({
        agentId: 0,
        profile: new TraderProfile({
          handle: "hodler",
          initialCash: 0,
          initialPosition: 1,
        }),
      }),
    );
    const sc = new Scenario({
      market: spotPreset({ symbol: "TEST/USDT" }),
      databasePath: freshDb("scenario_const"),
      fresh: true,
      traders: registry,
      pricer: new ConstantPrice({ price: 200, steps: 3 }),
      initialPrice: 100,
      steps: 3,
    });
    const result = await sc.run();
    expect(result.steps).toBe(3);
    const a = result.accounts.find((x) => x.agentId === 0)!;
    // Position 1 × mark 200 = 200, no cash; equity should be ~200.
    expect(a.equity).toBeCloseTo(200, 6);
  });
});
