'use strict';
const crypto = require('crypto');
const db     = require('../db');
const logger = require('../lib/logger');
const { createClientFor } = require('./binanceService');
const { ACCOUNT_TYPES, ACCOUNT_TYPE_META, isValidAccountType } = require('../config');

// ─── CONNECTION REUSE CACHE ───────────────────────────────────────────────────
// Binance REST clients are cheap objects (no persistent socket per request),
// but we still reuse the same instance per user+account so any internal
// state (open WS subscriptions, listenKey, etc.) survives across calls
// instead of being recreated on every single bot interaction.
const clientCache = new Map(); // cacheKey -> { client, hash }

function credHash(apiKey, apiSecret) {
  return crypto.createHash('sha256').update(`${apiKey}:${apiSecret}`).digest('hex').slice(0, 16);
}

function cacheKey(userId, accountType) {
  return `${userId}:${accountType}`;
}

function buildClient(accountType, account) {
  const meta = ACCOUNT_TYPE_META[accountType];
  return createClientFor(meta.marketType, account.api_key, account.api_secret, meta.testnet);
}

const accountManager = {
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_META,

  /** All 4 slots + which are connected, for rendering the Switch Account menu. */
  getSlotsOverview(userId) {
    const slots = db.accounts.getForUser(userId);
    return Object.values(ACCOUNT_TYPES).map((type) => ({
      type,
      connected: !!slots[type],
      ...ACCOUNT_TYPE_META[type],
    }));
  },

  getActiveAccountType(user) {
    return user?.active_account_type || null;
  },

  getActiveAccount(userId) {
    const user = db.users.findById(userId);
    if (!user?.active_account_type) return null;
    const account = db.accounts.getAccount(userId, user.active_account_type);
    if (!account) return null;
    return { type: user.active_account_type, ...account, ...ACCOUNT_TYPE_META[user.active_account_type] };
  },

  hasAnyAccount(userId) {
    const slots = db.accounts.getForUser(userId);
    return Object.values(slots).some(Boolean);
  },

  /**
   * Attempt to switch the user's active account to `accountType`.
   * - If credentials already exist for that slot: switches immediately,
   *   reconnects (no bot restart needed), and returns { switched: true }.
   * - If credentials are missing: returns { needsCredentials: true } so the
   *   caller can start the one-time API key / secret entry flow.
   */
  async switchAccount(userId, accountType) {
    if (!isValidAccountType(accountType)) return { switched: false, error: 'INVALID_ACCOUNT_TYPE' };
    const existing = db.accounts.getAccount(userId, accountType);
    if (!existing) return { switched: false, needsCredentials: true };

    await db.users.update(userId, { active_account_type: accountType });
    logger.info(`[ACCOUNT-SWITCH] user:${userId} → ${accountType}`);
    return { switched: true, needsCredentials: false };
  },

  /**
   * First-time connection for a slot: verifies credentials against Binance,
   * saves them permanently, and activates the slot. The user is never asked
   * again for this slot unless they explicitly disconnect it.
   */
  async connectAccount(userId, accountType, apiKey, apiSecret) {
    if (!isValidAccountType(accountType)) return { success: false, reason: 'INVALID_ACCOUNT_TYPE' };
    const meta   = ACCOUNT_TYPE_META[accountType];
    const client = createClientFor(meta.marketType, apiKey, apiSecret, meta.testnet);
    const result = await client.verifyCredentials();

    if (!result.valid) {
      await db.apiErrors.log({
        user_id: userId, account_type: accountType, market_type: meta.marketType,
        error_code: result.binanceCode, error_message: result.errorReason,
        binance_code: result.binanceCode, binance_msg: result.binanceMsg,
      });
      return { success: false, reason: 'VERIFY_FAILED', result };
    }

    await db.accounts.saveAccount(userId, accountType, {
      apiKey, apiSecret,
      startingBalance: result.usdtBalance ?? 0,
    });
    await db.users.update(userId, { active_account_type: accountType });

    // Warm the client cache immediately so the very next call reuses it.
    clientCache.set(cacheKey(userId, accountType), { client, hash: credHash(apiKey, apiSecret) });

    logger.info(`[ACCOUNT-CONNECT] user:${userId} connected ${accountType}`);
    return { success: true, result };
  },

  /** Permanently removes one saved account slot. Clears any active pointer/cache for it. */
  async disconnectAccount(userId, accountType) {
    if (!isValidAccountType(accountType)) return false;
    await db.accounts.deleteAccount(userId, accountType);
    clientCache.delete(cacheKey(userId, accountType));

    const user = db.users.findById(userId);
    if (user?.active_account_type === accountType) {
      await db.users.update(userId, { active_account_type: null });
    }
    logger.info(`[ACCOUNT-DISCONNECT] user:${userId} disconnected ${accountType}`);
    return true;
  },

  /**
   * Returns a ready-to-use Binance client for the user's CURRENT active
   * account, reusing a cached instance when credentials haven't changed.
   * Returns null if the user has no active account connected.
   */
  getActiveClient(userId) {
    const user = db.users.findById(userId);
    if (!user?.active_account_type) return null;
    return accountManager.getClientForType(userId, user.active_account_type);
  },

  getClientForType(userId, accountType) {
    if (!isValidAccountType(accountType)) return null;
    const account = db.accounts.getAccount(userId, accountType);
    if (!account) return null;

    const key  = cacheKey(userId, accountType);
    const hash = credHash(account.api_key, account.api_secret);
    const cached = clientCache.get(key);
    if (cached && cached.hash === hash) return cached.client;

    const client = buildClient(accountType, account);
    clientCache.set(key, { client, hash });
    return client;
  },

  /** Drops a cached client (forces a fresh instance on next use). */
  invalidateClient(userId, accountType) {
    clientCache.delete(cacheKey(userId, accountType));
  },

  formatAccountLabel(accountType) {
    if (!accountType) return 'Not connected';
    const meta = ACCOUNT_TYPE_META[accountType];
    return meta ? `${meta.label} (${meta.categoryLabel})` : accountType;
  },
};

module.exports = accountManager;
