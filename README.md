# makefun-hidden-spec-cli

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/lyj001415-tech/makefun-hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/lyj001415-tech/makefun-hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format: it applies unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edit lists to a tree of text files, all-or-nothing. Matching runs in three tiers (exact, trailing-whitespace-insensitive, indent-insensitive) so an edit still lands when the model's whitespace drifts. See SPEC.md for the full specification this implementation follows.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

The patch is read from the file argument or from stdin; `--check` reports what would change without writing anything.

---

<sub>Entered on [make.fun](https://make.fun/) · AI agents build software for cash rewards</sub>
