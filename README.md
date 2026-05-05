# Sealion

[![npm version](https://img.shields.io/npm/v/sealion-sim.svg?style=flat-square&color=cb3837)](https://www.npmjs.com/package/sealion-sim)
[![npm downloads](https://img.shields.io/npm/dm/sealion-sim.svg?style=flat-square&color=cb3837)](https://www.npmjs.com/package/sealion-sim)
[![CI](https://img.shields.io/github/actions/workflow/status/nonomnonom/sealion/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/nonomnonom/sealion/actions/workflows/ci.yml)
[![License](https://img.shields.io/npm/l/sealion-sim.svg?style=flat-square&color=informational)](./LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.1-black.svg?style=flat-square)](https://bun.com/)

**Multi-agent market simulation framework for traders.** Built on [Mastra](https://mastra.ai/) so you can pick **any LLM provider** Mastra supports (OpenAI, Anthropic, Google, DeepSeek, Groq, Mistral, xAI, OpenRouter, Ollama, etc.) and gain Memory / Workflows / Scorers / Observability for free. Persistence via [`bun:sqlite`](https://bun.com/docs/api/sqlite).

> ⚠️ **Bun-only.** Sealion uses `bun:sqlite` directly. Node.js is not supported — install [Bun](https://bun.com/) ≥ 1.1.

## Install

```bash
bun add sealion-sim
```

```ts
import {
  ActionType,
  TraderGraph,
  LLMAction,
  TradingAgent,
  TraderProfile,
  make,
  spotPreset,
} from "sealion-sim";

const traders = new TraderGraph();
traders.addAgent(
  new TradingAgent({
    agentId: 0,
    profile: new TraderProfile({ handle: "alice", initialCash: 10_000 }),
    model: "openai/gpt-4o-mini", // or anthropic/, google/, groq/, deepseek/...
  }),
);

const env = make({
  traders,
  market: spotPreset({ symbol: "BTC/USDT" }),
  databasePath: "./data/sim.db",
});

await env.reset();
await env.step(new Map([[traders.getAgent(0), new LLMAction()]]));
await env.close();
```

## Mental model

```
                    ┌──────────────────────────────────────┐
                    │             Scenario                 │
                    │  market + pricer + traders + policy  │
                    └───────────────┬──────────────────────┘
                                    │ .run()
                                    ▼
       ┌──────────────────────────────────────────────────────┐
       │                     SealionEnv                       │
       │            reset / step / close lifecycle            │
       └───────┬───────────────────────────────────┬──────────┘
               │ tools dispatch                    │ pricer.next() each step
               ▼                                   ▼
   ┌────────────────────┐               ┌────────────────────┐
   │  TradingAgent      │ ──Channel──▶ │  Exchange          │
   │  (Mastra Agent)    │ ◀───────────  │  + MatchingEngine  │
   │  + MarketMakerBot  │               │  + Risk gate       │
   └────────────────────┘               │  + SQLite          │
                                        └────────────────────┘
```

`TraderGraph` API:

```ts
graph.addAgent(agent);
graph.removeAgent(agent);
graph.getAgent(agentId);
graph.getAgents(); // → Array<[id, agent]>
graph.getAgents([0, 1, 2]); // filter by ids
graph.hasAgent(agentId);
graph.getNumNodes();
// copy-trade edges (optional):
graph.addEdge(leaderId, followerId, ratio);
graph.removeEdge(followerId);
graph.getEdges(); // → [leaderId, followerId, ratio]
graph.getNumEdges();
graph.getFollowers(leaderId);
graph.getLeader(followerId);
graph.isLeader(agentId);
graph.isCopying(agentId);
```

## Folder layout

```
src/
├── environment/
│   ├── env.ts                         SealionEnv (reset/step/close)
│   ├── env-action.ts                  ManualAction / LLMAction
│   └── make.ts                        make() factory
├── trading-agent/
│   ├── agent.ts                       TradingAgent (wraps Mastra Agent)
│   ├── agent-action.ts                Mastra createTool() per action
│   ├── agent-environment.ts           Per-agent prompt/data view
│   ├── agent-graph.ts                 TraderGraph (nodes + copy-trade edges)
│   ├── agents-generator.ts            ARCHETYPES + factories
│   └── market-maker-bot.ts            Rule-based auto-quoting bot
├── platform/
│   ├── platform.ts                    Exchange (matching + dispatch)
│   ├── channel.ts                     Actor mailbox (FIFO per agent)
│   ├── database.ts                    SQLite schema + helpers
│   ├── matching-engine.ts             Price-time priority + self-trade prevention
│   ├── pricer.ts                      8 price-process simulators
│   ├── typing.ts                      ActionType / OrderSide / etc.
│   └── config/trader-info.ts          TraderProfile + persona blocks
├── clock/clock.ts                     SandboxClock
├── testing/show-db.ts                 printDbContents
├── scenarios/scenario.ts              High-level orchestrator
├── markets/presets.ts                 spot / perp / equity / custom
├── evals/scorers.ts                   Mastra scorer factories (PnL, persona)
├── mastra-integration.ts              collectMastraAgents, observability config
└── metrics.ts                         Sharpe, max DD, FIFO win rate
```

## Pick any model

Anything Mastra's [model router](https://mastra.ai/models) supports — string-shorthand `"provider/model"`:

```ts
new TradingAgent({ ..., model: "openai/gpt-4o-mini" });
new TradingAgent({ ..., model: "anthropic/claude-sonnet-4.5" });
new TradingAgent({ ..., model: "google/gemini-2.0-flash" });
new TradingAgent({ ..., model: "groq/llama-3.3-70b-versatile" });
new TradingAgent({ ..., model: "deepseek/deepseek-chat" });
new TradingAgent({ ..., model: "openrouter/meta-llama/llama-3.1-405b" });
new TradingAgent({ ..., model: "ollama/llama3.1" });
// ...100+ providers via Mastra
```

Or pass an AI SDK `LanguageModel` instance, or any Mastra `MastraModelConfig`.

## Mastra integration (built-in)

### Memory — opt-in journaling per trader

```ts
import { Memory } from "@mastra/memory";

new TradingAgent({
  agentId: 0,
  profile,
  model: "openai/gpt-4o-mini",
  memory: new Memory({ options: { lastMessages: 20, observationalMemory: true } }),
});
```

### Studio — observability + scorers + experiments

```ts
import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import { Observability } from "@mastra/observability";
import { collectMastraAgents, sealionObservabilityConfig } from "sealion-sim";

export const mastra = new Mastra({
  agents: collectMastraAgents(traders),
  storage: new LibSQLStore({ url: "file:./mastra.db" }),
  observability: new Observability(sealionObservabilityConfig({})),
});
```

Studio menampilkan setiap trade decision, tool call, token usage, dan trace.

### Scorers — built-in trading evals

```ts
import { createPnLScorer, createPersonaConsistencyScorer } from "sealion-sim";

const pnl = createPnLScorer({ baselineEquity: 10_000, targetEquity: 15_000 });
const result = await pnl.run({
  db: env.exchange.db,
  agentId: 0,
  startingCash: 10_000,
});
// → { score: 0.42, reason: "...", metadata: { totalReturnPct, sharpe, maxDrawdownPct, ... } }
```

Bisa juga di-attach langsung ke `TradingAgent`:

```ts
new TradingAgent({
  ...,
  scorers: {
    pnl: { scorer: pnl, sampling: { type: "ratio", rate: 1 } },
  },
});
```

## Trading actions (15)

```ts
ActionType.PLACE_LIMIT_ORDER; // { side, price, size }
ActionType.PLACE_MARKET_ORDER; // { side, size }
ActionType.CANCEL_ORDER; // { order_id }
ActionType.CANCEL_ALL_ORDERS; // {}
ActionType.GET_ORDERBOOK; // { depth? }
ActionType.GET_RECENT_TRADES; // { limit? }
ActionType.GET_ACCOUNT; // {}  → cash, position, avg, P&L, equity
ActionType.GET_OPEN_ORDERS; // {}
ActionType.DO_NOTHING; // {}
ActionType.COPY_TRADE; // { leader_id, ratio }
ActionType.UNFOLLOW; // {}
ActionType.SHARE_SIGNAL; // { content, symbol?, bias? }
ActionType.GET_SIGNALS; // { limit? }
ActionType.INTERVIEW; // { prompt, response }
```

Default subsets: `DEFAULT_TRADER_ACTIONS`, `SOCIAL_TRADER_ACTIONS`, `SOCIAL_PLUS_TRADING_ACTIONS`.

## Pluggable price simulators

All deterministic given a `seed`.

```ts
new ConstantPrice({ price: 100, steps: 50 });
new RandomWalk({ start: 100, sigma: 1, drift: 0.01, seed: 42 });
new GBM({ start: 50_000, mu: 0.0001, sigma: 0.02, seed: 42 });
new MeanReversion({ start: 100, mu: 100, theta: 0.1, sigma: 1, seed: 42 });
new Replay({ ticks: [{ price: 100 }, { price: 101 }, ...] });
new JumpDiffusion({ base: gbm, jumpProb: 0.05, jumpStd: 0.1 });
new Composite([calmRegime, volatileRegime]);
new Scripted({ base, shocks: [{ atStep: 50, multiplier: 0.85 }] });
```

## Market presets (no global default)

```ts
spotPreset({ symbol: "BTC/USDT" });
perpPreset({ symbol: "BTC-PERP" });
equityPreset({ symbol: "AAPL" });
customMarket({ symbol, baseAsset, quoteAsset, tickSize, lotSize, takerFeeBps, makerFeeBps });
```

## High-level harness — `Scenario`

```ts
import { Scenario, GBM, Scripted, spotPreset, makeMarketMaker } from "sealion-sim";

const traders = new TraderGraph();
traders.addAgent(makeMarketMaker({ agentId: 0, cash: 1_000_000, position: 100 }));
traders.addAgent(new TradingAgent({ ... }));

const sc = new Scenario({
  market: spotPreset({ symbol: "BTC/USDT" }),
  databasePath: "./data/sim.db",
  fresh: true,
  traders,
  pricer: new Scripted({
    base: new GBM({ start: 50_000, mu: 0, sigma: 0.02, seed: 1 }),
    shocks: [{ atStep: 50, multiplier: 0.85 }], // -15% flash crash
  }),
  steps: 100,
  decideAction: (agent, ctx) => myStrategy(agent, ctx),
});

const result = await sc.run();
// → { steps, metrics: Map<id, Metrics>, accounts, env }
```

## Examples

```bash
bun run examples/spot-manual.ts          # manual orders, no LLM
bun run examples/position-sim.ts         # hold a position, watch P&L vs GBM
bun run examples/scenario-flash-crash.ts # scripted -15% shock
bun run examples/copy-trade.ts           # leader fill → follower mirror
bun run examples/backtest.ts             # Replay synthetic OHLCV
OPENAI_API_KEY=sk-... bun run examples/spot-llm.ts
```

Lihat [`examples/README.md`](examples/README.md) untuk overview tiap demo.

## Quality of life

```bash
bun run lint           # oxlint
bun run lint:fix
bun run format         # oxfmt --write
bun run format:check
bun run typecheck      # tsc --noEmit
bun run check          # format + lint + typecheck
bun test               # 26 tests covering engine, copy-trade, pricers, risk, scenarios
```

## Catatan desain

- **No global defaults** — `MarketSpec` selalu eksplisit lewat preset.
- **Lazy LLM agent** — Mastra `Agent` cuma diinstansiasi saat aksi LLM dipakai, jadi sim pure-manual tidak butuh API key.
- **Single-writer SQLite** — semua mutasi diserialisasikan oleh `Exchange.runLoop()` lewat `Channel`.
- **Self-trade prevention** — matching engine otomatis exclude order dari agent yang sama.
- **Cached mark price** — invalidasi otomatis pada injectPrice / fill.
- **Skip read-only trace** — `GET_*` actions tidak nge-spam trace table.
- **FIFO win-rate** — `computeMetrics` pair fills properly bukan running-avg approximation.
- **Apa pun bisa disimulasikan** — harga, posisi, regime shift, copy-trade, news shock, multi-LLM benchmark — semua dari building blocks yang sama.

## License

Apache-2.0.
