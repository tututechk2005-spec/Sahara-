'use strict';
require('dotenv').config();

// ─── BINANCE ENDPOINTS ────────────────────────────────────────────────────────
const BINANCE_SPOT_URL             = 'https://api.binance.com';
const BINANCE_FUTURES_URL          = 'https://fapi.binance.com';
const BINANCE_SPOT_TESTNET_URL     = 'https://testnet.binance.vision';
const BINANCE_FUTURES_TESTNET_URL  = 'https://testnet.binancefuture.com';

const BINANCE_SPOT_WS              = 'wss://stream.binance.com:9443';
const BINANCE_SPOT_TESTNET_WS      = 'wss://testnet.binance.vision';
const BINANCE_FUTURES_WS           = 'wss://fstream.binance.com';
const BINANCE_FUTURES_TESTNET_WS   = 'wss://stream.binancefuture.com';

// ─── ACCOUNT TYPES (multi-account "Switch Account" system) ───────────────────
// Every Telegram user may save up to 4 Binance accounts, one per slot below.
// Never overwritten implicitly — only explicit "disconnect" clears a slot.
const ACCOUNT_TYPES = Object.freeze({
  REAL_SPOT:        'real_spot',
  REAL_FUTURES:     'real_futures',
  TESTNET_SPOT:     'testnet_spot',
  TESTNET_FUTURES:  'testnet_futures',
});

const ACCOUNT_TYPE_META = Object.freeze({
  [ACCOUNT_TYPES.REAL_SPOT]:       { marketType: 'spot',    testnet: false, label: '📈 Spot',            category: 'real',    categoryLabel: '💰 Real' },
  [ACCOUNT_TYPES.REAL_FUTURES]:    { marketType: 'futures', testnet: false, label: '📊 Futures',         category: 'real',    categoryLabel: '💰 Real' },
  [ACCOUNT_TYPES.TESTNET_SPOT]:    { marketType: 'spot',    testnet: true,  label: '🟡 Spot Testnet',    category: 'testnet', categoryLabel: '🧪 Testnet' },
  [ACCOUNT_TYPES.TESTNET_FUTURES]: { marketType: 'futures', testnet: true,  label: '🟡 Futures Testnet', category: 'testnet', categoryLabel: '🧪 Testnet' },
});

function isValidAccountType(t) {
  return Object.values(ACCOUNT_TYPES).includes(t);
}

// ─── SNIPER STRATEGY SCORING ──────────────────────────────────────────────────
// 8 mandatory confirmations — a signal only fires when ALL of them agree AND
// the weighted score clears SNIPER_MIN_SCORE. Quality over quantity, always.
const SNIPER_MIN_SCORE   = 90;   // minimum weighted score (0-100) to ever consider a trade
const SNIPER_ELITE_SCORE = 97;   // top-tier sniper signals (used for risk sizing)

const CONFIRMATION_WEIGHTS = Object.freeze({
  trend:               15,  // multi-timeframe (4h/1h) trend agreement
  ema_trend:           15,  // price vs EMA50/EMA200 structure
  macd:                15,  // MACD line vs signal line + histogram momentum
  support_resistance:  15,  // price reaction at key swing S/R levels
  rsi:                 10,  // RSI in confirming (not exhausted) zone
  volume:               10,  // above-average volume backing the move
  candle:               10,  // bullish/bearish candle pattern confirmation
  atr:                  10,  // volatility inside a tradable band
});
// sum = 100

const RISK_ELITE   = 1.00;  // % balance risked per trade — elite sniper signal
const RISK_SNIPER  = 0.75;  // % balance risked per trade — standard sniper signal

const SL_ATR_MULT  = 1.5;
const TP_ATR_MULT  = 3.0;
const MIN_RR       = 1.5;

// ─── SCAN / MONITOR / TRADING ─────────────────────────────────────────────────
// NOTE: there is intentionally NO maximum number of concurrent trades and NO
// daily win/loss pause — continuous 24/7 scanning per project requirements.
const SCAN_INTERVAL_SEC     = 60;     // how often we scan all pairs for sniper setups
const MONITOR_INTERVAL_MS   = 15000;  // how often open trades are checked / live-updated
const STATS_REFRESH_MS      = 3000;   // real-time statistics cache TTL (per requirement 6)
const BALANCE_SYNC_MS       = 30000;  // background balance/position resync per user
const SUBSCRIPTION_CHECK_MS = 5 * 60 * 1000;

const MIN_SPOT_VOLUME    = 500000;
const MIN_FUTURES_VOLUME = 1000000;
const DEFAULT_LEVERAGE   = 5;

const SIGNAL_COOLDOWN_MS = 4 * 60 * 60 * 1000; // per symbol+market+side cooldown

// ─── REFERRAL PROGRAM ─────────────────────────────────────────────────────────
const REFERRAL_REFERRER_DAYS = 3;  // bonus days credited to the referrer
const REFERRAL_REFEREE_DAYS  = 1;  // bonus day credited to the new user
const REFERRAL_CODE_LENGTH   = 10;

// ─── JSON DATABASE ─────────────────────────────────────────────────────────────
const DB_BACKUP_KEEP = 5;          // rolling backups kept per file
const DB_BACKUP_DIR  = './data/.backups';

// ─── PATHS ─────────────────────────────────────────────────────────────────────
const paths = {
  dataDir:   './data',
  logsDir:   './logs',
  users:     './data/users.json',
  accounts:  './data/accounts.json',
  trades:    './data/trades.json',
  signals:   './data/signals.json',
  referrals: './data/referrals.json',
  settings:  './data/settings.json',
  channel:   './data/channel.json',
  payment:   './data/payment.json',
  help:      './data/help.json',
  cooldown:  './data/cooldown.json',
  apiErrors: './logs/api_errors.json',
  botLogs:      './data/bot_logs.json',
  broadcasts:   './data/broadcasts.json',
};

// ─── ENV ───────────────────────────────────────────────────────────────────────
const config = {
  bot: {
    token:       process.env.BOT_TOKEN     || '',
    adminChatId: process.env.ADMIN_CHAT_ID || '',
  },
  env: {
    nodeEnv:  process.env.NODE_ENV  || 'production',
    logLevel: process.env.LOG_LEVEL || 'info',
    port:     parseInt(process.env.PORT || '3000', 10), // used only for the optional health endpoint on Render
  },
  paths,
};

function validateConfig() {
  const errors = [];
  if (!config.bot.token)       errors.push('BOT_TOKEN is required in .env');
  if (!config.bot.adminChatId) errors.push('ADMIN_CHAT_ID is required in .env');
  if (errors.length) throw new Error('Config error:\n' + errors.join('\n'));
}

// ─── PREMIUM PLANS ─────────────────────────────────────────────────────────────
const PLAN_TYPES = Object.freeze({
  FREE: 'free', TRIAL: 'trial', PREMIUM: 'premium',
});
const PLAN_DURATIONS_DAYS = Object.freeze({
  daily: 1, weekly: 7, monthly: 30, lifetime: 36500,
});

// ─── SIGNAL STATUS (Active Signal Rules) ────────────────────────────────────────
const SIGNAL_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE', REJECTED: 'REJECTED', EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED', CLOSED: 'CLOSED',
});
const SIGNAL_ACTIVE_TTL_MS = 30 * 60 * 1000; // a signal stays ACTIVE for 30 min before auto-expiring

// ─── TRADE STATUS ───────────────────────────────────────────────────────────────
const TRADE_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE', WIN: 'WIN', LOSS: 'LOSS', BREAKEVEN: 'BREAKEVEN', CANCELLED: 'CANCELLED',
});

// ─── LOG LEVELS / MODULES (Admin Bot Logs) ─────────────────────────────────────
const LOG_LEVELS_UI = Object.freeze({
  INFO: 'INFO', SUCCESS: 'SUCCESS', WARNING: 'WARNING', ERROR: 'ERROR',
});
const BOT_LOG_KEEP = 1000; // ring-buffered structured log entries kept in the DB

// ─── BACKGROUND MONITORING ──────────────────────────────────────────────────────
const MANUAL_TRADE_SYNC_MS = 60 * 1000; // detect manual Binance trades every 60s, per requirement

// ─── BROADCAST ───────────────────────────────────────────────────────────────────
const BROADCAST_AUDIENCES = Object.freeze({
  ALL: 'all', PREMIUM: 'premium', TRIAL: 'trial',
});
const BROADCAST_THROTTLE_MS = 35;

module.exports = {
  config,
  validateConfig,

  BINANCE_SPOT_URL,
  BINANCE_FUTURES_URL,
  BINANCE_SPOT_TESTNET_URL,
  BINANCE_FUTURES_TESTNET_URL,
  BINANCE_SPOT_WS,
  BINANCE_SPOT_TESTNET_WS,
  BINANCE_FUTURES_WS,
  BINANCE_FUTURES_TESTNET_WS,

  ACCOUNT_TYPES,
  ACCOUNT_TYPE_META,
  isValidAccountType,

  SNIPER_MIN_SCORE,
  SNIPER_ELITE_SCORE,
  CONFIRMATION_WEIGHTS,
  RISK_ELITE,
  RISK_SNIPER,
  SL_ATR_MULT,
  TP_ATR_MULT,
  MIN_RR,

  SCAN_INTERVAL_SEC,
  MONITOR_INTERVAL_MS,
  STATS_REFRESH_MS,
  BALANCE_SYNC_MS,
  SUBSCRIPTION_CHECK_MS,
  MIN_SPOT_VOLUME,
  MIN_FUTURES_VOLUME,
  DEFAULT_LEVERAGE,
  SIGNAL_COOLDOWN_MS,

  REFERRAL_REFERRER_DAYS,
  REFERRAL_REFEREE_DAYS,
  REFERRAL_CODE_LENGTH,

  DB_BACKUP_KEEP,
  DB_BACKUP_DIR,

  PLAN_TYPES,
  PLAN_DURATIONS_DAYS,
  SIGNAL_STATUS,
  SIGNAL_ACTIVE_TTL_MS,
  TRADE_STATUS,
  LOG_LEVELS_UI,
  BOT_LOG_KEEP,
  MANUAL_TRADE_SYNC_MS,
  BROADCAST_AUDIENCES,
  BROADCAST_THROTTLE_MS,
};
