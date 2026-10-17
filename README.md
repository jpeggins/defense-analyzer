# 🛡️ D/ST Streamer

A browser-based fantasy-football tool that analyzes **every NFL team's defensive scoring across many
seasons** and answers one question: *which defense should I start this week?*

Built for Sleeper leagues (auto-detects your league's scoring settings and defense ownership), but the
core engine works for any standard-scoring format. 100% client-side — no server, no keys, nothing leaves
your browser except direct calls to public data APIs.

## Quick start

```bash
cd defense-analyzer
python3 -m http.server 8000        # or open index.html directly in Chrome/Safari/Firefox
# visit http://localhost:8000
```

Deploys as-is on GitHub Pages (same shape as `sleeper-league-analyzer`). Requires a browser with
`DecompressionStream` support (Chrome/Edge 80+, Firefox 113+, Safari 16+) to read `.csv.gz` season files.

## Tabs

| Tab | What it does |
|---|---|
| **⭐ Weekly Start Advice** | Ranks every startable defense for a chosen week with projected points, 10–90 percentile range, "boom %" upside, opponent-offense rank, home/dome/London/wind-rain chips, and bye awareness. Completed weeks replay with projections vs actual side-by-side. |
| **🔭 Multi-Year Explorer** | Every team-season since your chosen history start: avg/home/away pts, best week, top-5/top-10 weekly finishes, takeaways & sacks per game — sortable, plus a season-trend chart overlaying any five defenses against the league-average environment. |
| **🧪 Model Backtest** | Re-runs the *entire* model walk-forward in your browser over past seasons and reports what starting its #1/#3 recommendations would have earned vs the median streamable defense, naive baselines, and year-by-year stability. |
| **🏆 My Sleeper League** | Username → league picker. Pulls your league's real `scoring_settings` into the projection engine (tier values, sack/takeaway weights…) and shows which defenses are owned by whom — the advice table then flags **owned ×N / FREE AGENT** and highlights the best addable streamers. |

## The model (how the sausage is made)

**Actual historical D/ST scores** are reconstructed per team-game from nflverse weekly team box scores:
points allowed → tier value, plus simulated-value components (defensive sacks, INTs, forced fumbles,
recoveries, defensive/ST touchdowns, safeties, blocked kicks) mapped onto whatever scoring config is
active (Sleeper-default, BAT classic, tier-only, or your league's exact settings).

**Team identities** are rebuilt before every evaluated week using only games completed before it:
per-team exponentially-weighted (half-life ≈ 45 weeks) rates of points for/allowed, sacks, takeaway
forcing, giveaways, defensive TD and block rates — each shrunk toward league averages (pseudo-count
K = 8 weighted games) with separate home/away splits shrunk more strongly (Kv = 8) so venue quirks can't
overwhelm thin samples.

**Projection**: expected opponent score = venue baseline × offense attack rating × defense vulnerability
rating (each ratio-to-league clamped to sane bounds); then ~1,500 Monte-Carlo draws simulate the final
opponent score (Normal σ = 8.5) through the tier step-function, with Poisson arrivals for sacks/INTs/FF/FR
and Bernoulli defensive-TD/blocked-kick bonuses. The mean across simulations ranks the board — because
tier curves make *variance* tradeable and streamers eat well on variance.

Optional live weather (Open-Meteo) nudges expected opponent scoring down for windy/rainy outdoor games in
the next ~9 days — defenses eat shootout forecasts for breakfast.

## Validation (why trust it)

Parameters were selected once via grid search on walk-forward backtests, then re-measured out-of-sample
on 2020–2026 regular-season weeks (~110+ weeks, never peeking at future data):

- Week-over-week rank correlation between projections and outcomes: **ρ ≈ 0.23** (every season positive, 0.15–0.28)
- Average points of weekly **top-3 recommendations ≈ 8.0 vs 5.2 for the median streamable defense** (+2.8 lift)
- Weekly **#1 recommendation beat the median starter ~70%** of the time
- Beats ablations: matchup-only board ≈ 7.9, blindly-start-home-defense ≈ 6.4

Run the Backtest tab yourself — those numbers are computed live from raw data, not hardcoded.

## Data pipeline (no CORS headaches, no server)

All game data is served **same-origin from this repo** (`/data/*.json.gz`) — a nightly GitHub Action
(`refresh-data.yml`) runs `scripts/refresh_data.py`, which pulls fresh nflverse releases, projects them
to minimal gzipped JSON per season (~400 KB for twenty years total), and commits only changed files.
Historical seasons freeze once complete; the active season refreshes daily through the year, including
future-dated fixtures and flex changes. Visitors therefore touch only three hosts: your Pages domain
(all stats), `api.sleeper.app` (league tab), and `api.open-meteo.com` (optional weather) — both APIs send
proper CORS headers. Parsed payloads stay in localStorage ~12 hours.

Sources: [nflverse](https://nflverse.com) · [Sleeper public API](https://docs.sleeper.app) · [Open-Meteo](https://open-meteo.com). All free/public data; unofficial fan project — not affiliated with or endorsed by the NFL or Sleeper.

## Limitations (read me)

- No injury/QB-change/coaching/motivation awareness — ratings come purely from past results. Treat the
  board as strong priors; a backup QB announcement can flip a spot decision.
- Sacks-counting differs per league: toggle **"sacks count for D/ST"** to match yours (Sleeper's default
  virtual DEF scorables credit sacks).
- Pre-2016 years loadable but pre-modern rules/environments shrink their relevance; defaults start at 2016.
- Playoff weeks aren't projected in v1 (slates differ; consider a hypothetical in the explorer).

Unofficial fan project — not affiliated with or endorsed by the NFL or Sleeper.
