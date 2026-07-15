'use strict';
const db = require('../db');
const logger = require('../lib/logger');
const accountManager = require('./accountManager');
const botLogger = require('./botLogger');
const { formatBinanceErrorDiagnostic } = require('./binanceService');
const { fmtNum } = require('../lib/utils');
const {
  RISK_ELITE, RISK_SNIPER, DEFAULT_LEVERAGE,
} = require('../config');

// ─── EXCHANGE FILTER CACHE (stepSize / minNotional / minQty) ─────────────────
const filterCache = new Map(); // `${marketType}:${testnet}` -> { ts, bySymbol }
const FILTER_TTL_MS = 6 * 60 * 60 * 1000;

async function getSymbolFilters(client, symbol) {
  const cacheKey = `${client.marketType}:${client.testnet}`;
  let cached = filterCache.get(cacheKey);
  if (!cached || Date.now() - cached.ts > FILTER_TTL_MS) {
    const info = await client.getExchangeInfo();
    const bySymbol = {};
    for (const s of info.symbols || []) {
      const lot   = (s.filters || []).find((f) => f.filterType === 'LOT_SIZE');
      const notl  = (s.filters || []).find((f) => f.filterType === 'MIN_NOTIONAL' || f.filterType === 'NOTIONAL');
      const price = (s.filters || []).find((f) => f.filterType === 'PRICE_FILTER');
      bySymbol[s.symbol] = {
        stepSize: parseFloat(lot?.stepSize || '0.00000001'),
        minQty:   parseFloat(lot?.minQty   || '0'),
        minNotional: parseFloat(notl?.minNotional || notl?.notional || '0'),
        tickSize:      parseFloat(price?.tickSize || '0.00000001'),
        pricePrecision: typeof s.pricePrecision === 'number' ? s.pricePrecision : null,
        quantityPrecision: typeof s.quantityPrecision === 'number' ? s.quantityPrecision : null,
      };
    }
    cached = { ts: Date.now(), bySymbol };
    filterCache.set(cacheKey, cached);
  }
  return cached.bySymbol[symbol] || { stepSize: 0.00000001, minQty: 0, minNotional: 0, tickSize: 0.00000001, pricePrecision: null, quantityPrecision: null };
}

/** Rounds a price to the symbol's tick size — required so stopPrice/takeProfit never get rejected for excess precision. */
function roundPriceToTick(price, tickSize, pricePrecision) {
  if (pricePrecision !== null && pricePrecision !== undefined) {
    return parseFloat(price.toFixed(pricePrecision));
  }
  if (!tickSize) return price;
  const precision = Math.max(0, Math.round(-Math.log10(tickSize)));
  const rounded = Math.round(price / tickSize) * tickSize;
  return parseFloat(rounded.toFixed(precision));
}

function roundToStep(qty, stepSize) {
  if (!stepSize) return qty;
  const precision = Math.max(0, Math.round(-Math.log10(stepSize)));
  const rounded = Math.floor(qty / stepSize) * stepSize;
  return parseFloat(rounded.toFixed(precision));
}

/**
 * Pure position-sizing function — fully unit-testable without any network.
 * Risk-based sizing: risk a fixed % of available balance on each trade,
 * sized by the distance to stop loss (spot) or by leverage (futures).
 */
function computeQuantity({ marketType, available, entry, sl, grade, leverage = DEFAULT_LEVERAGE, stepSize, minQty }) {
  const riskPct  = grade === 'ELITE_SNIPER' ? RISK_ELITE : RISK_SNIPER;
  const riskAmt  = available * (riskPct / 100);
  let qty;
  let marginUsed;

  if (marketType === 'futures') {
    marginUsed = riskAmt;
    qty = (marginUsed * leverage) / entry;
  } else {
    const slDistance = Math.abs(entry - sl);
    qty = slDistance > 0 ? riskAmt / slDistance : 0;
    // never let the notional exceed the available balance on spot
    const notional = qty * entry;
    if (notional > available) qty = available / entry;
    marginUsed = qty * entry;
  }

  qty = roundToStep(qty, stepSize);
  if (qty < minQty) qty = 0;
  return { quantity: qty, marginUsed, riskPct, riskAmt };
}

function calcPnl({ marketType, side, entry, exit, quantity, leverage = 1 }) {
  const diff = side === 'BUY' ? exit - entry : entry - exit;
  const profit = marketType === 'futures' ? diff * quantity : diff * quantity;
  const denom  = marketType === 'futures' ? (entry * quantity) / leverage : entry * quantity;
  const profitPct = denom > 0 ? (profit / denom) * 100 : 0;
  return { profit, profitPct };
}

function resultFor(profit) {
  if (Math.abs(profit) < 1e-9) return 'BREAKEVEN';
  return profit > 0 ? 'WIN' : 'LOSS';
}

// ─── TRADE LIFECYCLE ───────────────────────────────────────────────────────────
const tradingEngine = {
  computeQuantity,
  calcPnl,
  roundToStep,
  roundPriceToTick,
  getSymbolFilters,

  /**
   * Opens a new trade on the user's CURRENTLY ACTIVE account. There is
   * intentionally no cap on concurrent open trades — every qualifying
   * sniper signal is actioned immediately, per project requirements.
   */
  async openTrade(user, signal) {
    const userId = user.telegram_id;
    const client = accountManager.getActiveClient(userId);
    if (!client) return { opened: false, reason: 'NO_ACTIVE_ACCOUNT' };

    const accountType = user.active_account_type;
    const { marketType } = accountManager.ACCOUNT_TYPE_META[accountType];

    // never duplicate an already-open position for this exact symbol+side+market
    const existing = db.trades.findOpenBySymbolSide(userId, signal.symbol, signal.signal, marketType);
    if (existing) return { opened: false, reason: 'ALREADY_OPEN' };

    let balance;
    try { balance = await client.getBalance(); }
    catch (err) { await tradingEngine._logApiError(user, accountType, marketType, err); return { opened: false, reason: 'BALANCE_FETCH_FAILED', error: err.message }; }

    if (!balance.available || balance.available <= 0) return { opened: false, reason: 'NO_BALANCE' };

    let filters;
    try { filters = await getSymbolFilters(client, signal.symbol); }
    catch (err) { return { opened: false, reason: 'FILTERS_FETCH_FAILED', error: err.message }; }

    const leverage = marketType === 'futures' ? DEFAULT_LEVERAGE : 1;
    const { quantity, marginUsed, riskPct } = computeQuantity({
      marketType, available: balance.available, entry: signal.entry, sl: signal.sl,
      grade: signal.grade, leverage, stepSize: filters.stepSize, minQty: filters.minQty,
    });

    if (!quantity || quantity <= 0) return { opened: false, reason: 'QTY_TOO_SMALL' };
    if (quantity * signal.entry < filters.minNotional) return { opened: false, reason: 'BELOW_MIN_NOTIONAL' };

    try {
      let orderId, slOrderId = '', tpOrderId = '';
      let slFailedReason = null, tpFailedReason = null;
      let entryPositionSide = 'BOTH';

      if (marketType === 'futures') {
        try { await client.setLeverage(signal.symbol, leverage); } catch { /* non-fatal */ }

        const hedgeMode = await client.getPositionMode().catch(() => false);
        entryPositionSide = hedgeMode ? (signal.signal === 'BUY' ? 'LONG' : 'SHORT') : 'BOTH';

        const order = await client.placeMarketOrder(signal.symbol, signal.signal, quantity, entryPositionSide);
        orderId = order.orderId;

        const protectionResult = await tradingEngine._placeFuturesProtection({
          client, symbol: signal.symbol, entrySide: signal.signal, hedgeMode,
          positionSide: entryPositionSide, sl: signal.sl, tp: signal.tp, filters,
          userId, accountType, username: user.username,
        });
        slOrderId = protectionResult.slOrderId;
        tpOrderId = protectionResult.tpOrderId;
        slFailedReason = protectionResult.slFailedReason;
        tpFailedReason = protectionResult.tpFailedReason;
      } else {
        const order = await client.placeMarketOrder(signal.symbol, signal.signal, quantity);
        orderId = order.orderId;
        // Spot has no native bracket order tied to a market buy — SL/TP are
        // tracked on the trade record and enforced by the monitor loop.
      }

      const trade = await db.trades.create({
        user_id: userId, account_type: accountType, market_type: marketType,
        symbol: signal.symbol, side: signal.signal, entry: signal.entry,
        sl: signal.sl, tp: signal.tp, quantity, leverage, margin_used: marginUsed,
        risk_pct: riskPct, score: signal.score, signal_id: signal.signal_id || '',
        order_id: orderId, sl_order_id: slOrderId, tp_order_id: tpOrderId,
        position_side: entryPositionSide, sl_failed_reason: slFailedReason, tp_failed_reason: tpFailedReason,
      });

      await db.users.update(userId, {
        total_trades: (user.total_trades || 0) + 1,
        active_trades: (user.active_trades || 0) + 1,
        [marketType === 'futures' ? 'futures_trades' : 'spot_trades']:
          (user[marketType === 'futures' ? 'futures_trades' : 'spot_trades'] || 0) + 1,
      });

      logger.info(`[TRADE-OPENED] user:${userId} ${signal.symbol} ${signal.signal} qty:${quantity} entry:${signal.entry} (${accountType})`);
      botLogger.tradeOpened(userId, signal.symbol, signal.signal);
      return { opened: true, trade };
    } catch (err) {
      await tradingEngine._logApiError(user, accountType, marketType, err);
      logger.error('[TRADE-OPEN-FAILED]', { user: userId, symbol: signal.symbol, err: err.message });
      return { opened: false, reason: 'ORDER_FAILED', error: err.message };
    }
  },

  /**
   * Places (or repairs) Stop Loss + Take Profit for a Futures position
   * immediately after the entry market order fills, following Binance's
   * official Futures API spec exactly:
   *
   *   - STOP_MARKET / TAKE_PROFIT_MARKET sent to the standard
   *     /fapi/v1/order endpoint (NOT the Algo Order API).
   *   - closePosition=true, with NO quantity and NO reduceOnly — mixing
   *     those was the original bug ("Order type not supported for this
   *     endpoint... use the Algo Order API instead").
   *   - workingType=MARK_PRICE so wicks on the last-traded price can't
   *     prematurely trigger the stop.
   *   - positionSide is 'LONG'/'SHORT' in Hedge Mode (auto-detected) or
   *     omitted/'BOTH' in One-Way Mode.
   *   - stopPrice rounded to the symbol's exact price precision/tick size.
   *
   * Validates the position is actually open and the prices make sense
   * relative to the live mark price before sending anything. If a SL or TP
   * order already exists for this symbol+positionSide, it is cancelled and
   * replaced rather than duplicated. Failures are captured with full
   * diagnostic detail (endpoint, payload, Binance code/message/response)
   * and returned to the caller instead of being silently swallowed.
   */
  async _placeFuturesProtection({ client, symbol, entrySide, hedgeMode, positionSide, sl, tp, filters, userId, accountType, username }) {
    const closeSide = entrySide === 'BUY' ? 'SELL' : 'BUY';
    const result = { slOrderId: '', tpOrderId: '', slFailedReason: null, tpFailedReason: null };

    // ── Validation ────────────────────────────────────────────────────────
    if (!client) { result.slFailedReason = result.tpFailedReason = 'NO_CLIENT'; return result; }
    if (!filters || (!filters.tickSize && filters.pricePrecision === null)) {
      logger.warn('[SL-TP-VALIDATION] Missing symbol price filters, attempting with raw values', { symbol });
    }

    // Confirm the position actually exists before placing protection orders
    // (allow a short settle delay — the fill can lag positionRisk by a beat).
    let positionConfirmed = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const positions = await client.getPositionBySymbol(symbol);
        const pos = Array.isArray(positions) ? positions.find((p) => p.symbol === symbol) : null;
        if (pos && Math.abs(parseFloat(pos.positionAmt)) > 0) { positionConfirmed = true; break; }
      } catch { /* fall through to retry */ }
      await new Promise((r) => setTimeout(r, 350));
    }
    if (!positionConfirmed) {
      logger.warn('[SL-TP-VALIDATION] Position not yet confirmed open — placing protection orders anyway (closePosition orders are valid standing orders independent of current fill state)', { symbol });
    }

    const slPrice = roundPriceToTick(sl, filters?.tickSize, filters?.pricePrecision);
    const tpPrice = roundPriceToTick(tp, filters?.tickSize, filters?.pricePrecision);
    if (!Number.isFinite(slPrice) || slPrice <= 0) { result.slFailedReason = 'INVALID_SL_PRICE'; }
    if (!Number.isFinite(tpPrice) || tpPrice <= 0) { result.tpFailedReason = 'INVALID_TP_PRICE'; }

    const protectionPositionSide = hedgeMode ? positionSide : 'BOTH';

    // ── Duplicate detection: cancel any existing SL/TP for this symbol+side before creating a new one ──
    let existingOrders = [];
    try { existingOrders = await client.getOpenOrders(symbol); } catch { /* best effort */ }
    const matchesSide = (o) => !hedgeMode || o.positionSide === protectionPositionSide;
    const existingSl = existingOrders.find((o) => o.type === 'STOP_MARKET' && matchesSide(o));
    const existingTp = existingOrders.find((o) => o.type === 'TAKE_PROFIT_MARKET' && matchesSide(o));
    if (existingSl) { try { await client.cancelOrder(symbol, existingSl.orderId); } catch { /* may have already filled */ } }
    if (existingTp) { try { await client.cancelOrder(symbol, existingTp.orderId); } catch { /* may have already filled */ } }

    // ── Place Stop Loss ──────────────────────────────────────────────────
    if (!result.slFailedReason) {
      try {
        const slOrder = await client.placeStopOrder(symbol, closeSide, slPrice, { positionSide: protectionPositionSide, closePosition: true });
        result.slOrderId = slOrder.orderId;
        logger.info(`[SL-ORDER-PLACED] ${symbol} stopPrice:${slPrice} positionSide:${protectionPositionSide}`, { user: userId });
      } catch (err) {
        result.slFailedReason = err.binanceMsg || err.message;
        logger.error(`SL ORDER FAILED\n\n${formatBinanceErrorDiagnostic(err)}`, { symbol, user: userId, accountType });
        await db.apiErrors.log({
          user_id: userId, username, account_type: accountType, market_type: 'futures',
          error_code: err.binanceCode, error_message: 'SL order failed: ' + (err.binanceMsg || err.message),
          binance_code: err.binanceCode, binance_msg: err.binanceMsg,
        });
      }
    }

    // ── Place Take Profit ────────────────────────────────────────────────
    if (!result.tpFailedReason) {
      try {
        const tpOrder = await client.placeTakeProfitOrder(symbol, closeSide, tpPrice, { positionSide: protectionPositionSide, closePosition: true });
        result.tpOrderId = tpOrder.orderId;
        logger.info(`[TP-ORDER-PLACED] ${symbol} stopPrice:${tpPrice} positionSide:${protectionPositionSide}`, { user: userId });
      } catch (err) {
        result.tpFailedReason = err.binanceMsg || err.message;
        logger.error(`TP ORDER FAILED\n\n${formatBinanceErrorDiagnostic(err)}`, { symbol, user: userId, accountType });
        await db.apiErrors.log({
          user_id: userId, username, account_type: accountType, market_type: 'futures',
          error_code: err.binanceCode, error_message: 'TP order failed: ' + (err.binanceMsg || err.message),
          binance_code: err.binanceCode, binance_msg: err.binanceMsg,
        });
      }
    }

    return result;
  },

  /** Closes an open trade with a market order on the opposite side, then records the realized result. */
  async closeTrade(trade, reason = 'MANUAL', explicitClosePrice = null) {
    const client = accountManager.getClientForType(trade.user_id, trade.account_type);
    if (!client) return { closed: false, reason: 'NO_CLIENT' };

    const closeSide = trade.side === 'BUY' ? 'SELL' : 'BUY';
    let closePrice = explicitClosePrice;

    try {
      if (trade.market_type === 'futures') {
        for (const id of [trade.sl_order_id, trade.tp_order_id]) {
          if (id) { try { await client.cancelOrder(trade.symbol, id); } catch { /* already filled/cancelled */ } }
        }
      }
      if (!closePrice) {
        const closePositionSide = trade.position_side && trade.position_side !== 'BOTH' ? trade.position_side : 'BOTH';
        try { await client.placeMarketOrder(trade.symbol, closeSide, trade.quantity, closePositionSide); } catch (err) {
          if (!String(err.message).toLowerCase().includes('reduce')) throw err;
        }
        const priceData = await client.getPrice(trade.symbol);
        closePrice = parseFloat(priceData.price);
      }
    } catch (err) {
      logger.error('[TRADE-CLOSE-FAILED]', { trade: trade.trade_id, err: err.message });
      return { closed: false, reason: 'CLOSE_ORDER_FAILED', error: err.message };
    }

    const { profit, profitPct } = calcPnl({
      marketType: trade.market_type, side: trade.side, entry: trade.entry,
      exit: closePrice, quantity: trade.quantity, leverage: trade.leverage,
    });
    const result = resultFor(profit);

    const updated = await db.trades.update(trade.trade_id, {
      status: 'closed', close_time: new Date().toISOString(), close_reason: reason,
      close_price: closePrice, profit, profit_pct: profitPct, result,
    });

    await tradingEngine._applyResultToUser(trade.user_id, profit, result);
    logger.info(`[TRADE-CLOSED] ${trade.symbol} ${trade.side} ${result} ${fmtNum(profit, 4)} (${reason})`);
    return { closed: true, trade: updated, profit, result };
    botLogger.tradeClosed(trade.user_id, trade.symbol, result, profit);
    if (result === 'LOSS')      botLogger.stopLossHit(trade.user_id, trade.symbol);
    if (result === 'WIN' && reason === 'TP_HIT') botLogger.takeProfitHit(trade.user_id, trade.symbol);
    if (trade.signal_id) db.signals.markClosed(trade.signal_id).catch(() => {});
  },

  async _applyResultToUser(userId, profit, result) {
    const user = db.users.findById(userId);
    if (!user) return;
    await db.users.resetDailyIfNeeded(userId);
    const fresh = db.users.findById(userId);

    const wins   = fresh.wins   + (result === 'WIN' ? 1 : 0);
    const losses = fresh.losses + (result === 'LOSS' ? 1 : 0);
    const totalClosed = wins + losses + fresh.breakeven + (result === 'BREAKEVEN' ? 1 : 0);

    await db.users.update(userId, {
      wins, losses,
      breakeven: fresh.breakeven + (result === 'BREAKEVEN' ? 1 : 0),
      consecutive_wins:   result === 'WIN'  ? fresh.consecutive_wins + 1 : 0,
      consecutive_losses: result === 'LOSS' ? fresh.consecutive_losses + 1 : 0,
      net_pnl:      fresh.net_pnl + profit,
      total_profit: fresh.total_profit + (profit > 0 ? profit : 0),
      total_loss:   fresh.total_loss   + (profit < 0 ? Math.abs(profit) : 0),
      win_rate:     totalClosed > 0 ? parseFloat(((wins / totalClosed) * 100).toFixed(2)) : 0,
      avg_win:      wins   > 0 ? parseFloat(((fresh.total_profit + (profit > 0 ? profit : 0)) / wins).toFixed(4))   : 0,
      avg_loss:     losses > 0 ? parseFloat(((fresh.total_loss   + (profit < 0 ? Math.abs(profit) : 0)) / losses).toFixed(4)) : 0,
      active_trades: Math.max(0, (fresh.active_trades || 0) - 1),
      daily_wins:    fresh.daily_wins   + (result === 'WIN'  ? 1 : 0),
      daily_losses:  fresh.daily_losses + (result === 'LOSS' ? 1 : 0),
    });
  },

  async _logApiError(user, accountType, marketType, err) {
    try {
      await db.apiErrors.log({
        user_id: user.telegram_id, username: user.username, account_type: accountType,
        market_type: marketType, error_message: err.message,
        binance_code: err.binanceCode, binance_msg: err.binanceMsg,
      });
    } catch { /* never let error logging itself throw */ }
  },

  /**
   * Manual trade management — used by the dashboard "Manage Trade" menu.
   */
  async moveStopLoss(trade, newSl) {
    if (trade.market_type !== 'futures') return db.trades.update(trade.trade_id, { sl: newSl });
    const client = accountManager.getClientForType(trade.user_id, trade.account_type);
    if (!client) return null;
    const closeSide = trade.side === 'BUY' ? 'SELL' : 'BUY';
    if (trade.sl_order_id) { try { await client.cancelOrder(trade.symbol, trade.sl_order_id); } catch { /* may have already filled */ } }
    try {
      const filters = await getSymbolFilters(client, trade.symbol).catch(() => null);
      const slPrice = roundPriceToTick(newSl, filters?.tickSize, filters?.pricePrecision);
      const positionSide = trade.position_side && trade.position_side !== 'BOTH' ? trade.position_side : 'BOTH';
      const order = await client.placeStopOrder(trade.symbol, closeSide, slPrice, { positionSide, closePosition: true });
      return db.trades.update(trade.trade_id, { sl: slPrice, sl_order_id: order.orderId, sl_failed_reason: null });
    } catch (err) {
      logger.error(`SL ORDER FAILED (move)\n\n${formatBinanceErrorDiagnostic(err)}`, { trade: trade.trade_id });
      return db.trades.update(trade.trade_id, { sl: newSl, sl_failed_reason: err.binanceMsg || err.message });
    }
  },

  async moveTakeProfit(trade, newTp) {
    if (trade.market_type !== 'futures') return db.trades.update(trade.trade_id, { tp: newTp });
    const client = accountManager.getClientForType(trade.user_id, trade.account_type);
    if (!client) return null;
    const closeSide = trade.side === 'BUY' ? 'SELL' : 'BUY';
    if (trade.tp_order_id) { try { await client.cancelOrder(trade.symbol, trade.tp_order_id); } catch { /* may have already filled */ } }
    try {
      const filters = await getSymbolFilters(client, trade.symbol).catch(() => null);
      const tpPrice = roundPriceToTick(newTp, filters?.tickSize, filters?.pricePrecision);
      const positionSide = trade.position_side && trade.position_side !== 'BOTH' ? trade.position_side : 'BOTH';
      const order = await client.placeTakeProfitOrder(trade.symbol, closeSide, tpPrice, { positionSide, closePosition: true });
      return db.trades.update(trade.trade_id, { tp: tpPrice, tp_order_id: order.orderId, tp_failed_reason: null });
    } catch (err) {
      logger.error(`TP ORDER FAILED (move)\n\n${formatBinanceErrorDiagnostic(err)}`, { trade: trade.trade_id });
      return db.trades.update(trade.trade_id, { tp: newTp, tp_failed_reason: err.binanceMsg || err.message });
    }
  },

  async closePartial(trade, fraction) {
    const client = accountManager.getClientForType(trade.user_id, trade.account_type);
    if (!client) return { closed: false, reason: 'NO_CLIENT' };
    const closeSide = trade.side === 'BUY' ? 'SELL' : 'BUY';
    const closePositionSide = trade.position_side && trade.position_side !== 'BOTH' ? trade.position_side : 'BOTH';
    const qty = trade.quantity * fraction;
    try {
      await client.placeMarketOrder(trade.symbol, closeSide, qty, closePositionSide);
      const priceData = await client.getPrice(trade.symbol);
      const closePrice = parseFloat(priceData.price);
      const { profit } = calcPnl({ marketType: trade.market_type, side: trade.side, entry: trade.entry, exit: closePrice, quantity: qty, leverage: trade.leverage });
      await tradingEngine._applyResultToUser(trade.user_id, profit, resultFor(profit));
      const remaining = trade.quantity - qty;
      if (remaining <= 0) {
        await db.trades.update(trade.trade_id, { status: 'closed', close_time: new Date().toISOString(), close_reason: 'PARTIAL_FULL', close_price: closePrice, profit, result: resultFor(profit) });
      } else {
        await db.trades.update(trade.trade_id, { quantity: remaining });
      }
      return { closed: true, profit, remaining };
    } catch (err) {
      logger.warn('[PARTIAL-CLOSE-FAILED]', { trade: trade.trade_id, err: err.message });
      return { closed: false, reason: 'ORDER_FAILED', error: err.message };
    }
  },

  /**
   * Monitor loop — checks every open trade across every account a user has,
   * updates live PnL, and closes anything that has hit its SL/TP (spot has
   * no native bracket order, so this loop enforces it manually). Runs
   * continuously; a failure on one trade never stops the others.
   */
  async monitorOpenTrades() {
    const openTrades = db.trades.getAll().filter((t) => t.status === 'open');
    for (const trade of openTrades) {
      try { await tradingEngine._monitorOne(trade); }
      catch (err) { logger.error('[MONITOR-ERROR]', { trade: trade.trade_id, err: err.message }); }
    }
  },

  async _monitorOne(trade) {
    const client = accountManager.getClientForType(trade.user_id, trade.account_type);
    if (!client) return; // account disconnected — left open, will resume once reconnected

    let price;
    try {
      const data = await client.getPrice(trade.symbol);
      price = parseFloat(data.price);
    } catch (err) { logger.debug('[MONITOR-PRICE-FAILED]', { symbol: trade.symbol, err: err.message }); return; }

    const { profit, profitPct } = calcPnl({ marketType: trade.market_type, side: trade.side, entry: trade.entry, exit: price, quantity: trade.quantity, leverage: trade.leverage });
    await db.trades.update(trade.trade_id, { current_price: price, profit, profit_pct: profitPct });

    if (trade.market_type === 'futures') {
      // Futures SL/TP are real exchange orders — detect if the position itself disappeared (order filled).
      const positions = await client.getOpenPositions().catch(() => null);
      if (positions !== null) {
        const stillOpen = positions.find((p) => p.symbol === trade.symbol);
        if (!stillOpen) {
          const exitPrice = await tradingEngine._estimateFuturesExit(client, trade) ?? price;
          await tradingEngine.closeTrade(trade, 'SL_TP_FILLED', exitPrice);
        }
      }
      return;
    }

    // Spot: enforce SL/TP manually since there is no bracket order on the buy.
    const hitTp = trade.side === 'BUY' ? price >= trade.tp : price <= trade.tp;
    const hitSl = trade.side === 'BUY' ? price <= trade.sl : price >= trade.sl;
    if (hitTp) await tradingEngine.closeTrade(trade, 'TP_HIT', price);
    else if (hitSl) await tradingEngine.closeTrade(trade, 'SL_HIT', price);
  },

  async _estimateFuturesExit(client, trade) {
    try {
      const closeSide = trade.side === 'BUY' ? 'SELL' : 'BUY';
      const exit = await client.getActualFillPrice(trade.symbol, trade.open_time, closeSide);
      return exit;
    } catch { return null; }
  },
};

module.exports = tradingEngine;
