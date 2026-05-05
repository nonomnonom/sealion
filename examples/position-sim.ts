// Position-only simulation: hold a starting position, watch P&L evolve as the
// price walks via GBM. No agent decisions — just exposure to a price process.
// Demonstrates that Sealion can simulate "anything market-related," including
// scenarios where agents don't trade at all.
//
// Run: bun run examples/position-sim.ts

import {
  GBM,
  Scenario,
  TraderProfile,
  TraderGraph,
  TradingAgent,
  spotPreset,
} from "../src/index.ts";

async function main() {
  const registry = new TraderGraph();
  registry.addAgent(
    new TradingAgent({
      agentId: 0,
      profile: new TraderProfile({
        handle: "hodler",
        initialCash: 0,
        initialPosition: 1, // 1 BTC, no cash
      }),
    }),
  );
  registry.addAgent(
    new TradingAgent({
      agentId: 1,
      profile: new TraderProfile({
        handle: "shorter",
        initialCash: 100_000,
        initialPosition: -1, // 1 BTC short
      }),
    }),
  );

  const sc = new Scenario({
    market: spotPreset({ symbol: "BTC/USDT" }),
    databasePath: "./data/position_sim.db",
    fresh: true,
    traders: registry,
    pricer: new GBM({ start: 50_000, mu: 0.0002, sigma: 0.02, steps: 100, seed: 42 }),
    initialPrice: 50_000,
    steps: 100,
    // No decideAction → agents don't trade. We just observe equity.
  });

  const result = await sc.run();
  console.log(`\nRan ${result.steps} steps.\n`);
  console.log("=== Final accounts ===");
  for (const a of result.accounts) console.log(a);
  console.log("\n=== Metrics ===");
  for (const [id, m] of result.metrics) console.log(`agent ${id}:`, m);
}

await main();
