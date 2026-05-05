// Flash-crash scenario: GBM base + a scripted -15% shock at step 50.
// Two rule-based agents react to the dump differently: a buy-the-dip mean
// reverter vs. a momentum follower that sells weakness.
//
// Run: bun run examples/scenario-flash-crash.ts

import {
  ActionType,
  GBM,
  ManualAction,
  OrderSide,
  Scenario,
  Scripted,
  TraderProfile,
  TraderGraph,
  TradingAgent,
  makeMarketMaker,
  spotPreset,
} from "../src/index.ts";

async function main() {
  const registry = new TraderGraph();
  // Liquidity provider — quotes around mark each step.
  registry.addAgent(
    makeMarketMaker({ agentId: 0, cash: 1_000_000, position: 100, spreadBps: 30, quoteSize: 0.5 }),
  );
  // Buy-the-dip mean reverter.
  registry.addAgent(
    new TradingAgent({
      agentId: 1,
      profile: new TraderProfile({
        handle: "dip_buyer",
        initialCash: 200_000,
        persona: { style: "mean-reversion", thesis: "Buy capitulation." },
      }),
    }),
  );
  // Momentum follower that sells weakness.
  registry.addAgent(
    new TradingAgent({
      agentId: 2,
      profile: new TraderProfile({
        handle: "trend_follower",
        initialCash: 200_000,
        initialPosition: 1,
        persona: { style: "momentum", thesis: "Sell rapid down moves." },
      }),
    }),
  );

  let lastMark = 100;

  const sc = new Scenario({
    market: spotPreset({ symbol: "BTC/USDT", takerFeeBps: 5, makerFeeBps: 1 }),
    databasePath: "./data/flash_crash.db",
    fresh: true,
    traders: registry,
    pricer: new Scripted({
      base: new GBM({ start: 100, mu: 0, sigma: 0.005, steps: 100, seed: 1 }),
      shocks: [{ atStep: 50, multiplier: 0.85 }], // -15% flash crash
    }),
    initialPrice: 100,
    steps: 100,
    decideAction: (agent, ctx) => {
      const mark = ctx.mark ?? lastMark;
      const ret = (mark - lastMark) / Math.max(lastMark, 1e-9);
      lastMark = mark;
      if (agent.agentId === 1 && ret < -0.05) {
        // Big drop → buy.
        return new ManualAction({
          actionType: ActionType.PLACE_MARKET_ORDER,
          actionArgs: { side: OrderSide.BUY, size: 0.5 },
        });
      }
      if (agent.agentId === 2 && ret < -0.02) {
        // Drop → sell to cut exposure.
        return new ManualAction({
          actionType: ActionType.PLACE_MARKET_ORDER,
          actionArgs: { side: OrderSide.SELL, size: 0.2 },
        });
      }
      return null;
    },
  });

  const result = await sc.run();
  console.log(`\nRan ${result.steps} steps.\n=== Accounts ===`);
  for (const a of result.accounts) console.log(a);
  console.log("\n=== Metrics ===");
  for (const [id, m] of result.metrics) {
    console.log(`agent ${id} (${result.accounts.find((x) => x.agentId === id)?.handle}):`, m);
  }
}

await main();
