# Launch Radar — token-radar-01 entry

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Jaholicik/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Jaholicik/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Entry for make.fun's [“Build the best token launch radar” bounty](https://make.fun/bounty/token-radar-01).

Ranks the protocols that record no token yet by what a launch would be
worth, and pairs every rank with a concrete farm plan.

## The model

`implied = TVL x category multiple x momentum x maturity x breadth`

- The category multiple is calibrated from the snapshot itself: the
  median market cap / TVL of the protocols that already trade, per
  category, shrunk toward the global median when a category has few
  samples, then clamped.
- Momentum reads the 7-day TVL change through a tanh curve. Maturity
  scales with listing age. Breadth adds a small premium per extra chain.
- The board is the whole sealed watchlist plus the strongest pre-token
  protocols below the TVL floor (records-no-token only). Protocols that
  already trade are shown separately in the dashboard, never ranked.

No protocol names or values are hardcoded; everything derives from the
snapshot figures.

## The dashboard

A dark scope-room page, fully offline. A highlights strip (top of the
board, top early find, biggest 7-day mover, longest running) and a
value-distribution chart sit above a sortable, filterable board with a
sticky header. Every protocol opens a detail drawer: KPI tiles, the
factor bars, the multiplication itself, and an evidence block showing
the trading peers the row's category multiple rests on - their ratio
spread, the category median, and the peers nearest that median. Every
farm plan is written for its own protocol: its chains, its TVL, its
7-day trend and its age set the wording, so no two plans on the board
share a step.

## Run

```sh
node main.ts --input <snapshot.json or its directory>
# output dir: --output <dir>, else $MAKEFUN_OUTPUT_DIR, else /output
```

Node 22+, standard library only, no network. Deterministic: two runs
produce byte-identical output.
