# Launch Radar — token-radar-01 entry

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

## Run

```sh
node main.ts --input <snapshot.json or its directory>
# output dir: --output <dir>, else $MAKEFUN_OUTPUT_DIR, else /output
```

Node 22+, standard library only, no network. Deterministic: two runs
produce byte-identical output.
