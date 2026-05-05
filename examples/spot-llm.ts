// LLM-driven multi-agent trading sim using a pluggable price simulator.
// Each persona is a Mastra Agent that decides its own action each step.
//
// Run: OPENAI_API_KEY=sk-... bun run examples/spot-llm.ts

import { existsSync, unlinkSync } from "node:fs";
import {
  ActionType,
  GBM,
  LLMAction,
  Scenario,
  TraderProfile,
  TradingAgent,
  computeMetrics,
  generateTraderGraph,
  makeMarketMaker,
  spotPreset,
} from "../src/index.ts";

const DB_PATH = "./data/spot_llm.db";
const MODEL = "openai/gpt-4o-mini";
const STEPS = 8;

async function main() {
  if (existsSync(DB_PATH)) unlinkSync(DB_PATH);

  // 4 LLM personas: momentum / mean-rev / contrarian / market-maker LLM.
  const registry = await generateTraderGraph({ model: MODEL, count: 4 });
  // Plus a deterministic auto-quoting market maker for liquidity.
  registry.addAgent(
    makeMarketMaker({ agentId: 99, cash: 1_000_000, position: 100, spreadBps: 30, quoteSize: 1 }),
  );
  void TraderProfile; // imported for users who want it explicitly

  const sc = new Scenario({
    market: spotPreset({ symbol: "BTC/USDT" }),
    databasePath: DB_PATH,
    fresh: true,
    traders: registry,
    pricer: new GBM({ start: 100, mu: 0, sigma: 0.01, steps: STEPS, seed: 7 }),
    initialPrice: 100,
    steps: STEPS,
    decideAction: (agent) => {
      if (agent.agentId === 99) return null; // MM auto-quotes via Scenario
      return new LLMAction();
    },
    onStep: (ctx) => {
      console.log(`step ${ctx.step + 1} mark=${ctx.mark?.toFixed(2)}`);
    },
  });

  const result = await sc.run();
  console.log("\n=== final metrics ===");
  for (const [id, m] of result.metrics) {
    const acct = result.accounts.find((a) => a.agentId === id);
    console.log(`${acct?.handle}:`, m);
  }
  void computeMetrics;
  void TradingAgent;
  void ActionType;
}

await main();
