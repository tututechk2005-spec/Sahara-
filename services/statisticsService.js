'use strict';
const db = require('../db');
const logger = require('../lib/logger');
const accountManager = require('./accountManager');
const { createClientFor } = require('./binanceService');
const { STATS_REFRESH_MS, ACCOUNT_TYPE_META } = require('../config');

// ─── SHARED PUBLIC PRICE FEED (websocket, REST fallback) ────────────────────
// One subscription per symbol+market+testnet is shared across every user
// who has that symbol open, instead of one socket per user — this is the
// "reuse connections / reduce API calls" requirement in practice.
const priceCache = new Map();      // `${marketType}:${testnet}:${symbol}` -> { price, ts }
const subscriptions = new Map();   // same key -> { close(), refCount }
const publicClients = new Map();   // `${marketType}:${testnet}` -> client (no API key needed for market data)

function publicClientFor(marketType, testnet) {
  const key = `${marketType}:${testnet}`;
  if (!publicClients.has(key)) publicClients.set(key, createClientFor(marketType, '', '', testnet));
  return publicClients.get(key);
}

function ensureSubscription(marketType, testnet, symbol) {
  const key = `${marketType}:${testnet}:${symbol}`;
  const existing = subscriptions.get(key);
  if (existing) { existing.refCount++; return; }

  const client = publicClientFor(marketType, testnet);
  const handle = client.subscribeMarkPrice(symbol, (msg) => {
    const price = parseFloat(msg.p || msg.c || msg.markPrice);
    if (Number.isFinite(price)) priceCache.set(key, { price, ts: Date.now() });
  });
  subscriptions.set(key, { ...handle, refCount: 1 });
}

function releaseSubscription(marketType, testnet, symbol) {
  const key = `${marketType}:${testnet}:${symbol}`;
  const existing = subscriptions.get(key);
  if (!existing) return;
  existing.refCount--;
  if (existing.refCount <= 0) { try { existing.close(); } catch { /* ignore */ } subscriptions.delete(key); priceCache.delete(key); }
}

/** Live price for a symbol — websocket cache first, REST fallback if stale/missing. */
async function getLivePrice(client, marketType, testnet, symbol) {
  const key = `${marketType}:${testnet}:${symbol}`;
  ensureSubscription(marketType, testnet, symbol);
  const cached = priceCache.get(key);
  if (cached && Date.now() - cached.ts < 5000) return cached.price;
  try {
    const data = await client.getPrice(symbol);
    return parseFloat(data.price);
  } catch (err) {
    logger.debug('[STATS-PRICE-FALLBACK-FAILED]', { symbol, err: err.message });
    return cached ? cached.price : null;
  }
}

// ─── PER-USER STATS CACHE (3s TTL — requirement: refresh every 3 seconds) ───
const statsCache = new Map(); // `${userId}:${accountType}` -> { ts, data }

const statisticsService = {
  /**
   * Returns the user's real-time account statistics. Data is never more
   * than STATS_REFRESH_MS (3s) stale: a fresh value is fetched the first
   * time a request is made after the cache expires, so the bot never
   * hammers Binance on every keystroke yet always reflects near-live data.
   */
  async getLiveStats(userId) {
    const user = db.users.findById(userId);
    if (!user || !user.active_account_type) return { connected: false };

    const accountType = user.active_account_type;
    const cacheKey = `${userId}:${accountType}`;
    const cached = statsCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < STATS_REFRESH_MS) return cached.data;

    const client = accountManager.getActiveClient(userId);
    if (!client) return { connected: false };

    const meta = ACCOUNT_TYPE_META[accountType];
    const account = db.accounts.getAccount(userId, accountType);

    let data;
    try {
      data = await statisticsService._fetchFresh(user, client, meta, account);
    } catch (err) {
      logger.warn('[STATS-FETCH-FAILED]', { user: userId, err: err.message });
      data = cached?.data || { connected: true, error: 'TEMPORARILY_UNAVAILABLE', accountType, label: meta.label };
    }

    statsCache.set(cacheKey, { ts: Date.now(), data });
    return data;
  },

  async _fetchFresh(user, client, meta, account) {
    const userId = user.telegram_id;
    const [balance, openOrders] = await Promise.all([
      client.getBalance(),
      client.getAllOpenOrders(),
    ]);

    const openTrades = db.trades.openForUser(userId).filter((t) => t.account_type === user.active_account_type);

    // Refresh live price/PNL for each open trade (websocket-first).
    let unrealizedTotal = 0;
    for (const t of openTrades) {
      const price = await getLivePrice(client, meta.marketType, meta.testnet, t.symbol);
      if (price) {
        const diff = t.side === 'BUY' ? price - t.entry : t.entry - price;
        const profit = diff * t.quantity;
        const denom  = meta.marketType === 'futures' ? (t.entry * t.quantity) / (t.leverage || 1) : t.entry * t.quantity;
        const profitPct = denom > 0 ? (profit / denom) * 100 : 0;
        unrealizedTotal += profit;
        db.trades.update(t.trade_id, { current_price: price, profit, profit_pct: profitPct }).catch(() => {});
      }
    }

    const todayStats   = db.trades.todayStatsForUser(userId);
    const monthStats   = db.trades.monthStatsForUser(userId);
    const marginUsed   = openTrades.reduce((s, t) => s + (t.margin_used || 0), 0);
    const startingBal  = account?.starting_balance ?? balance.total;
    const roi          = startingBal > 0 ? ((balance.total - startingBal) / startingBal) * 100 : 0;
    const currentSymbol = openTrades.length ? openTrades[openTrades.length - 1].symbol : '—';
    const leverage     = meta.marketType === 'futures'
      ? (openTrades[openTrades.length - 1]?.leverage || require('../config').DEFAULT_LEVERAGE)
      : 1;

    return {
      connected:        true,
      accountType:      user.active_account_type,
      label:            meta.label,
      testnet:          meta.testnet,
      marketType:       meta.marketType,
      balance:          balance.total,
      walletValue:      balance.total + (balance.unrealized_pnl || 0),
      availableBalance: balance.available,
      marginBalance:    balance.margin_balance,
      unrealizedPnl:    meta.marketType === 'futures' ? (balance.unrealized_pnl || 0) : unrealizedTotal,
      openPositions:    openTrades.length,
      openOrders:       openOrders.length,
      roi:              parseFloat(roi.toFixed(2)),
      winRate:          user.win_rate || 0,
      totalTrades:      user.total_trades || 0,
      dailyProfit:      parseFloat((todayStats.pnl || 0).toFixed(4)),
      monthlyProfit:    parseFloat((monthStats.pnl || 0).toFixed(4)),
      currentSymbol,
      leverage,
      marginUsed:       parseFloat(marginUsed.toFixed(4)),
      netPnl:           user.net_pnl || 0,
      fetchedAt:        new Date().toISOString(),
    };
  },

  /** Called when a trade opens/closes so the relevant symbol's price feed is tracked/released. */
  trackSymbol(marketType, testnet, symbol)   { ensureSubscription(marketType, testnet, symbol); },
  untrackSymbol(marketType, testnet, symbol) { releaseSubscription(marketType, testnet, symbol); },

  invalidate(userId, accountType) { statsCache.delete(`${userId}:${accountType}`); },
};

module.exports = statisticsService;
