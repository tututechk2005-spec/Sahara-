'use strict';
const fs = require('fs');
const { config, DB_BACKUP_DIR } = require('../config');
const logger = require('../lib/logger');
const { readJSON, writeJSON } = require('./jsonStore');

const users      = require('./stores/users');
const accounts   = require('./stores/accounts');
const trades     = require('./stores/trades');
const signals    = require('./stores/signals');
const referrals  = require('./stores/referrals');
const settings   = require('./stores/settings');
const payment    = require('./stores/payment');
const help       = require('./stores/help');
const channel    = require('./stores/channel');
const cooldown   = require('./stores/cooldown');
const apiErrors  = require('./stores/apiErrors');
const botLogs    = require('./stores/botLogs');
const broadcasts = require('./stores/broadcasts');

for (const dir of [config.paths.dataDir, config.paths.logsDir, DB_BACKUP_DIR]) {
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
}

async function cleanOrphansAndDuplicates() {
  const allTrades = trades.getAll();
  const seen = new Map();
  const cleaned = [];
  let dupCount = 0;

  for (const t of allTrades) {
    if (t.status !== 'open') { cleaned.push(t); continue; }
    const key = `${t.user_id}:${t.symbol}:${t.side}:${t.market_type}`;
    if (seen.has(key)) {
      const existing = seen.get(key);
      const existingIdx = cleaned.indexOf(existing);
      if (!existing.order_id && t.order_id) { cleaned.splice(existingIdx, 1, t); seen.set(key, t); }
      dupCount++;
      logger.warn(`[DB-CLEAN] Removed duplicate trade: ${t.trade_id}`);
    } else { seen.set(key, t); cleaned.push(t); }
  }
  if (dupCount > 0) { writeJSON(config.paths.trades, cleaned); logger.info(`[DB-CLEAN] Removed ${dupCount} duplicate open trade(s)`); }

  const sigs = signals.getAll();
  const sigSeen = new Map();
  const cleanSigs = [];
  let sigDups = 0;
  for (const s of [...sigs].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))) {
    const key = `${s.symbol}:${s.signal}:${s.market_type}`;
    const existing = sigSeen.get(key);
    if (existing) {
      const ageDiff = Math.abs(new Date(existing.timestamp) - new Date(s.timestamp));
      if (ageDiff < 10 * 60 * 1000) { sigDups++; continue; }
    }
    sigSeen.set(key, s);
    cleanSigs.push(s);
  }
  if (sigDups > 0) {
    writeJSON(config.paths.signals, cleanSigs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)));
    logger.info(`[DB-CLEAN] Removed ${sigDups} duplicate signal(s)`);
  }

  cooldown.cleanup();
  return { dupTrades: dupCount, dupSignals: sigDups };
}

module.exports = {
  users, accounts, trades, signals, referrals,
  settings, payment, help, channel, cooldown,
  apiErrors, botLogs, broadcasts,
  cleanOrphansAndDuplicates,
};
