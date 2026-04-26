# CLAUDE.md — Prediction Predator

**Last updated:** April 25, 2026
**Stack:** Node.js/Express · Postgres · Anthropic SDK · Kalshi REST v2 · Telegram

---

## What this is

AI-driven Kalshi prediction market signal bot. Built by Jeremiah (Twomiah Software Ventures, Eau Claire WI) — sister project to Twomiah Trader. Twomiah is for equities and runs on Alpaca; Predator is for binary prediction markets and runs on Kalshi.

**v1 ships in `signals` mode**: scan Kalshi, classify markets into lanes, forecast with Claude, fire Telegram alerts when edge ≥ threshold. No real orders. The `live` path is wired but gated behind `TRADING_MODE=live` AND `LIVE_TRADING_CONFIRMED=true`.

---

## Lanes (in/out of scope)

In scope:
- `tech` — tech/AI launches, milestones, IPOs, stock-price targets, model releases, named-company news
- `current_events` — breaking news, cultural happenings, geopolitics, awards, box office, viral events
- `sports_arb` — sports ONLY in narrow news-arb cases (thin derivative props); skip game-winner lines vs Vegas

Out of scope (do NOT add agents for these without explicit user opt-in):
- Econ (Fed, CPI, jobs, GDP) — user views as rigged
- Politics (elections, legislation, candidate actions) — user views as rigged
- Weather, crypto price targets — deferred

The classifier prompt in `services/marketClassifier.js` is the source of truth. Edit it there if a category is being misclassified.

---

## Architecture

```
prediction-predator/
├── server.js                       Express bootstrap, cron scheduler, graceful shutdown
├── public/index.html               Single-file dashboard (open signals, calibration, recent resolutions)
├── routes/
│   ├── health.js                   GET /health — connectivity + mode summary
│   ├── signals.js                  GET /signals, GET /signals/:id, POST /signals/scan
│   ├── markets.js                  Kalshi passthrough + classifications view
│   ├── calibration.js              Aggregate Brier + per-category breakdown
│   └── trade.js                    GET /trade/mode, balance, positions (live only)
├── services/
│   ├── db.js                       pg Pool, query(), withTx()
│   ├── anthropic.js                Single SDK client; chat() helper with JSON extraction
│   ├── kalshiClient.js             RSA-PSS signed requests; public + authed endpoints
│   ├── broker.js                   THE CHOKEPOINT — every "place order" goes here
│   ├── alertService.js             Telegram bot wrapper; alertSignal/Resolution/Error/Digest
│   ├── marketClassifier.js         Haiku — in-scope/lane decision; cached in market_classifications
│   ├── newsBundler.js              Builds search query, calls feeds/, renders for prompt
│   ├── forecastAgent.js            Sonnet — p_yes + confidence + rationale; supports abstain
│   ├── edgeEvaluator.js            Edge math + fractional Kelly + threshold checks
│   ├── signalLogger.js             Inserts to `signals` (idempotent on ticker+date)
│   ├── marketDiscovery.js          THE ORCHESTRATION LOOP — fetch→classify→bundle→forecast→evaluate→log→alert
│   ├── resolver.js                 Daily cron: settle open signals, recompute calibration
│   └── feeds/
│       ├── newsAPI.js              NewsAPI.org client (cached in news_cache for 30min)
│       ├── hackernews.js           Algolia HN search (free, no key)
│       └── index.js                gatherNewsFor(query, lane) — fans out per lane
├── migrations/
│   └── 001_init.sql                signals, market_classifications, news_cache, calibration_buckets, paper_positions, scan_runs
└── scripts/
    └── migrate.js                  Runs all .sql files in migrations/ in name order
```

---

## Critical seams

### `services/broker.js` is the chokepoint

EVERY order path goes through `placeOrderForSignal(signal)`. Three modes:
- `signals` → returns `{action: 'would_have_bet'}`, no Kalshi call
- `paper` → returns `{action: 'paper_filled'}`, no Kalshi call (TODO: write to paper_positions)
- `live` → calls `kalshi.placeOrder()` only if `LIVE_TRADING_CONFIRMED=true`, else falls back to signals

If you add a new way to "place an order" (e.g. via dashboard button), it MUST go through this function. Don't bypass it.

### `services/marketDiscovery.js` is the loop

`runDiscoveryCycle()` is the heart. Runs on cron (`DISCOVERY_CRON`, default `*/30 * * * *`) and via `POST /signals/scan`.

Steps:
1. `kalshi.listOpenMarkets` (paginated, cap `PER_RUN_MARKET_CAP=200`)
2. Filter by `MIN_HOURS_TO_RESOLUTION` ≤ time-to-close ≤ `MAX_DAYS_TO_RESOLUTION` AND has `yes_ask` + `no_ask`
3. Rank by liquidity (volume_24h + open_interest desc), take top 80
4. `classifyOrCache(market)` → Haiku decides in/out of scope (cached forever in `market_classifications`)
5. For each in-scope (capped at `PER_RUN_FORECAST_CAP=25`):
   - `bundleForMarket` → news context
   - `forecast` → p_yes + confidence + rationale (or abstain)
   - `evaluate` → fire/no-fire decision based on edge, spread, window, confidence
   - If fire: `placeOrderForSignal` → `logSignal` → `alertSignal`
6. Record run stats in `scan_runs`

A `_running` flag prevents overlapping cycles.

### `services/edgeEvaluator.js` decides what fires

Defaults (all env-tunable):
- `EDGE_MIN_CENTS=8` — minimum edge in cents to fire
- `CONFIDENCE_MIN=0.75` — Sonnet's reported confidence floor
- `MAX_SPREAD_CENTS=20` — skip thinly-traded markets
- `MIN_HOURS_TO_RESOLUTION=24` — no late entries (no time to act)
- `MAX_DAYS_TO_RESOLUTION=180` — no super-long-dated speculation
- `KELLY_FRACTION=0.25` — fractional Kelly for sizing
- `MAX_BET_USD=50` — hard cap regardless of Kelly

These are intentionally conservative. **Tune by widening AFTER you have calibration data, not before.**

### Idempotency

`signals` table has a unique index on `(market_ticker, signal_version, DATE(created_at))`. Running the same scan twice in a day on the same market does NOT double-alert — the INSERT silently no-ops via ON CONFLICT, and `logSignal` returns null which suppresses the Telegram alert.

To force a re-fire, bump `signal_version` (currently default `'v1'` in the schema).

---

## Kalshi API notes

- Base URL: `https://api.elections.kalshi.com/trade-api/v2` (default). Demo is `https://demo-api.kalshi.co/trade-api/v2`.
- Auth: RSA-PSS signature on `timestamp + METHOD + path` using PKCS#1 PEM private key. Headers: `KALSHI-ACCESS-KEY`, `KALSHI-ACCESS-SIGNATURE`, `KALSHI-ACCESS-TIMESTAMP`.
- `GET /markets`, `/events`, `/markets/:ticker`, `/markets/:ticker/orderbook` — **public**, no auth needed. Predator can scan + forecast WITHOUT a Kalshi key. Auth only matters for portfolio + orders.
- Prices are in cents (1–99). Each contract pays $1 if YES resolves true (or NO if NO resolves true).
- `market.status` flow: `unopened` → `open` → `closed` → `settled` → `finalized`. Resolver only acts on `settled` or `finalized`.
- `market.result` is `'yes'` or `'no'` (lowercase) when settled.

---

## Anthropic note

- Classifier: `claude-haiku-4-5-20251001` (cheap, ~$0.001/market). Cached forever per ticker.
- Forecaster: `claude-sonnet-4-6`. ~$0.02–0.05/forecast. Per-cycle cap: `PER_RUN_FORECAST_CAP=25`.
- Both calls return JSON. `services/anthropic.js#extractJSON` handles fenced or unfenced output. If parse fails, fall through gracefully (classifier returns `in_scope=false`, forecaster returns `abstain=true`).

If quota becomes an issue, drop `PER_RUN_FORECAST_CAP` and/or scope the classifier to fewer markets per run.

---

## Going live workflow

1. Run `signals` mode for ≥60 days
2. Verify Brier < 0.22 with ≥30 resolved signals
3. Verify cumulative `pnl_usd` is positive
4. Switch to `paper` for ≥30 days, confirm paper P&L matches signal P&L
5. `TRADING_MODE=live` + `LIVE_TRADING_CONFIRMED=true`, `MAX_BET_USD=10`
6. Raise cap gradually based on continued calibration

There is NO backtester. Forward calibration is the only validation. Most target markets are N=1 one-shot events; backtesting them is theater (look-ahead bias is unfixable when Claude can recall what happened). This was a deliberate design call.

---

## Deployment — Render env vars

The bot ships on Render the same way Twomiah Trader does: GitHub → Render Web Service → env vars in the Render dashboard.

**Required to boot (minimum 6 vars):**

| Key | Value | Notes |
|-----|-------|-------|
| `TRADING_MODE` | `signals` | default mode — read-only + alerts |
| `DATABASE_URL` | Neon Postgres connection string | run `npm run migrate` once |
| `ANTHROPIC_API_KEY` | Anthropic key | Haiku + Sonnet calls |
| `TELEGRAM_BOT_TOKEN` | Telegram BotFather token | port from Twomiah |
| `TELEGRAM_CHAT_ID` | Telegram chat ID | port from Twomiah |
| `NEWSAPI_KEY` | newsapi.org free tier | 100 req/day on free |

**Required for live trading (skip for v1):**

| Key | Value | Notes |
|-----|-------|-------|
| `KALSHI_API_KEY_ID` | from Kalshi Settings → API Keys | only needed for `/portfolio/*` |
| `KALSHI_PRIVATE_KEY` | PEM private key | escape newlines as `\n` in env |
| `LIVE_TRADING_CONFIRMED` | `false` | second gate — set `true` only when ready |

**Optional tuning (defaults shown, all env-tunable without code changes):**

| Key | Default | What it does |
|-----|---------|--------------|
| `EDGE_MIN_CENTS` | `8` | minimum edge in cents to fire signal |
| `CONFIDENCE_MIN` | `0.75` | Sonnet confidence floor |
| `MAX_SPREAD_CENTS` | `20` | skip thinly-traded markets |
| `MIN_HOURS_TO_RESOLUTION` | `24` | no late entries |
| `MAX_DAYS_TO_RESOLUTION` | `180` | no super-long-dated speculation |
| `MAX_BET_USD` | `50` | hard cap regardless of Kelly |
| `KELLY_FRACTION` | `0.25` | fractional Kelly aggressiveness |
| `DISCOVERY_CRON` | `*/30 * * * *` | scan cadence |
| `RESOLVER_CRON` | `15 9 * * *` | daily resolution sweep |
| `DAILY_DIGEST_CRON` | `0 9 * * *` | Telegram morning summary |
| `CLASSIFIER_MODEL` | `claude-haiku-4-5-20251001` | cheap classifier |
| `FORECAST_MODEL` | `claude-sonnet-4-6` | forecaster |
| `KALSHI_API_BASE` | `https://api.elections.kalshi.com/trade-api/v2` | demo: `https://demo-api.kalshi.co/trade-api/v2` |
| `PER_RUN_MARKET_CAP` | `200` | max markets fetched per cycle |
| `PER_RUN_FORECAST_CAP` | `25` | max Sonnet forecasts per cycle (cost guard) |
| `PORT` | Render injects | don't set manually on Render |

**Build/start commands on Render:**
- Build: `npm install`
- Start: `npm start`
- Auto-deploy from `main` branch

**Migration:** after first deploy, open Render shell and run `npm run migrate` once. Or run locally with `DATABASE_URL` in `.env`. Idempotent — safe to re-run.

---

## Common operations

**Trigger an out-of-band scan:**
```bash
curl -X POST http://localhost:3002/signals/scan -H 'Content-Type: application/json' -d '{"dryRun":false}'
```

**Check what the classifier thinks of a market:**
```bash
curl 'http://localhost:3002/classifications?in_scope=true' | jq
```

**See open signals:**
```bash
curl 'http://localhost:3002/signals?status=open' | jq
```

**Force re-classification of a single market** (when you've edited the classifier prompt):
```sql
DELETE FROM market_classifications WHERE market_ticker = 'KXFOO-25APR30';
```

**Force re-fire of a signal** (e.g. testing alerts): bump `signal_version` constant in `migrations/001_init.sql` default and apply via UPDATE, OR insert a manual row.

---

## Known gaps / future work

- **Paper mode doesn't yet write to `paper_positions`** — `broker.js#placeOrderForSignal` returns the action label but doesn't insert the row. Easy fix when paper mode is needed.
- **Sports-arb agent is just a classifier label** — no Vegas-line-vs-Kalshi comparison logic yet. Would need a sportsbook odds API (DraftKings, Pinnacle) and a watcher loop firing on news + line movement.
- **No X/Twitter feed** — deferred (cookie-auth is the same pain it is in Twomiah's `twitterWatcher.js`).
- **No Polymarket** — abstracted via `services/broker.js` chokepoint, but the second client + a unified market model would be the v2 work.
- **Resolver only checks markets one at a time** — fine at low volume but will need batching once the open-signals queue gets large.
- **No order-fill verification in live mode** — once `live_submitted`, we trust the order went through. A reconciliation pass like Twomiah's `reconcileOpenOrders` would close that gap.

---

## Twomiah Trader — what we did and didn't reuse

Reused (in spirit, ported):
- Express + routes/services split
- `db.js` Pool pattern
- `alertService.js` Telegram conventions
- Mode-gated trading (`TRADING_MODE=paper|live` is twomiah's pattern; we added `signals` and a confirmation flag)

NOT reused:
- Multi-agent decision pipeline (regime → strategy gates → research → portfolio → Claude → risk) — overkill for prediction markets, replaced with classifier+forecaster+edge-evaluator
- Backtester subsystem — explicitly skipped (forward calibration only)
- 5-gate momentum strategy — irrelevant for binary outcomes
- Bracket orders + trailing stops — Kalshi doesn't have these primitives anyway
- Watchlist UI — replaced with classification cache as the curation surface

---

## Quick reference

**Add a news source** → new file in `services/feeds/`, then add to `services/feeds/index.js#gatherNewsFor`

**Tune what fires** → env vars: `EDGE_MIN_CENTS`, `CONFIDENCE_MIN`, `MAX_SPREAD_CENTS`, `KELLY_FRACTION`, `MAX_BET_USD`

**Tune what gets classified** → edit `services/marketClassifier.js` SYSTEM prompt

**Tune the forecast** → edit `services/forecastAgent.js` SYSTEM prompt

**Switch Kalshi env** → `KALSHI_API_BASE` in .env (production vs demo)

**Pause everything** → `TRADING_MODE=signals` (default; broker chokepoint short-circuits real orders)
