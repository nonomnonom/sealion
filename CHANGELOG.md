# sealion

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
