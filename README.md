# Prediction Predator

AI-driven Kalshi prediction-market signal bot. Sister project to Twomiah Trader, but for binary event markets instead of equities.

**v1 status: signals-only.** The bot watches Kalshi, classifies markets into the lanes you care about (tech / current events / sports-arb), forecasts probabilities with Claude, evaluates edge vs. market price, and fires Telegram alerts when something looks juicy. **No real money goes anywhere by default.** Live trading is wired but gated behind two env flags.

---

## Lanes

| Lane | In scope | Notes |
|------|----------|-------|
| `tech` | ✅ | AI/tech launches, IPOs, stock targets, model releases, app metrics |
| `current_events` | ✅ | Cultural happenings, geopolitics, breaking news, awards, box office |
| `sports_arb` | ✅ (narrow) | Only thin/derivative props — straight game lines vs Vegas are skipped |
| Econ (Fed/CPI/jobs) | ❌ | Out of scope per spec — "rigged" |
| Politics (elections/legislation) | ❌ | Out of scope per spec — "rigged" |
| Weather | ❌ | Skipped for v1 |
| Crypto price targets | ❌ | Skipped for v1 |

The classifier (Claude Haiku) makes the call per market. If it gets one wrong, edit `services/marketClassifier.js` system prompt.

---

## Setup

```bash
cp .env.example .env
# fill in DATABASE_URL, ANTHROPIC_API_KEY, KALSHI_*, TELEGRAM_*, NEWSAPI_KEY
npm install
npm run migrate          # creates tables in your Postgres
npm run dev              # starts on :3002
```

Open http://localhost:3002 for the dashboard.

### Kalshi credentials

1. Log into Kalshi → Settings → API Keys → Create.
2. Save the key ID + the downloaded private key file.
3. In `.env`:
   ```
   KALSHI_API_KEY_ID=<your key id>
   KALSHI_PRIVATE_KEY=<paste the PEM, escape newlines as \n>
   ```
4. Default base is the elections-prod cluster. Switch to `https://demo-api.kalshi.co/trade-api/v2` for sandbox (read-only data, no real account).

The bot can scan and forecast without any Kalshi credentials — `/markets` and `/events` are public endpoints. Credentials are only needed for `/portfolio/*` (balance, positions, place orders).

### Anthropic

- Classifier: `claude-haiku-4-5-20251001` (cheap; 1 call per new market)
- Forecaster: `claude-sonnet-4-6` (one call per in-scope candidate)

Override via `CLASSIFIER_MODEL` / `FORECAST_MODEL` env vars.

### Postgres

Use Neon, Supabase, or local Postgres. Run `npm run migrate` once to create the schema.

---

## Trading modes

```
TRADING_MODE = signals | paper | live
LIVE_TRADING_CONFIRMED = false | true
```

| Mode | What happens | Order chokepoint behavior |
|------|--------------|---------------------------|
| `signals` (default) | Forecast → log signal → Telegram alert | `would_have_bet` — no Kalshi call |
| `paper` | Same, plus a synthetic position is recorded in `paper_positions` | `paper_filled` — no Kalshi call |
| `live` (requires `LIVE_TRADING_CONFIRMED=true`) | Real Kalshi limit order placed | `live_submitted` — calls `kalshiClient.placeOrder` |

Setting `TRADING_MODE=live` without `LIVE_TRADING_CONFIRMED=true` falls back to signals and logs a warning. So flipping one knob isn't enough.

`MAX_BET_USD` caps every order regardless of what Kelly suggests.

---

## How a scan works

1. **Fetch** open markets from Kalshi (paginated, capped at `PER_RUN_MARKET_CAP`)
2. **Filter** by resolution window (between `MIN_HOURS_TO_RESOLUTION` and `MAX_DAYS_TO_RESOLUTION`)
3. **Rank** by liquidity (`volume_24h + open_interest` desc)
4. **Classify** top N with Claude Haiku → in-scope or not. Cached in `market_classifications` so we don't re-classify.
5. **News-bundle** in-scope markets — query NewsAPI (and Hacker News for `tech` lane) for relevant context
6. **Forecast** with Claude Sonnet — outputs `p_yes`, `confidence`, `rationale`. Sonnet is instructed to abstain when news is too thin.
7. **Evaluate** edge: skip if `confidence < 0.75`, `edge < 8¢`, `spread > 20¢`, `resolves < 24h` or `> 180d`.
8. **Size** with fractional Kelly (capped at `MAX_BET_USD`).
9. **Log** to `signals` table (idempotent: same ticker same day = no duplicate).
10. **Broker chokepoint** — `services/broker.js` decides what to do based on `TRADING_MODE`.
11. **Alert** via Telegram.

Scheduled every 30min by default (`DISCOVERY_CRON`). Manual: `POST /signals/scan` or click "Run scan" on the dashboard.

---

## Resolution + calibration

A daily cron (`RESOLVER_CRON=15 9 * * *`) walks all open signals, asks Kalshi if their markets settled, marks outcomes + P&L. Calibration buckets are recomputed after each resolution batch.

The dashboard shows:
- Win rate (% of bets where our side was right)
- Brier score (lower = better-calibrated; 0.25 = coinflip)
- Per-category Brier + P&L

This is the actual validation. **Don't trust the bot until at least ~30 markets have resolved.**

---

## API

| Method | Path | Notes |
|--------|------|-------|
| GET | `/health` | Connectivity + mode |
| GET | `/signals?status=open\|resolved\|all&limit=N` | Signal list |
| GET | `/signals/:id` | Single signal |
| POST | `/signals/scan` body `{ dryRun: bool }` | Trigger out-of-band scan |
| GET | `/markets` | Public Kalshi open-markets passthrough |
| GET | `/markets/:ticker` | Single market |
| GET | `/markets/:ticker/orderbook` | Orderbook depth=5 |
| GET | `/classifications?in_scope=true\|false` | What the classifier decided |
| GET | `/calibration` | Aggregate calibration + Brier |
| GET | `/calibration/by-category` | Per-lane breakdown |
| GET | `/trade/mode` | Effective trading mode |
| GET | `/trade/balance` | Live Kalshi balance (auth required) |
| GET | `/trade/positions` | Live Kalshi positions (auth required) |

---

## Going live (when calibration earns it)

1. Run in `signals` mode for at least 60 days.
2. Verify Brier < 0.22 across at least 30 resolved signals.
3. Verify positive cumulative P&L on the "would-have-bet" math.
4. Set `TRADING_MODE=paper` for another 30 days. Confirm paper P&L tracks would-have-bet.
5. Only then: `TRADING_MODE=live` + `LIVE_TRADING_CONFIRMED=true`. Start with `MAX_BET_USD=10`. Raise gradually.

There is no backtest gate. Forward calibration is the only validation that matters here.

---

## Stack

- Node.js 20+ / Express
- Anthropic SDK (Haiku + Sonnet)
- Kalshi REST API v2 (RSA-PSS signed requests)
- Postgres (Neon-friendly)
- node-cron for scheduling
- NewsAPI + Hacker News Algolia search (free)
- Telegram Bot API for alerts
