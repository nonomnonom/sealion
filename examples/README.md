# Sealion examples

| File                      | Run                                                  | Demonstrates                                                                                          |
| ------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `spot-manual.ts`          | `bun run examples/spot-manual.ts`                    | Manual `ManualAction` orders only — no LLM. Two traders, one cross fill, metrics.                     |
| `position-sim.ts`         | `bun run examples/position-sim.ts`                   | "What-if" position simulation: a hodler and a shorter watch P&L evolve under GBM, no trading.         |
| `scenario-flash-crash.ts` | `bun run examples/scenario-flash-crash.ts`           | `Scripted` pricer with -15% shock at step 50. Mean-reverter buys the dip, momentum follower sells it. |
| `copy-trade.ts`           | `bun run examples/copy-trade.ts`                     | Leader places market buy, follower mirrors at 0.5 ratio.                                              |
| `backtest.ts`             | `bun run examples/backtest.ts`                       | `Replay` pricer over synthetic OHLCV; rule-based traders react to ticks.                              |
| `spot-llm.ts`             | `OPENAI_API_KEY=sk-... bun run examples/spot-llm.ts` | Four LLM personas trade on GBM-driven market. Requires API key.                                       |

## What you'll need

For LLM-driven examples (`spot-llm.ts`), set the API key in your shell or a `.env` file. See `.env.example` at the project root for supported providers.

For all other examples: nothing — pure-rule sims need no external services.

## What outputs to look at

After each run, check the SQLite db (e.g. `./data/spot_manual.db`) — every action is in the `trace` table, every fill in the `trade` table, every account snapshot in `account`. Use `printDbContents("./data/spot_manual.db")` from the framework or open in any SQLite browser.

## Building your own

Three patterns:

1. **Manual decision loop** (no harness) — see `spot-manual.ts`, `copy-trade.ts`. You drive `env.step(actions)` directly.
2. **Scenario harness** (with pricer) — see `position-sim.ts`, `backtest.ts`, `scenario-flash-crash.ts`. The `Scenario` class runs the loop, you supply `decideAction(agent, ctx)`.
3. **LLM-driven** — see `spot-llm.ts`. Pass `model: "provider/model"` to each `TradingAgent`, then submit `LLMAction()` per turn.

You can mix all three in one sim — e.g. an LLM agent + a rule-based agent + a `MarketMakerBot` for liquidity, all driven from one `Scenario`.
