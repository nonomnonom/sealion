// Copy-trade demo: a leader places market orders and a follower mirrors them
// at a configurable ratio.
//
// Run: bun run examples/copy-trade.ts

import { existsSync, unlinkSync } from "node:fs";
import {
  ActionType,
  ManualAction,
  OrderSide,
  TraderProfile,
  TraderGraph,
  TradingAgent,
  make,
  spotPreset,
  type StepActions,
} from "../src/index.ts";

const DB_PATH = "./data/copy_trade.db";

async function main() {
  if (existsSync(DB_PATH)) unlinkSync(DB_PATH);

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
    market: spotPreset({ symbol: "BTC/USDT" }),
    databasePath: DB_PATH,
    initialPrice: 100,
  });
  await env.reset();

  const maker = registry.getAgent(0);
  const leader = registry.getAgent(1);
  const follower = registry.getAgent(2);

  const seed: StepActions = new Map();
  seed.set(maker, [
    new ManualAction({
      actionType: ActionType.PLACE_LIMIT_ORDER,
      actionArgs: { side: OrderSide.SELL, price: 101, size: 10 },
    }),
    new ManualAction({
      actionType: ActionType.PLACE_LIMIT_ORDER,
      actionArgs: { side: OrderSide.BUY, price: 99, size: 10 },
    }),
  ]);
  await env.step(seed);

  await follower.performActionByData(ActionType.COPY_TRADE, {
    leader_id: leader.agentId,
    ratio: 0.5,
  });

  const leaderTurn: StepActions = new Map();
  leaderTurn.set(
    leader,
    new ManualAction({
      actionType: ActionType.PLACE_MARKET_ORDER,
      actionArgs: { side: OrderSide.BUY, size: 2 },
    }),
  );
  await env.step(leaderTurn);

  console.log("\n=== Accounts after leader's market buy ===");
  for (const [, agent] of registry.getAgents()) {
    const r = await agent.performActionByData(ActionType.GET_ACCOUNT);
    console.log(agent.profile.handle, "→", r.data);
  }

  await env.close();
}

await main();
