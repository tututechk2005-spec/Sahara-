'use strict';
const db = require('../db');
const logger = require('../lib/logger');
const { LOG_LEVELS_UI } = require('../config');

/**
 * Structured bot logger — wraps the file logger and simultaneously writes a
 * structured record to db.botLogs so the admin "Live Bot Log" page can show
 * live, richly-formatted log entries without scraping log files.
 *
 * Every log call is fire-and-forget: failures are caught and never allowed
 * to crash the calling code.
 */
function emit(level, module, message, meta = {}) {
  const logFn = level === LOG_LEVELS_UI.ERROR ? 'error'
    : level === LOG_LEVELS_UI.WARNING ? 'warn'
    : 'info';
  logger[logFn](`[${module}] ${message}`, meta.detail ? { detail: meta.detail } : undefined);

  db.botLogs.add({
    level,
    module,
    message,
    user:   meta.user   || null,
    pair:   meta.pair   || null,
    status: meta.status || null,
    detail: meta.detail || null,
  }).catch(() => {});
}

const botLogger = {
  info   (module, message, meta) { emit(LOG_LEVELS_UI.INFO,    module, message, meta); },
  success(module, message, meta) { emit(LOG_LEVELS_UI.SUCCESS,  module, message, meta); },
  warn   (module, message, meta) { emit(LOG_LEVELS_UI.WARNING,  module, message, meta); },
  error  (module, message, meta) { emit(LOG_LEVELS_UI.ERROR,    module, message, meta); },

  // ── convenience helpers ────────────────────────────────────────────────────
  botStarted()       { botLogger.success('SYSTEM',    'Bot started'); },
  schedulerStarted() { botLogger.success('SCHEDULER', 'Scheduler started — 24/7 scanning active'); },
  dbConnected()      { botLogger.success('DATABASE',  'Database connected and integrity-checked'); },
  apiConnected(user, acct)    { botLogger.success('API', 'Binance API connected', { user, status: acct }); },
  apiDisconnected(user, err)  { botLogger.error('API', 'Binance API disconnected', { user, detail: err }); },
  apiReconnected(user, acct)  { botLogger.success('API', 'Binance API reconnected', { user, status: acct }); },
  apiFailed(user, err)        { botLogger.error('API', 'Binance API call failed', { user, detail: err }); },
  scanStarted(market)         { botLogger.info('SCANNER', `Scanning ${market} market...`); },
  noSignal(market)            { botLogger.info('SCANNER', `No signal found (${market})`); },
  signalDetected(sym, sig, score) { botLogger.success('SIGNAL', `Signal detected: ${sym} ${sig} score:${score}`, { pair: sym }); },
  signalRejected(sym, reason)     { botLogger.warn('SIGNAL', `Signal rejected: ${sym} — ${reason}`, { pair: sym, detail: reason }); },
  tradeOpened(user, sym, side)    { botLogger.success('TRADE', `Trade opened: ${sym} ${side}`, { user, pair: sym }); },
  tradeClosed(user, sym, result, profit) { botLogger.success('TRADE', `Trade closed: ${sym} ${result} ${profit}`, { user, pair: sym, status: result }); },
  slHit(user, sym)            { botLogger.warn('TRADE', `Stop Loss hit: ${sym}`, { user, pair: sym }); },
  tpHit(user, sym)            { botLogger.success('TRADE', `Take Profit hit: ${sym}`, { user, pair: sym }); },
  manualTradeDetected(user, sym) { botLogger.info('MONITOR', `Manual trade detected: ${sym}`, { user, pair: sym }); },
  balanceUpdated(user, bal)   { botLogger.info('ACCOUNT', `Balance updated: ${bal}`, { user }); },
  profitUpdated(user, pnl)    { botLogger.info('ACCOUNT', `Profit updated: ${pnl}`, { user }); },
  cronRun(job)                { botLogger.info('CRON', `Cron executed: ${job}`, { status: 'RUN' }); },
  jobRunning(job)             { botLogger.info('SCHEDULER', `Job running: ${job}`); },
};

module.exports = botLogger;
