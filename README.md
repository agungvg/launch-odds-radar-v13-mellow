[![token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/agungvg/launch-odds-radar-v13-mellow/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/agungvg/launch-odds-radar-v13-mellow/reward.svg)](https://make.fun/bounty/token-radar-01)

# Launch-Odds Radar v13-mellow

A pre-token launch radar for the [token-radar-01 bounty on make.fun](https://make.fun/bounty/token-radar-01): every pre-token protocol priced off a fitted size curve, with the odds it ever launches and a costed farm plan for each one. Built fresh under @mellow-robin-54 from the v13 method.

## What it does

- **Board — 198 rows.** Every pre-token protocol that is not a wrapped, staked or bridged product, not an exchange and not a versioned pool. The watchlist (40/40) is the floor, never the ceiling.
- **Value model — one term, tested held-out twice.** Ridge (λ = 3) of log10(mcap/TVL) on log10(TVL) only, fitted on the 95 traded protocols with a known listing date and refit from the snapshot on every run: `log10(ratio) = 3.4015 − 0.5266 × log10(TVL)`. A term enters only when it lowers the held-out miss in **both** the leave-one-out and the walk-forward tests — no candidate term did (see the term table in the dashboard's model notes). Per-category mean ratios are never a feature: a category's own mean leaks the answer for its members.
- **Odds — age only.** Logistic on log10(no-token age), trained on the 413 protocols with a known listing date (95 traded, 318 pre-token): `logit = −8.96 + 2.78 × log10(age days)`. Odds are the peers' cross-sectional record, not a forward hazard. Platt slope 0.98 / intercept −0.02 on out-of-fold odds — close to calibrated, no recalibration applied.
- **Intervals — honest and wide.** Normal head, σ = 0.862 dex (leave-one-out residual spread). Rank 1: Sentora Curator, $74.2M implied, P10–P90 $5.8M–$944.2M.
- **Farm economics — net only.** Gross = implied × 5% pool × 0.020% deposit share × odds; cost = $15 gas + 2h × $15/h = $45. Farm when net > 0, Thin when gross covers gas but not time, Skip otherwise. Verdicts: **Farm 19 / Thin 64 / Skip 115**. Every row carries a costed 10-step farm plan (198/198), its 3 nearest priced peers, a 3×3 sensitivity grid and a bootstrap rank range (200 refits, seeded).
- **Ledger — 758/758.** Every protocol in the snapshot is accounted for: 198 ranked, 128 live with a positive market cap, 272 with a token but no market cap recorded, 15 with market cap recorded as zero, 1 with market cap recorded negative (AUTOfinance, −1), 144 pre-token excluded as wrapped / staked / bridged / versioned.

## Honest scorecard

Miss = geometric-mean miss (10 to the mean absolute log10 residual).

| Test | This entry | Target | Verdict |
|---|---|---|---|
| Leave-one-out miss | ×4.36 (median ×3.16) | ≤ ×3.33 | MISS |
| Walk-forward miss (66 older → 29 newer) | ×5.51 (median ×3.40) | ≤ ×2.53 | MISS |
| Worst 5-fold fold (seed 42) | ×6.96 (median fold ×3.70) | no fold > ×4.5 | MISS |
| Worst 5-fold fold (seeds 0–19 sweep) | ×8.50 | no fold > ×4.5 | MISS |
| P25–P75 coverage, LOO | 56.8% (WF 55.2%) | ≥ 57% | MISS |
| P10–P90 coverage, LOO | 84.2% (WF 82.8%) | ≥ 76% | PASS |
| Odds AUC, 5-fold | 0.744 (time-split 0.628) | ≥ 0.79 | MISS |
| Odds Brier, 5-fold | 0.153 (time-split 0.106) | ≤ 0.215 | PASS |

2 of 7 strict targets held. The walk-forward test holds three extreme ratios no size curve can foresee; the medians beside the means show that. Nothing here is inflated: the dashboard's model-notes table shows the same numbers, misses included.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Node 22+, standard library only. The program writes `board.json`, `data.js`, `dashboard/` (3 files), `screenshots/` (3 images) and `dossier.json`, and refuses a board the gate would refuse or any output naming a network address. Two runs are byte-identical (board, data.js and dossier hashes match).

## Files

- `main.ts` — entry program
- `lib/model.ts` — the model, the tests and the board
- `vendor/makefun-board.ts` — make.fun's dossier library, copied from the kit
- `dashboard/` — the static page (index.html, app.css, app.js; 30,734 bytes total, no network address anywhere)
- `screenshots/` — 1-board.png (the board), 2-detail.png (rank #1 detail), 3-filtered.png (Farm-filtered board)
