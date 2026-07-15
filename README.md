# Telegram Binance Sniper Trading Bot

A professionally refactored Telegram bot for automated Binance trading (Spot + Futures, Testnet + Real), rebuilt from the ground up around a sniper-only strategy, true multi-account switching, and real-time statistics.

## What changed from the original project

1. **Account Switching replaces Change API Key.** Every Telegram user can save up to 4 independent Binance accounts (Testnet Spot, Testnet Futures, Real Spot, Real Futures). Credentials are requested once per slot and saved permanently in `data/accounts.json`; switching accounts reconnects Binance instantly with no bot restart.
2. **Recovery Mode removed entirely.** No recovery commands, buttons, services, scheduler jobs, config, or database fields remain.
3. **Sniper-only strategy.** Every trade requires all 8 confirmations (trend, EMA trend, MACD, RSI, volume, ATR, support/resistance, candle pattern) and a weighted score ≥ 90/100. See `services/signalEngine.js`.
4. **Continuous 24/7 auto-trading.** No cap on concurrent trades, no daily pause. The scheduler scans every 60 seconds and never stops.
5. **Referral system fixed.** The original bug was a missing `db.referrals` store — referrals were tracked nowhere. The new `db/stores/referrals.js` + `services/referralService.js` generate unique codes, log every referral, and are race-condition safe against duplicate rewards (verified by automated tests).
6. **Real-time statistics.** `services/statisticsService.js` pulls live balance/positions/PNL directly from Binance (websocket-first, REST fallback), cached for exactly 3 seconds.
7. **JSON database hardened.** Atomic writes (temp file + rename), automatic timestamped backups before every write, and automatic recovery from the latest valid backup if a file is ever found corrupted. See `db/jsonStore.js`.
8. **Clean architecture.** `telegram/handlers` (presentation), `services/` (trading engine, Binance service, signal engine, account manager, referral service, statistics service), `db/` (database manager + per-entity stores), `scheduler/` (the continuous trading loop), `config/`, `lib/` (logger + utilities).

## Project structure

```
config/             central configuration & constants
lib/                 logger, generic utilities
db/                  JSON database layer (atomic writes, stores per entity)
services/            binanceService, accountManager, signalEngine, tradingEngine,
                      statisticsService, referralService
telegram/            bot.js (composition root), keyboards, handlers/
scheduler/           continuous scan + monitor loops
test/                offline unit/integration tests (no network required)
index.js             entry point
```

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in `BOT_TOKEN` and `ADMIN_CHAT_ID`.
3. `npm start`

Binance API keys are **not** set via environment variables — each user connects their own account(s) from inside the bot via **Switch Account**.

## Testing

Two fully offline test suites (no network access needed) are included:

```
node test/signalEngine.test.js   # indicator math + full sniper signal generation
node test/tradingEngine.test.js  # position sizing, PNL math, full open/monitor/close lifecycle
```

Both are run automatically via `npm test`.

## Deployment

- **Render:** `render.yaml` is included — connect the repo, set `BOT_TOKEN` and `ADMIN_CHAT_ID` as secret env vars, deploy. A persistent disk is configured for `data/` so the JSON database survives restarts.
- **Replit:** `.replit` and `replit.nix` are included — import the repo, set `BOT_TOKEN`/`ADMIN_CHAT_ID` as Replit Secrets, click Run.

## Risk notice

This bot places real trades with real funds when connected to a Real account. Sniper filtering and risk-based position sizing reduce — but never eliminate — trading risk. Always test thoroughly on Testnet first.
