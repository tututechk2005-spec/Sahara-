'use strict';
const db                  = require('../db');
const logger              = require('../lib/logger');
const botLogger           = require('../services/botLogger');
const signalEngine        = require('../services/signalEngine');
const tradingEngine       = require('../services/tradingEngine');
const accountManager      = require('../services/accountManager');
const manualTradeDetector = require('../services/manualTradeDetector');
const premiumService      = require('../services/premiumService');
const broadcastService    = require('../services/broadcastService');
const { publicSpot, publicFutures } = require('../services/binanceService');
const {
  SCAN_INTERVAL_SEC, MONITOR_INTERVAL_MS, MIN_SPOT_VOLUME, MIN_FUTURES_VOLUME,
  ACCOUNT_TYPE_META,
} = require('../config');

let scanTimer    = null;
let monitorTimer = null;
let running      = false;
let botRef       = null;

async function fetchCandleSet(client, symbol) {
  const [c4h, c1h, c15m] = await Promise.all([
    client.getKlines(symbol, '4h', 100),
    client.getKlines(symbol, '1h', 230),
    client.getKlines(symbol, '15m', 100),
  ]);
  return {
    candles4h: signalEngine.parseKlines(c4h),
    candles1h: signalEngine.parseKlines(c1h),
    candles15m: signalEngine.parseKlines(c15m),
  };
}

async function scanMarket(client, marketType) {
  const minVolume = marketType === 'futures' ? MIN_FUTURES_VOLUME : MIN_SPOT_VOLUME;
  botLogger.scanStarted(marketType);
  let pairs;
  try { pairs = await client.getActivePairs(minVolume); }
  catch (err) {
    botLogger.error('SCANNER', `${marketType} getActivePairs failed`, { detail: err.message });
    return [];
  }

  const found = [];
  for (const pair of pairs) {
    try {
      const candles = await fetchCandleSet(client, pair.symbol);
      const result  = signalEngine.analyze(pair.symbol, marketType, candles);

      if (!result.tradable) {
        // Log rejection with reason (req 6) — but only log to DB, not spam file logs
        await db.signals.logRejected({
          market_type: marketType, symbol: pair.symbol,
          signal: null, entry: pair.price,
          score: result.score, confirmations: result.confirmations,
          reason: result.rejection_reason,
        });
        botLogger.signalRejected(pair.symbol, result.rejection_reason);
        continue;
      }

      const dup = db.signals.findActiveDuplicate(pair.symbol, result.signal, marketType, result.entry);
      if (dup.duplicate) continue;

      const sig = await db.signals.create({ ...result, market_type: marketType });
      found.push({ ...result, ...sig, market_type: marketType });
      botLogger.signalDetected(pair.symbol, result.signal, result.score);
    } catch (err) {
      logger.debug(`[SCAN-SYMBOL-ERROR] ${pair.symbol}`, { err: err.message });
    }
  }

  if (!found.length) botLogger.noSignal(marketType);
  return found;
}

async function actionSignalsForUsers(signals) {
  if (!signals.length) return;
  const users = db.users.getAll().filter((u) => u.auto_trading && u.active_account_type && !u.banned);
  for (const signal of signals) {
    for (const user of users) {
      const meta = ACCOUNT_TYPE_META[user.active_account_type];
      if (!meta || meta.marketType !== signal.market_type) continue;
      try {
        const result = await tradingEngine.openTrade(user, signal);
        if (result.opened) {
          botLogger.tradeOpened(user.telegram_id, signal.symbol, signal.signal);
          try {
            await require('../telegram/botInstance').notifyUser(user.telegram_id,
              `🎯 *${signal.grade.replace('_', ' ')}* signal executed!\n\n` +
              `${signal.signal === 'BUY' ? '🟢' : '🔴'} *${signal.symbol}* ${signal.signal}\n` +
              `Entry: ${signal.entry}\nSL: ${signal.sl}\nTP: ${signal.tp}\n` +
              `Score: ${signal.score}/100\nRR: ${signal.rr}`);
          } catch { /* notification best-effort */ }
        }
      } catch (err) {
        botLogger.error('TRADE', `Auto-trade error for ${signal.symbol}`, { user: user.telegram_id, detail: err.message });
      }
    }
  }
}

async function runScanCycle() {
  if (running) return;
  running = true;
  botLogger.cronRun('SCAN_CYCLE');
  try {
    const [spotSigs, futSigs] = await Promise.all([
      scanMarket(publicSpot,    'spot'),
      scanMarket(publicFutures, 'futures'),
    ]);
    await actionSignalsForUsers([...spotSigs, ...futSigs]);
  } catch (err) {
    botLogger.error('SCANNER', 'Scan cycle error', { detail: err.message });
  } finally {
    running = false;
  }
}

async function runMonitorCycle() {
  botLogger.cronRun('MONITOR_CYCLE');
  try {
    // 1. Monitor open trades (SL/TP enforcement, live PNL updates)
    await tradingEngine.monitorOpenTrades();
    // 2. Detect manual trades from Binance
    await manualTradeDetector.run();
    // 3. Expire stale signals (req 3 — ensures no expired signals sneak through)
    await db.signals.expireStale();
    // 4. Auto-expire overdue premium plans (req 8)
    await premiumService.runExpiry(botRef);
    // 5. Fire scheduled broadcasts (req 4)
    if (botRef) await broadcastService.runScheduled(botRef.telegram);
  } catch (err) {
    botLogger.error('MONITOR', 'Monitor cycle error', { detail: err.message });
  }
}

const scheduler = {
  start(bot) {
    if (scanTimer) return;
    botRef = bot;
    botLogger.schedulerStarted();
    scanTimer    = setInterval(runScanCycle,    SCAN_INTERVAL_SEC * 1000);
    monitorTimer = setInterval(runMonitorCycle, MONITOR_INTERVAL_MS);
    runScanCycle();
    runMonitorCycle();
  },
  stop() {
    if (scanTimer)    { clearInterval(scanTimer);    scanTimer    = null; }
    if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
  },
};

module.exports = scheduler;
