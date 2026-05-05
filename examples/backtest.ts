// Backtest example — replays a synthetic OHLCV array through a Scenario with
// a `Replay` pricer. Demonstrates that backtesting is just a Scenario with the
// right pricer.
//
// Run: bun run examples/backtest.ts

import {
  ActionType,
  ManualAction,
  OrderSide,
  Replay,
  Scenario,
  TraderProfile,
  TraderGraph,
  TradingAgent,
  makeMarketMaker,
  spotPreset,
  type PriceTick,
} from "../src/index.ts";

const N = 200;

function syntheticTicks(): PriceTick[] {
  const out: PriceTick[] = [];
  let p = 100;
  let ts = Date.now();
  for (let i = 0; i < N; i++) {
    const shock = (Math.random() - 0.5) * 1.0;
    p = Math.max(1, p + 0.01 + shock);
    out.push({ price: p, volume: Math.random() * 5, timestamp: ts });
    ts += 60_000;
  }
  return out;
}

async function main() {
  const registry = new TraderGraph();
  // MM provides liquidity so market orders find fills.
  registry.addAgent(
    makeMarketMaker({ agentId: 99, cash: 1_000_000, position: 50, spreadBps: 30, quoteSize: 0.5 }),
  );
  registry.addAgent(
    new TradingAgent({
      agentId: 0,
      profile: new TraderProfile({ handle: "buy_dip", initialCash: 10_000 }),
    }),
  );
  registry.addAgent(
    new TradingAgent({
      agentId: 1,
      profile: new TraderProfile({ handle: "sell_rip", initialCash: 10_000, initialPosition: 1 }),
    }),
  );

  let last = 100;
  const sc = new Scenario({
    market: spotPreset({ symbol: "BTC/USDT" }),
    databasePath: "./data/backtest.db",
    fresh: true,
    traders: registry,
    pricer: new Replay({ ticks: syntheticTicks() }),
    initialPrice: 100,
    steps: N,
    decideAction: (agent, ctx) => {
      if (agent.agentId === 99) return null; // MM auto-quotes
      const m = ctx.mark ?? last;
      const dir = m - last;
      last = m;
      if (agent.agentId === 0 && dir < -0.2) {
        return new ManualAction({
          actionType: ActionType.PLACE_MARKET_ORDER,
          actionArgs: { side: OrderSide.BUY, size: 0.05 },
        });
      }
      if (agent.agentId === 1 && dir > 0.2) {
        return new ManualAction({
          actionType: ActionType.PLACE_MARKET_ORDER,
          actionArgs: { side: OrderSide.SELL, size: 0.05 },
        });
      }
      return null;
    },
  });

  const result = await sc.run();
  console.log(`\nRan ${result.steps} steps.\n=== Accounts ===`);
  for (const a of result.accounts) console.log(a);
  console.log("\n=== Metrics ===");
  for (const [id, m] of result.metrics) console.log(`agent ${id}:`, m);
}

await main();
