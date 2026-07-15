'use strict';
const crypto = require('crypto');
const https  = require('https');
const WebSocket = require('ws');
const logger = require('../lib/logger');
const { retryWithBackoff } = require('../lib/utils');
const {
  BINANCE_SPOT_URL, BINANCE_FUTURES_URL,
  BINANCE_SPOT_TESTNET_URL, BINANCE_FUTURES_TESTNET_URL,
  BINANCE_SPOT_WS, BINANCE_SPOT_TESTNET_WS,
  BINANCE_FUTURES_WS, BINANCE_FUTURES_TESTNET_WS,
} = require('../config');

// ─── ERROR CODE MAP ───────────────────────────────────────────────────────────
const BINANCE_ERRORS = {
  '0':     'Binance unavailable from this region (geo-restriction).',
  '-1002': 'Unauthorized — check API key and secret.',
  '-1003': 'Rate limit exceeded. Wait before retrying.',
  '-1013': 'Invalid quantity or price — check lot size/tick size filters.',
  '-1021': 'Timestamp out of sync. Check your system clock.',
  '-1022': 'Invalid signature — key and secret do not match.',
  '-2010': 'Order rejected — insufficient balance or invalid parameters.',
  '-2013': 'Order does not exist.',
  '-2014': 'API key format invalid.',
  '-2015': 'Invalid API key, IP restriction, or insufficient permissions.',
  '-2019': 'Insufficient margin balance.',
  '-4003': 'Futures quantity below minimum.',
  '-4059': 'Margin type already set — no change needed.',
  '-4061': 'Order side does not match open position side.',
};

function humanizeError(code, msg) {
  const known = BINANCE_ERRORS[String(code)];
  if (known) return known;
  if (!msg) return `Binance error code ${code}`;
  const m = msg.toLowerCase();
  if (m.includes('ip') && m.includes('restrict')) return 'API key is IP-restricted. Disable IP restriction on Binance.';
  if (m.includes('signature')) return 'Invalid signature — key and secret do not match.';
  if (m.includes('api-key') || m.includes('apikey')) return 'API key does not exist or was deleted.';
  if (m.includes('timestamp')) return 'Timestamp mismatch — check system clock.';
  if (m.includes('permission')) return 'Permission denied — enable trading permission on this API key.';
  return msg;
}

function isRetryableNetworkError(err) {
  return err?.binanceCode === 'NETWORK' || err?.binanceCode === 'TIMEOUT' || err?.code === 'ECONNRESET';
}

// ─── HTTP HELPER ─────────────────────────────────────────────────────────────
function httpsRequest(baseUrl, method, path, params, apiKey, signed, apiSecret) {
  return new Promise((resolve, reject) => {
    let qs = params ? new URLSearchParams(params).toString() : '';
    if (signed && apiSecret) {
      const ts = Date.now();
      qs += (qs ? '&' : '') + `timestamp=${ts}&recvWindow=10000`;
      qs += `&signature=${crypto.createHmac('sha256', apiSecret).update(qs).digest('hex')}`;
    }
    const url = new URL(baseUrl + path + (qs ? '?' + qs : ''));
    const options = {
      hostname: url.hostname, port: 443,
      path: url.pathname + url.search, method,
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'X-MBX-APIKEY': apiKey } : {}) },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) &&
              typeof parsed.code === 'number' && parsed.msg !== undefined) {
            const err = new Error(humanizeError(parsed.code, parsed.msg));
            err.binanceCode  = parsed.code;
            err.binanceMsg   = parsed.msg;
            err.endpoint     = `${method} ${baseUrl}${path}`;
            err.payload      = params || {};
            err.responseBody = data;
            err.httpStatus   = res.statusCode;
            reject(err);
          } else {
            resolve(parsed);
          }
        } catch {
          const err = new Error('Failed to parse Binance response: ' + data.slice(0, 200));
          err.endpoint = `${method} ${baseUrl}${path}`;
          err.payload  = params || {};
          err.responseBody = data;
          err.httpStatus = res.statusCode;
          reject(err);
        }
      });
    });
    req.on('error', (err) => {
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ECONNRESET') {
        const e = new Error('Network error — cannot connect to Binance.');
        e.binanceCode = 'NETWORK'; e.endpoint = `${method} ${baseUrl}${path}`; e.payload = params || {};
        reject(e);
      } else { reject(err); }
    });
    req.setTimeout(12000, () => {
      req.destroy();
      const e = Object.assign(new Error('Request timeout.'), { binanceCode: 'TIMEOUT', endpoint: `${method} ${baseUrl}${path}`, payload: params || {} });
      reject(e);
    });
    req.end();
  });
}

/** Builds the full multi-line diagnostic block required for SL/TP failure logging. */
function formatBinanceErrorDiagnostic(err) {
  const safePayload = { ...(err.payload || {}) };
  return [
    `Endpoint: ${err.endpoint || 'unknown'}`,
    `Payload: ${JSON.stringify(safePayload)}`,
    `Error Code: ${err.binanceCode ?? 'N/A'}`,
    `Message: ${err.binanceMsg || err.message}`,
    `Response: ${err.responseBody || 'N/A'}`,
  ].join('\n');
}

/** Network-level retry only — never retries on Binance application errors (bad signature etc). */
function reqWithRetry(baseUrl, method, path, params, apiKey, signed, apiSecret) {
  return retryWithBackoff(
    () => httpsRequest(baseUrl, method, path, params, apiKey, signed, apiSecret),
    {
      attempts: 3, baseDelayMs: 400, maxDelayMs: 3000,
      onRetry: (err) => { if (!isRetryableNetworkError(err)) throw err; },
    }
  ).catch((err) => { throw err; });
}

// ─── BASE CLIENT (shared behaviour) ──────────────────────────────────────────
class BaseClient {
  req(method, path, params = {}, signed = false) {
    // Network errors are retried transparently; Binance application errors are not.
    return httpsRequest(this.base, method, path, params, this.apiKey, signed, this.apiSecret)
      .catch(async (err) => {
        if (!isRetryableNetworkError(err)) throw err;
        return reqWithRetry(this.base, method, path, params, this.apiKey, signed, this.apiSecret);
      });
  }

  subscribeKlines(symbol, interval, callback) {
    const stream = `${symbol.toLowerCase()}@kline_${interval}`;
    return this._openSocket(stream, (m) => { if (m.k) callback(m.k); });
  }

  subscribeMarkPrice(symbol, callback) {
    const stream = `${symbol.toLowerCase()}@markPrice`;
    return this._openSocket(stream, callback);
  }

  _openSocket(stream, onMessage) {
    let closedByUs = false;
    const connect = () => {
      const ws = new WebSocket(`${this.wsBase}/${stream}`);
      ws.on('message', (d) => { try { const m = JSON.parse(d); onMessage(m); } catch { /* ignore malformed frame */ } });
      ws.on('error', (err) => logger.debug(`[WS-ERROR] ${stream}`, { err: err.message }));
      ws.on('close', () => { if (!closedByUs) setTimeout(connect, 5000); }); // auto-reconnect
      this.sockets[stream] = ws;
      return ws;
    };
    const ws = connect();
    return { close: () => { closedByUs = true; try { ws.close(); } catch { /* ignore */ } } };
  }

  closeAll() {
    Object.values(this.sockets).forEach((ws) => { try { ws.close(); } catch { /* ignore */ } });
    this.sockets = {};
  }

  // ─── USER DATA STREAM (listenKey) — used by the statistics service ────────
  async createListenKey()        { return this.req('POST',   this.listenKeyPath, {}, false); }
  async keepAliveListenKey(key)  { return this.req('PUT',    this.listenKeyPath, { listenKey: key }, false); }
  async closeListenKey(key)      { return this.req('DELETE', this.listenKeyPath, { listenKey: key }, false); }

  subscribeUserData(listenKey, onMessage) {
    return this._openSocket(listenKey, onMessage);
  }
}

// ─── SPOT CLIENT ─────────────────────────────────────────────────────────────
class BinanceSpotClient extends BaseClient {
  constructor(apiKey = '', apiSecret = '', testnet = false) {
    super();
    this.apiKey      = apiKey;
    this.apiSecret   = apiSecret;
    this.testnet     = testnet;
    this.base        = testnet ? BINANCE_SPOT_TESTNET_URL : BINANCE_SPOT_URL;
    this.wsBase      = (testnet ? BINANCE_SPOT_TESTNET_WS : BINANCE_SPOT_WS) + '/ws';
    this.sockets     = {};
    this.marketType  = 'spot';
    this.listenKeyPath = '/api/v3/userDataStream';
  }

  ping()                { return this.req('GET', '/api/v3/ping'); }
  getExchangeInfo()     { return this.req('GET', '/api/v3/exchangeInfo'); }
  getKlines(s, i, l = 200) { return this.req('GET', '/api/v3/klines', { symbol: s, interval: i, limit: l }); }
  getAllTickers()        { return this.req('GET', '/api/v3/ticker/24hr'); }
  getPrice(symbol)       { return this.req('GET', '/api/v3/ticker/price', { symbol }); }
  getAccountInfo()       { return this.req('GET', '/api/v3/account', {}, true); }
  getOpenOrders(symbol)  { return this.req('GET', '/api/v3/openOrders', symbol ? { symbol } : {}, true); }
  cancelOrder(s, id)     { return this.req('DELETE', '/api/v3/order', { symbol: s, orderId: id }, true); }
  getMyTrades(symbol, startTime, limit = 50) {
    const params = { symbol, limit };
    if (startTime) params.startTime = startTime;
    return this.req('GET', '/api/v3/myTrades', params, true);
  }

  async getBalance() {
    const account = await this.getAccountInfo();
    const usdt = account.balances.find((b) => b.asset === 'USDT');
    return {
      free:           parseFloat(usdt?.free   || 0),
      locked:         parseFloat(usdt?.locked || 0),
      total:          parseFloat(usdt?.free   || 0) + parseFloat(usdt?.locked || 0),
      available:      parseFloat(usdt?.free   || 0),
      margin_balance: parseFloat(usdt?.free   || 0),
      unrealized_pnl: 0,
      canTrade:       account.canTrade,
    };
  }

  async getOpenPositions() {
    try {
      const orders = await this.getOpenOrders();
      return (orders || []).map((o) => ({
        symbol: o.symbol, side: o.side, type: o.type,
        quantity: parseFloat(o.origQty || 0), price: parseFloat(o.price || 0),
        order_id: String(o.orderId), status: o.status,
      }));
    } catch { return []; }
  }

  async getAllOpenOrders() {
    try { const o = await this.getOpenOrders(); return Array.isArray(o) ? o : []; } catch { return []; }
  }

  placeMarketOrder(symbol, side, quantity) {
    return this.req('POST', '/api/v3/order', { symbol, side: side.toUpperCase(), type: 'MARKET', quantity: quantity.toFixed(6) }, true);
  }

  async getActivePairs(minVolume = 500000) {
    let info, tickers;
    try { [info, tickers] = await Promise.all([this.getExchangeInfo(), this.getAllTickers()]); }
    catch (err) { logger.error('Spot getActivePairs error', { err: err.message }); return []; }
    if (!info?.symbols || !Array.isArray(tickers)) return [];
    const active = new Set(
      info.symbols
        .filter((s) => s.status === 'TRADING' && s.quoteAsset === 'USDT' && s.isSpotTradingAllowed && !/(UP|DOWN|BEAR|BULL)/.test(s.symbol))
        .map((s) => s.symbol)
    );
    return tickers
      .filter((t) => active.has(t.symbol) && parseFloat(t.quoteVolume) >= minVolume)
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, 100)
      .map((t) => ({ symbol: t.symbol, price: parseFloat(t.lastPrice), change: parseFloat(t.priceChangePercent), volume: parseFloat(t.quoteVolume) }));
  }

  async verifyCredentials() {
    try { await this.ping(); } catch (err) {
      return { valid: false, errorTitle: '❌ Network Error', errorReason: err.message, binanceCode: err.binanceCode || 'NETWORK', binanceMsg: err.binanceMsg || err.message };
    }
    try {
      const account = await this.getAccountInfo();
      const usdt    = account.balances.find((b) => b.asset === 'USDT');
      if (!account.canTrade) return { valid: false, errorTitle: '❌ Trading Disabled', errorReason: 'API key lacks Spot trading permission.', binanceCode: null, binanceMsg: 'canTrade=false' };
      return { valid: true, accountType: 'Spot', usdtBalance: parseFloat(usdt?.free || 0), availableBalance: parseFloat(usdt?.free || 0), canTrade: true, permissions: account.permissions || ['SPOT'] };
    } catch (err) {
      return { valid: false, errorTitle: '❌ Access Failed', errorReason: err.message, binanceCode: err.binanceCode, binanceMsg: err.binanceMsg };
    }
  }
}

// ─── FUTURES CLIENT ───────────────────────────────────────────────────────────
class BinanceFuturesClient extends BaseClient {
  constructor(apiKey = '', apiSecret = '', testnet = false) {
    super();
    this.apiKey      = apiKey;
    this.apiSecret   = apiSecret;
    this.testnet     = testnet;
    this.base        = testnet ? BINANCE_FUTURES_TESTNET_URL : BINANCE_FUTURES_URL;
    this.wsBase      = (testnet ? BINANCE_FUTURES_TESTNET_WS : BINANCE_FUTURES_WS) + '/ws';
    this.sockets     = {};
    this.marketType  = 'futures';
    this.listenKeyPath = '/fapi/v1/listenKey';
  }

  ping()                  { return this.req('GET', '/fapi/v1/ping'); }
  getKlines(s, i, l = 200) { return this.req('GET', '/fapi/v1/klines', { symbol: s, interval: i, limit: l }); }
  getAllTickers()          { return this.req('GET', '/fapi/v1/ticker/24hr'); }
  getPrice(symbol)         { return this.req('GET', '/fapi/v1/ticker/price', { symbol }); }
  getExchangeInfo()        { return this.req('GET', '/fapi/v1/exchangeInfo'); }
  getAccountInfo()         { return this.req('GET', '/fapi/v2/account', {}, true); }
  getPositions()           { return this.req('GET', '/fapi/v2/positionRisk', {}, true); }
  getPositionBySymbol(symbol) { return this.req('GET', '/fapi/v2/positionRisk', { symbol }, true); }
  getOpenOrders(symbol)    { return this.req('GET', '/fapi/v1/openOrders', symbol ? { symbol } : {}, true); }
  cancelOrder(s, id)       { return this.req('DELETE', '/fapi/v1/order', { symbol: s, orderId: id }, true); }
  setLeverage(s, l)        { return this.req('POST', '/fapi/v1/leverage', { symbol: s, leverage: l }, true); }
  setMarginType(s, t)      { return this.req('POST', '/fapi/v1/marginType', { symbol: s, marginType: t }, true); }

  /**
   * Detects whether the account is in Hedge Mode (dualSidePosition=true) or
   * One-Way Mode (false). GET /fapi/v1/positionSide/dual is the official
   * endpoint for this. Result is cached on the client instance since this
   * setting rarely changes and we don't want an extra signed call before
   * every single order.
   */
  async getPositionMode(forceRefresh = false) {
    if (!forceRefresh && this._hedgeModeCache !== undefined) return this._hedgeModeCache;
    try {
      const res = await this.req('GET', '/fapi/v1/positionSide/dual', {}, true);
      this._hedgeModeCache = !!res.dualSidePosition;
    } catch (err) {
      logger.warn('[POSITION-MODE-DETECT-FAILED] defaulting to One-Way Mode', { err: err.message });
      this._hedgeModeCache = false; // One-Way Mode is Binance's default for new accounts
    }
    return this._hedgeModeCache;
  }

  async getUserTrades(symbol, startTime, limit = 50) {
    try {
      const params = { symbol, limit };
      if (startTime) params.startTime = startTime;
      const trades = await this.req('GET', '/fapi/v1/userTrades', params, true);
      return Array.isArray(trades) ? trades : [];
    } catch (err) {
      logger.debug(`getUserTrades error for ${symbol}`, { err: err.message });
      return [];
    }
  }

  async getRealizedPnl(symbol, startTime) {
    try {
      const params = { incomeType: 'REALIZED_PNL', limit: 50 };
      if (symbol)    params.symbol    = symbol;
      if (startTime) params.startTime = startTime;
      const result = await this.req('GET', '/fapi/v1/income', params, true);
      if (!Array.isArray(result)) return null;
      return result.reduce((sum, r) => sum + parseFloat(r.income || 0), 0);
    } catch (err) {
      logger.debug('getRealizedPnl error', { err: err.message });
      return null;
    }
  }

  async getRealizedPnlRange(symbol, startTime, endTime) {
    try {
      const params = { incomeType: 'REALIZED_PNL', limit: 100 };
      if (symbol)    params.symbol    = symbol;
      if (startTime) params.startTime = startTime;
      if (endTime)   params.endTime   = endTime;
      const result = await this.req('GET', '/fapi/v1/income', params, true);
      if (!Array.isArray(result)) return { total: null, records: [] };
      const total = result.reduce((sum, r) => sum + parseFloat(r.income || 0), 0);
      return { total, records: result };
    } catch { return { total: null, records: [] }; }
  }

  async getActualFillPrice(symbol, openTime, closeSide) {
    try {
      const startTime = openTime ? new Date(openTime).getTime() : undefined;
      const trades = await this.getUserTrades(symbol, startTime, 50);
      if (!trades.length) return null;
      const closing = trades.filter((t) => t.side === closeSide && !t.maker);
      if (!closing.length) {
        const all = trades.filter((t) => t.side === closeSide);
        if (!all.length) return null;
        const totalQty = all.reduce((s, t) => s + parseFloat(t.qty), 0);
        if (!totalQty) return null;
        return all.reduce((s, t) => s + parseFloat(t.price) * parseFloat(t.qty), 0) / totalQty;
      }
      const totalQty = closing.reduce((s, t) => s + parseFloat(t.qty), 0);
      if (!totalQty) return null;
      return closing.reduce((s, t) => s + parseFloat(t.price) * parseFloat(t.qty), 0) / totalQty;
    } catch { return null; }
  }

  async getOpenPositions() {
    try {
      const positions = await this.getPositions();
      return (positions || []).filter((p) => parseFloat(p.positionAmt) !== 0).map((p) => {
        const posAmt = parseFloat(p.positionAmt);
        const side   = posAmt > 0 ? 'BUY' : 'SELL';
        const qty    = Math.abs(posAmt);
        const entry  = parseFloat(p.entryPrice);
        const mark   = parseFloat(p.markPrice);
        const unreal = parseFloat(p.unRealizedProfit);
        const lev    = parseInt(p.leverage || 1, 10);
        const liq    = parseFloat(p.liquidationPrice || 0);
        const margin = lev > 0 ? (qty * entry) / lev : qty * entry;
        const diff   = side === 'BUY' ? mark - entry : entry - mark;
        const pnlPct = entry > 0 ? parseFloat(((diff / entry) * 100).toFixed(2)) : 0;
        return {
          symbol: p.symbol, side, quantity: qty, entry, current_price: mark, leverage: lev,
          profit: parseFloat(unreal.toFixed(4)), profit_pct: pnlPct,
          liquidation_price: liq, margin_used: parseFloat(margin.toFixed(4)),
          unrealized_pnl: parseFloat(unreal.toFixed(4)),
          open_time: p.updateTime || Date.now(),
        };
      });
    } catch (err) {
      logger.debug('getOpenPositions error', { err: err.message });
      return [];
    }
  }

  async getAllOpenOrders() {
    try { const o = await this.getOpenOrders(); return Array.isArray(o) ? o : []; } catch { return []; }
  }

  async getBalance() {
    const account = await this.getAccountInfo();
    const usdt  = (account.assets || []).find((a) => a.asset === 'USDT');
    const avail = parseFloat(usdt?.availableBalance || account.availableBalance || 0);
    const total = parseFloat(usdt?.walletBalance    || account.totalWalletBalance || 0);
    const mBal  = parseFloat(account.totalMarginBalance    || total);
    const uPnl  = parseFloat(account.totalUnrealizedProfit || 0);
    return { free: avail, locked: total - avail, total, available: avail, margin_balance: mBal, unrealized_pnl: uPnl, canTrade: account.canTrade !== false };
  }

  /**
   * Places the entry MARKET order. positionSide must be 'LONG'/'SHORT' in
   * Hedge Mode, or omitted/'BOTH' in One-Way Mode — passing the wrong value
   * for the account's actual mode is rejected by Binance.
   */
  placeMarketOrder(symbol, side, quantity, positionSide = 'BOTH') {
    const params = { symbol, side: side.toUpperCase(), type: 'MARKET', quantity: quantity.toFixed(3) };
    if (positionSide) params.positionSide = positionSide;
    return this.req('POST', '/fapi/v1/order', params, true);
  }

  placeLimitOrder(symbol, side, quantity, price, positionSide = 'BOTH') {
    const params = { symbol, side: side.toUpperCase(), type: 'LIMIT', quantity: quantity.toFixed(3), price: price.toFixed(8), timeInForce: 'GTC' };
    if (positionSide) params.positionSide = positionSide;
    return this.req('POST', '/fapi/v1/order', params, true);
  }

  /**
   * Places a STOP_MARKET (stop-loss) or TAKE_PROFIT_MARKET (take-profit)
   * conditional order — the official Binance Futures way to protect a
   * position via the standard /fapi/v1/order endpoint (no Algo Order API
   * needed). Two valid, mutually exclusive parameter shapes per Binance's
   * docs, and mixing them is what triggers rejections:
   *
   *   A) closePosition=true  -> closes the ENTIRE position at trigger.
   *      Must NOT include quantity or reduceOnly.
   *   B) quantity + reduceOnly=true -> closes a specific size.
   *      Must NOT include closePosition.
   *
   * We default to (A) — closePosition=true — since the bot always wants
   * the whole position protected, and it sidesteps any quantity-precision
   * mismatch between the filled entry quantity and the order quantity.
   */
  _buildProtectionOrderParams({ symbol, type, side, stopPrice, positionSide, closePosition = true, quantity = null, workingType = 'MARK_PRICE' }) {
    const params = {
      symbol,
      side: side.toUpperCase(),
      type, // STOP_MARKET | TAKE_PROFIT_MARKET
      stopPrice: String(stopPrice),
      workingType, // MARK_PRICE avoids premature triggers from last-price wicks
      priceProtect: 'TRUE',
    };
    if (positionSide) params.positionSide = positionSide;

    if (closePosition) {
      params.closePosition = 'true'; // string per Binance's documented boolean param convention
      // NEVER send quantity or reduceOnly together with closePosition — Binance rejects the combination.
    } else {
      params.quantity = String(quantity);
      params.reduceOnly = 'true';
      // NEVER send closePosition when sizing a partial-close protection order.
    }
    return params;
  }

  placeStopOrder(symbol, side, stopPrice, options = {}) {
    const params = this._buildProtectionOrderParams({
      symbol, type: 'STOP_MARKET', side, stopPrice,
      positionSide: options.positionSide, closePosition: options.closePosition !== false,
      quantity: options.quantity, workingType: options.workingType || 'MARK_PRICE',
    });
    return this.req('POST', '/fapi/v1/order', params, true);
  }

  placeTakeProfitOrder(symbol, side, stopPrice, options = {}) {
    const params = this._buildProtectionOrderParams({
      symbol, type: 'TAKE_PROFIT_MARKET', side, stopPrice,
      positionSide: options.positionSide, closePosition: options.closePosition !== false,
      quantity: options.quantity, workingType: options.workingType || 'MARK_PRICE',
    });
    return this.req('POST', '/fapi/v1/order', params, true);
  }

  placeTrailingStopOrder(symbol, side, quantity, callbackRate, positionSide = 'BOTH') {
    const params = { symbol, side: side.toUpperCase(), type: 'TRAILING_STOP_MARKET', quantity: quantity.toFixed(3), callbackRate };
    if (positionSide) params.positionSide = positionSide;
    return this.req('POST', '/fapi/v1/order', params, true);
  }

  async getActivePairs(minVolume = 1000000) {
    let info, tickers;
    try { [info, tickers] = await Promise.all([this.getExchangeInfo(), this.getAllTickers()]); }
    catch (err) { logger.error('Futures getActivePairs error', { err: err.message }); return []; }
    if (!info?.symbols || !Array.isArray(tickers)) return [];
    const active = new Set(
      (info.symbols || [])
        .filter((s) => s.status === 'TRADING' && s.quoteAsset === 'USDT' && s.contractType === 'PERPETUAL')
        .map((s) => s.symbol)
    );
    return tickers
      .filter((t) => active.has(t.symbol) && parseFloat(t.quoteVolume) >= minVolume)
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, 100)
      .map((t) => ({ symbol: t.symbol, price: parseFloat(t.lastPrice), change: parseFloat(t.priceChangePercent), volume: parseFloat(t.quoteVolume) }));
  }

  async verifyCredentials() {
    try { await this.ping(); } catch (err) {
      return { valid: false, errorTitle: '❌ Network Error', errorReason: err.message, binanceCode: err.binanceCode || 'NETWORK', binanceMsg: err.binanceMsg };
    }
    try {
      const account = await this.getAccountInfo();
      const usdt    = (account.assets || []).find((a) => a.asset === 'USDT');
      const balance = parseFloat(usdt?.walletBalance     || account.totalWalletBalance || 0);
      const avail   = parseFloat(usdt?.availableBalance  || account.availableBalance   || 0);
      const uPnl    = parseFloat(account.totalUnrealizedProfit || 0);
      if (account.canTrade === false) return { valid: false, errorTitle: '❌ Trading Disabled', errorReason: 'API key lacks Futures trading permission.', binanceCode: null, binanceMsg: 'canTrade=false' };
      return { valid: true, accountType: 'Futures (USDT-M)', usdtBalance: balance, availableBalance: avail, unrealizedPnl: uPnl, canTrade: true, feeTier: account.feeTier, permissions: ['FUTURES'] };
    } catch (err) {
      return { valid: false, errorTitle: '❌ Access Failed', errorReason: err.message, binanceCode: err.binanceCode, binanceMsg: err.binanceMsg };
    }
  }
}

// ─── FACTORY ─────────────────────────────────────────────────────────────────
function createClientFor(marketType, apiKey, apiSecret, testnet) {
  return marketType === 'futures'
    ? new BinanceFuturesClient(apiKey, apiSecret, testnet)
    : new BinanceSpotClient(apiKey, apiSecret, testnet);
}

const publicSpot    = new BinanceSpotClient();
const publicFutures = new BinanceFuturesClient();

module.exports = {
  BinanceSpotClient,
  BinanceFuturesClient,
  createClientFor,
  publicSpot,
  publicFutures,
  humanizeError,
  formatBinanceErrorDiagnostic,
};
