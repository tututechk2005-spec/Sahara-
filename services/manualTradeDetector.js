'use strict';
const db          = require('../db');
const logger      = require('../lib/logger');
const botLogger   = require('./botLogger');
const accountManager = require('./accountManager');
const { ACCOUNT_TYPE_META } = require('../config');
const { calcPnl } = require('./tradingEngine');

/**
 * Requirement 2 — Detect Manual Trades.
 *
 * For every user who has auto_trading enabled and an active account connected,
 * we poll the Binance API for:
 *  - Open positions (futures)  /  open orders (spot)
 *  - Closed orders from the last scan window
 *
 * Any position/order not already tracked in our DB is automatically imported,
 * shown in Active Trades, monitored for TP/SL, and closed normally.
 * Manual and bot trades appear together in every view.
 */

/** Returns a deduplication key unique per open position so we never double-import. */
function posKey(userId, symbol, side, marketType) {
  return `${userId}:${symbol}:${side}:${marketType}`;
}

async function syncFuturesPositions(user, client, accountType) {
  const meta = ACCOUNT_TYPE_META[accountType];
  let positions;
  try { positions = await client.getOpenPositions(); }
  catch (err) {
    logger.debug('[MANUAL-DETECT-FUTURES-ERR]', { user: user.telegram_id, err: err.message });
    return;
  }

  for (const pos of positions) {
    const side = pos.side; // BUY or SELL
    const existing = db.trades.findOpenBySymbolSide(user.telegram_id, pos.symbol, side, 'futures');
    if (existing) {
      // Already tracked — just refresh live data.
      await db.trades.update(existing.trade_id, {
        current_price:     pos.current_price,
        profit:            pos.profit,
        profit_pct:        pos.profit_pct,
        quantity:          pos.quantity,
        leverage:          pos.leverage,
        liquidation_price: pos.liquidation_price,
        margin_used:       pos.margin_used,
      });
      continue;
    }

    // Brand new manual position — import it.
    const { trade, created } = await db.trades.upsertImported({
      user_id:      user.telegram_id,
      account_type: accountType,
      market_type:  'futures',
      symbol:       pos.symbol,
      side,
      entry:        pos.entry,
      current_price: pos.current_price,
      quantity:     pos.quantity,
      leverage:     pos.leverage,
      margin_used:  pos.margin_used,
      profit:       pos.profit,
      profit_pct:   pos.profit_pct,
      liquidation_price: pos.liquidation_price,
      open_time:    new Date(pos.open_time).toISOString(),
      imported:     true,
      source:       'manual',
    });

    if (created) {
      botLogger.manualTradeDetected(user.telegram_id, pos.symbol);
      try {
        await require('../telegram/botInstance').notifyUser(
          user.telegram_id,
          `🔍 *Manual trade detected!*\n\n${pos.side === 'BUY' ? '🟢' : '🔴'} *${pos.symbol}* ${pos.side} (Futures)\n` +
          `Entry: ${pos.entry}\nQuantity: ${pos.quantity}\nLeverage: ${pos.leverage}x\n\n_Imported automatically — now tracked alongside bot trades._`,
        );
      } catch { /* best-effort notify */ }
    }
  }
}

async function syncSpotOrders(user, client, accountType) {
  let orders;
  try { orders = await client.getAllOpenOrders(); }
  catch (err) {
    logger.debug('[MANUAL-DETECT-SPOT-ERR]', { user: user.telegram_id, err: err.message });
    return;
  }

  // For spot we only import filled/partially-filled MARKET buys that look like open positions.
  // Open LIMIT orders that haven't been filled yet are not positions — skip them.
  for (const o of orders) {
    if (o.status !== 'FILLED' && o.status !== 'PARTIALLY_FILLED') continue;
    const side = o.side;
    const symbol = o.symbol;
    const existing = db.trades.findOpenBySymbolSide(user.telegram_id, symbol, side, 'spot');
    if (existing) continue;

    let price;
    try {
      const pd = await client.getPrice(symbol);
      price = parseFloat(pd.price);
    } catch { price = parseFloat(o.price || 0); }

    const entry = parseFloat(o.cummulativeQuoteQty || 0) / parseFloat(o.executedQty || 1);
    const qty   = parseFloat(o.executedQty || 0);
    if (!qty || !entry) continue;

    const { trade, created } = await db.trades.upsertImported({
      user_id:       user.telegram_id,
      account_type:  accountType,
      market_type:   'spot',
      symbol,
      side,
      entry,
      current_price: price,
      quantity:      qty,
      leverage:      1,
      margin_used:   entry * qty,
      profit:        (price - entry) * qty * (side === 'BUY' ? 1 : -1),
      open_time:     new Date(o.time || Date.now()).toISOString(),
      order_id:      String(o.orderId),
      imported:      true,
      source:        'manual',
    });

    if (created) {
      botLogger.manualTradeDetected(user.telegram_id, symbol);
      try {
        await require('../telegram/botInstance').notifyUser(
          user.telegram_id,
          `🔍 *Manual trade detected!*\n\n${side === 'BUY' ? '🟢' : '🔴'} *${symbol}* ${side} (Spot)\nEntry: ${entry.toFixed(6)}\nQty: ${qty}\n\n_Imported automatically._`,
        );
      } catch { /* best-effort */ }
    }
  }
}

const manualTradeDetector = {
  /** Called every monitoring cycle (every 60s) for every connected user. */
  async run() {
    const users = db.users.getAll().filter((u) => u.active_account_type && !u.banned);
    for (const user of users) {
      try {
        const client = accountManager.getActiveClient(user.telegram_id);
        if (!client) continue;
        const meta = ACCOUNT_TYPE_META[user.active_account_type];
        if (meta.marketType === 'futures') {
          await syncFuturesPositions(user, client, user.active_account_type);
        } else {
          await syncSpotOrders(user, client, user.active_account_type);
        }
      } catch (err) {
        logger.debug('[MANUAL-DETECT-RUN-ERR]', { user: user.telegram_id, err: err.message });
      }
    }
  },
};

module.exports = manualTradeDetector;
