# sealion

## 0.1.0

### Minor Changes

- [`6368bf7`](https://github.com/nonomnonom/sealion/commit/6368bf7faddc933936ea08d38c30d45eb40111e1) Thanks [@nonomnonom](https://github.com/nonomnonom)! - Initial public release.

  - Multi-agent market simulation core: `SealionEnv`, `Exchange`, `MatchingEngine`, `Channel`, SQLite persistence.
  - 15 trading actions covering orders, account, copy-trade, signals.
  - 8 pluggable price simulators: `ConstantPrice`, `RandomWalk`, `GBM`, `MeanReversion`, `Replay`, `JumpDiffusion`, `Composite`, `Scripted`.
  - Market presets: `spotPreset`, `perpPreset`, `equityPreset`, `customMarket`.
  - `TraderGraph` with optional copy-trade edges.
  - `TradingAgent` (Mastra `Agent` wrapper) with lazy LLM construction; opt-in `model`, `memory`, `scorers`.
  - `MarketMakerBot` for rule-based auto-quoting.
  - `Scenario` orchestrator (market + pricer + traders + decision policy → run).
  - Risk gates: `maxPosition`, `maxOrderNotional`, `maxDrawdown` (auto-freeze).
  - Self-trade prevention in matching engine.
  - `Metrics` with FIFO win-rate, Sharpe, max drawdown, equity curve, fees.
  - Mastra integration helpers: `collectMastraAgents`, `sealionObservabilityConfig`.
  - Built-in scorers: `createPnLScorer`, `createPersonaConsistencyScorer`.
  - Shared utilities: `safeNumber`, `safeStringify`, `applyFillToPosition`.
  - 5 runnable examples + 40 tests on Bun + bun:sqlite.
  - Apache-2.0.

This project uses [Changesets](https://github.com/changesets/changesets) — every notable change is described by a markdown file in `.changeset/` and the entries roll up here automatically when a release is cut.

To propose a change:

```bash
bun run changeset
```

To cut a release locally (rare — usually CI does this):

```bash
bun run version-packages   # bumps version + writes CHANGELOG entries
bun run release            # publishes
```
