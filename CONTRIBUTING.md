# Contributing to Sealion

Thanks for your interest! Sealion is a Bun-first, TypeScript-first multi-agent market simulation framework. This guide covers how to set up your environment, run the test suite, and submit changes.

## Prerequisites

- [Bun](https://bun.com/) ≥ 1.1
- Git

That's it. No Node toolchain required — Sealion uses `bun:sqlite` and runs `.ts` directly.

## Setup

```bash
git clone https://github.com/nonomnonom/sealion.git
cd sealion
bun install
```

Verify everything works:

```bash
bun run check          # format + lint + typecheck
bun test               # full suite (~40 tests)
bun run examples/spot-manual.ts   # smoke test
```

## Project structure

See [README.md → Folder layout](./README.md#folder-layout) for the full map.

| Where                | What                                                     |
| -------------------- | -------------------------------------------------------- |
| `src/environment/`   | `SealionEnv`, `make()`, `ManualAction` / `LLMAction`     |
| `src/trading-agent/` | `TradingAgent`, `TraderGraph`, `MarketMakerBot`, tools   |
| `src/platform/`      | `Exchange`, `MatchingEngine`, `Channel`, SQLite, pricers |
| `src/scenarios/`     | High-level `Scenario` orchestrator                       |
| `src/markets/`       | Market preset factories                                  |
| `src/evals/`         | Mastra scorer factories                                  |
| `src/utils.ts`       | Shared utilities (`safeNumber`, `safeStringify`, …)      |
| `test/`              | Bun tests                                                |
| `examples/`          | Runnable demos                                           |

## Development workflow

### Before opening a PR

```bash
bun run check && bun test
```

Both must pass. CI will run them again on the PR.

### Code style

- **Formatter**: `oxfmt` (run `bun run format`).
- **Linter**: `oxlint` (run `bun run lint`).
- **TypeScript**: strict mode (`tsconfig.json`), no `any` unless documented why.
- **Naming**: DB row interfaces use `snake_case` (mirror columns); public business types use `camelCase`.

### Tests

Add tests for any new behavior. Tests live in `test/*.test.ts`. Use Bun's built-in test runner:

```bash
bun test                         # all
bun test test/quality-gaps.test.ts   # one file
bun test -t "name fragment"      # filter
```

Test DBs go in `./data/` (gitignored). Use the `freshDb()` helper for unique paths so parallel tests don't collide.

### Commit style

Conventional Commits encouraged but not enforced:

- `feat: add stop-loss order type`
- `fix: prevent self-trade in matching engine`
- `docs: update Mastra integration example`
- `test: cover partial fill edge case`
- `chore: bump @mastra/core to 1.32`

### Changesets

Sealion uses [Changesets](https://github.com/changesets/changesets) for versioning + changelog generation. **Any user-visible change** (feature, fix, breaking change) needs a changeset:

```bash
bun run changeset
```

The CLI prompts:

1. Which packages bumped — pick `sealion`.
2. Bump type — `patch` (fix), `minor` (feature), `major` (breaking).
3. Summary — written to the CHANGELOG entry.

Commit the generated `.changeset/*.md` file alongside your code.

Skip changesets for chore/test/docs-only PRs (no published behavior change). The release workflow ignores PRs without changesets.

### Cutting a release

CI handles it: the release workflow opens a "version packages" PR aggregating pending changesets. Merging that PR bumps `package.json`, regenerates `CHANGELOG.md`, tags the commit, and (if `NPM_TOKEN` is set) publishes to npm.

## What's in scope

✅ Welcomed:

- New price simulators (`PriceSimulator`)
- New agent archetypes / personas
- New Mastra scorers
- New examples (real data adapters, novel strategies)
- Performance improvements with benchmarks
- Bug fixes with regression tests
- Documentation improvements

❌ Out of scope (might still be useful — open an issue first):

- Live broker / real-money execution adapters (Sealion is a simulator)
- Non-Bun runtimes (`bun:sqlite` is core)
- Frontend / charting libraries

## Questions / proposals

Open a GitHub issue using one of the templates. For sizable changes, a quick design issue before a PR saves everyone time.

## Code of conduct

Be respectful. Engage with the code, not the contributor.

## License

By contributing, you agree your contributions are licensed under [Apache-2.0](./LICENSE).
