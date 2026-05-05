// Smoke test: manual orders, no LLM, no pricer.
// The market spec is built explicitly — Sealion has no hardcoded default.
//
// Run: bun run examples/spot-manual.ts

import { existsSync, unlinkSync } from "node:fs";
import {
  ActionType,
  ManualAction,
  OrderSide,
  TraderProfile,
  TraderGraph,
  TradingAgent,
  computeMetrics,
  make,
  spotPreset,
  type StepActions,
} from "../src/index.ts";

const DB_PATH = "./data/spot_manual.db";

async function main() {
  if (existsSync(DB_PATH)) unlinkSync(DB_PATH);

  const registry = new TraderGraph();
  registry.addAgent(
    new TradingAgent({
      agentId: 0,
      profile: new TraderProfile({
        handle: "maker",
        initialCash: 50_000,
        initialPosition: 100,
        persona: { style: "market-making" },
      }),
    }),
  );
  registry.addAgent(
    new TradingAgent({
      agentId: 1,
      profile: new TraderProfile({
        handle: "taker",
        initialCash: 20_000,
        persona: { style: "momentum" },
      }),
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
  const taker = registry.getAgent(1);

  const t1: StepActions = new Map();
  t1.set(maker, [
    new ManualAction({
      actionType: ActionType.PLACE_LIMIT_ORDER,
      actionArgs: { side: OrderSide.BUY, price: 99.5, size: 5 },
    }),
    new ManualAction({
      actionType: ActionType.PLACE_LIMIT_ORDER,
      actionArgs: { side: OrderSide.SELL, price: 100.5, size: 5 },
    }),
  ]);
  await env.step(t1);

  const t2: StepActions = new Map();
  t2.set(
    taker,
    new ManualAction({
      actionType: ActionType.PLACE_MARKET_ORDER,
      actionArgs: { side: OrderSide.BUY, size: 3 },
    }),
  );
  await env.step(t2);

  console.log("\nMaker:", (await maker.performActionByData(ActionType.GET_ACCOUNT)).data);
  console.log("Taker:", (await taker.performActionByData(ActionType.GET_ACCOUNT)).data);
  console.log("\nMaker metrics:", computeMetrics(env.exchange.db, 0, maker.profile.initialCash));
  console.log("Taker metrics:", computeMetrics(env.exchange.db, 1, taker.profile.initialCash));

  await env.close();
}

await main();
