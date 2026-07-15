'use strict';
const { v4: uuidv4 } = require('uuid');
const { readJSON, writeJSON, withFileLock } = require('../jsonStore');
const { config, TRADE_STATUS } = require('../../config');
const { todayUTC, formatDuration } = require('../../lib/utils');

const FILE = config.paths.trades;

/**
 * Derives the unified display status required by the Trade History feature
 * (ACTIVE / WIN / LOSS / BREAKEVEN / CANCELLED) from the trade's internal
 * open/closed + result fields, without changing how the rest of the engine
 * stores trades. Purely a read-time projection — fully backward compatible.
 */
function deriveStatus(t) {
  if (t.status === 'open') return TRADE_STATUS.ACTIVE;
  if (t.close_reason === 'CANCELLED') return TRADE_STATUS.CANCELLED;
  if (t.result === 'WIN') return TRADE_STATUS.WIN;
  if (t.result === 'LOSS') return TRADE_STATUS.LOSS;
  return TRADE_STATUS.BREAKEVEN;
}

/** Builds the complete Trade History record shape required by requirement 1. */
function toHistoryRecord(t) {
  const roiPct = t.margin_used > 0 ? parseFloat(((t.profit / t.margin_used) * 100).toFixed(2)) : (t.profit_pct || 0);
  return {
    trade_id:       t.trade_id,
    symbol:         t.symbol,
    side:           t.side,
    market_type:    t.market_type,
    entry_price:    t.entry,
    exit_price:     t.close_price,
    quantity:       t.quantity,
    leverage:       t.leverage,
    margin:         t.margin_used,
    stop_loss:      t.sl,
    take_profit:    t.tp,
    open_time:      t.open_time,
    close_time:     t.close_time,
    duration:       formatDuration(t.open_time, t.close_time),
    current_profit: t.status === 'open' ? t.profit : null,
    final_profit:   t.status === 'closed' ? t.profit : null,
    roi_pct:        roiPct,
    status:         deriveStatus(t),
    source:         t.source || (t.imported ? 'manual' : 'bot'),
    score:          t.score || 0,
  };
}

const tradesStore = {
  getAll()         { return readJSON(FILE) || []; },
  findById(id)     { return tradesStore.getAll().find((t) => t.trade_id === id) || null; },
  forUser(uid)     { return tradesStore.getAll().filter((t) => String(t.user_id) === String(uid)); },
  openForUser(uid) { return tradesStore.forUser(uid).filter((t) => t.status === 'open'); },

  deriveStatus,
  toHistoryRecord,

  /** Full trade history for a user, newest first, in the exact shape requirement 1 specifies. */
  historyForUser(uid, limit = 100) {
    return tradesStore.forUser(uid)
      .sort((a, b) => new Date(b.open_time) - new Date(a.open_time))
      .slice(0, limit)
      .map(toHistoryRecord);
  },

  findOpenImported(userId, symbol, marketType, side) {
    return tradesStore.getAll().find((t) =>
      String(t.user_id) === String(userId) &&
      t.symbol === symbol && t.market_type === marketType &&
      t.side === side && t.status === 'open' && t.imported === true
    ) || null;
  },

  findOpenBySymbolSide(userId, symbol, side, marketType) {
    return tradesStore.getAll().find((t) =>
      String(t.user_id) === String(userId) &&
      t.symbol === symbol && t.side === side && t.status === 'open' &&
      (!marketType || t.market_type === marketType)
    ) || null;
  },

  findOpenBySymbol(userId, symbol, marketType) {
    return tradesStore.getAll().find((t) =>
      String(t.user_id) === String(userId) &&
      t.symbol === symbol && t.market_type === marketType && t.status === 'open'
    ) || null;
  },

  /** All currently open trades for a user across both bot-opened and manually-detected trades. */
  allOpenForUser(uid) {
    return tradesStore.openForUser(uid);
  },

  findDuplicates() {
    const all  = tradesStore.getAll().filter((t) => t.status === 'open');
    const seen = new Map();
    const dups = [];
    for (const t of all) {
      const key = `${t.user_id}:${t.symbol}:${t.side}:${t.market_type}`;
      if (seen.has(key)) dups.push(t);
      else seen.set(key, t);
    }
    return dups;
  },

  countBreakeven(uid) {
    const trades = uid ? tradesStore.forUser(uid) : tradesStore.getAll();
    return trades.filter((t) => t.status === 'closed' && t.result === 'BREAKEVEN').length;
  },

  countManual()  { return tradesStore.getAll().filter((t) => t.source === 'manual' || t.imported).length; },
  countBotOpened() { return tradesStore.getAll().filter((t) => !(t.source === 'manual' || t.imported)).length; },

  async create(data) {
    return withFileLock(FILE, () => {
      const trades = readJSON(FILE) || [];

      const dupIdx = trades.findIndex((t) =>
        String(t.user_id) === String(data.user_id) &&
        t.symbol === data.symbol &&
        t.side   === data.side &&
        t.market_type === (data.market_type || 'spot') &&
        t.status === 'open'
      );
      if (dupIdx !== -1) return trades[dupIdx];

      const trade = {
        trade_id:          uuidv4(),
        user_id:           String(data.user_id),
        account_type:      data.account_type || null,
        market_type:       data.market_type || 'spot',
        symbol:            data.symbol,
        side:              data.side,
        entry:             data.entry,
        sl:                data.sl    || null,
        tp:                data.tp    || null,
        quantity:          data.quantity || 0,
        leverage:          data.leverage || 1,
        margin_used:       data.margin_used || 0,
        risk_pct:          data.risk_pct || 1,
        score:             data.score || 0,
        signal_id:         data.signal_id || '',
        order_id:          String(data.order_id || ''),
        sl_order_id:       String(data.sl_order_id || ''),
        tp_order_id:       String(data.tp_order_id || ''),
        position_side:     data.position_side || 'BOTH',
        sl_failed_reason:  data.sl_failed_reason || null,
        tp_failed_reason:  data.tp_failed_reason || null,
        status:            'open',
        imported:          data.imported || false,
        source:            data.imported ? 'manual' : 'bot',
        profit:            0,
        profit_pct:        0,
        result:            null,
        current_price:     data.current_price || data.entry,
        liquidation_price: data.liquidation_price || null,
        open_time:         data.open_time || new Date().toISOString(),
        close_time:        null,
        close_reason:      null,
        close_price:       null,
        notified:          false,
        user_message_ids:  data.user_message_ids || {},
      };
      trades.push(trade);
      writeJSON(FILE, trades);
      return trade;
    });
  },

  async update(id, patch) {
    return withFileLock(FILE, () => {
      const trades = readJSON(FILE) || [];
      const idx    = trades.findIndex((t) => t.trade_id === id);
      if (idx === -1) return null;
      trades[idx] = { ...trades[idx], ...patch };
      writeJSON(FILE, trades);
      return trades[idx];
    });
  },

  async upsertImported(data) {
    return withFileLock(FILE, () => {
      const trades = readJSON(FILE) || [];
      const idx = trades.findIndex((t) =>
        String(t.user_id) === String(data.user_id) &&
        t.symbol === data.symbol && t.market_type === data.market_type &&
        t.side === data.side && t.status === 'open'
      );
      if (idx !== -1) {
        trades[idx] = {
          ...trades[idx],
          current_price:     data.current_price     ?? trades[idx].current_price,
          profit:            data.profit            ?? trades[idx].profit,
          profit_pct:        data.profit_pct        ?? trades[idx].profit_pct,
          quantity:          data.quantity          ?? trades[idx].quantity,
          leverage:          data.leverage          ?? trades[idx].leverage,
          sl:                data.sl                ?? trades[idx].sl,
          tp:                data.tp                ?? trades[idx].tp,
          liquidation_price: data.liquidation_price ?? trades[idx].liquidation_price,
          margin_used:       data.margin_used       ?? trades[idx].margin_used,
          imported:          trades[idx].imported,
        };
        writeJSON(FILE, trades);
        return { trade: trades[idx], created: false };
      }
      const trade = {
        trade_id:          uuidv4(),
        user_id:           String(data.user_id),
        account_type:      data.account_type || null,
        market_type:       data.market_type || 'futures',
        symbol:            data.symbol,
        side:              data.side,
        entry:             data.entry,
        sl:                data.sl || null,
        tp:                data.tp || null,
        quantity:          data.quantity || 0,
        leverage:          data.leverage || 1,
        margin_used:       data.margin_used || 0,
        risk_pct:          data.risk_pct || 0,
        score:             0,
        signal_id:         '',
        order_id:          String(data.order_id || ''),
        sl_order_id:       String(data.sl_order_id || ''),
        tp_order_id:       String(data.tp_order_id || ''),
        position_side:     data.position_side || 'BOTH',
        sl_failed_reason:  null,
        tp_failed_reason:  null,
        status:            'open',
        imported:          true,
        source:            'manual',
        profit:            data.profit || 0,
        profit_pct:        data.profit_pct || 0,
        result:            null,
        current_price:     data.current_price || data.entry,
        liquidation_price: data.liquidation_price || null,
        open_time:         data.open_time || new Date().toISOString(),
        close_time:        null,
        close_reason:      null,
        close_price:       null,
        notified:          false,
        user_message_ids:  {},
      };
      trades.push(trade);
      writeJSON(FILE, trades);
      return { trade, created: true };
    });
  },

  count()       { return tradesStore.getAll().length; },
  countOpen()   { return tradesStore.getAll().filter((t) => t.status === 'open').length; },
  countClosed() { return tradesStore.getAll().filter((t) => t.status === 'closed').length; },
  countWins()   { return tradesStore.getAll().filter((t) => t.result === 'WIN').length; },
  countLosses() { return tradesStore.getAll().filter((t) => t.result === 'LOSS').length; },

  /** Marks an open trade as cancelled (e.g. could not be filled / user aborted before fill). Never used for normal SL/TP closes. */
  async cancel(id, reasonNote = '') {
    return tradesStore.update(id, {
      status: 'closed', result: null, close_reason: 'CANCELLED',
      close_time: new Date().toISOString(), close_price: null, profit: 0, profit_pct: 0,
      cancel_note: reasonNote,
    });
  },

  _statsSince(predicate) {
    const closed = tradesStore.getAll().filter((t) => t.status === 'closed' && predicate(t));
    return {
      total:     closed.length,
      wins:      closed.filter((t) => t.result === 'WIN').length,
      losses:    closed.filter((t) => t.result === 'LOSS').length,
      breakeven: closed.filter((t) => t.result === 'BREAKEVEN').length,
      pnl:       closed.reduce((s, t) => s + (t.profit || 0), 0),
    };
  },

  todayStats() {
    const today = todayUTC();
    return tradesStore._statsSince((t) => t.close_time?.startsWith(today));
  },
  weekStats() {
    const week = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    return tradesStore._statsSince((t) => t.close_time >= week);
  },
  monthStats() {
    const month = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    return tradesStore._statsSince((t) => t.close_time >= month);
  },
  yearStats() {
    const yearStart = new Date(new Date().getFullYear(), 0, 1).toISOString();
    return tradesStore._statsSince((t) => t.close_time >= yearStart);
  },

  todayStatsForUser(uid) {
    const today = todayUTC();
    return tradesStore._statsSince((t) => String(t.user_id) === String(uid) && t.close_time?.startsWith(today));
  },
  weekStatsForUser(uid) {
    const week = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    return tradesStore._statsSince((t) => String(t.user_id) === String(uid) && t.close_time >= week);
  },
  monthStatsForUser(uid) {
    const month = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    return tradesStore._statsSince((t) => String(t.user_id) === String(uid) && t.close_time >= month);
  },

  totalProfit() {
    return tradesStore.getAll().reduce((s, t) => s + (t.profit || 0), 0).toFixed(4);
  },

  /** Most-traded symbol by count, used by the admin statistics dashboard. */
  mostTradedPair() {
    const counts = {};
    for (const t of tradesStore.getAll()) counts[t.symbol] = (counts[t.symbol] || 0) + 1;
    const entries = Object.entries(counts);
    if (!entries.length) return null;
    entries.sort((a, b) => b[1] - a[1]);
    return { symbol: entries[0][0], count: entries[0][1] };
  },

  /** Best/worst performing symbol by total realized PNL. */
  pairPerformance() {
    const pnl = {};
    for (const t of tradesStore.getAll()) {
      if (t.status !== 'closed') continue;
      pnl[t.symbol] = (pnl[t.symbol] || 0) + (t.profit || 0);
    }
    const entries = Object.entries(pnl);
    if (!entries.length) return { best: null, worst: null };
    entries.sort((a, b) => b[1] - a[1]);
    return {
      best:  { symbol: entries[0][0], pnl: parseFloat(entries[0][1].toFixed(4)) },
      worst: { symbol: entries[entries.length - 1][0], pnl: parseFloat(entries[entries.length - 1][1].toFixed(4)) },
    };
  },
};

module.exports = tradesStore;
