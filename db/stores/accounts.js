'use strict';
const { readJSON, writeJSON, withFileLock } = require('../jsonStore');
const { config, ACCOUNT_TYPES, isValidAccountType } = require('../../config');

const FILE = config.paths.accounts;

function emptySlots() {
  return {
    [ACCOUNT_TYPES.REAL_SPOT]:        null,
    [ACCOUNT_TYPES.REAL_FUTURES]:     null,
    [ACCOUNT_TYPES.TESTNET_SPOT]:     null,
    [ACCOUNT_TYPES.TESTNET_FUTURES]:  null,
  };
}

function getStore() {
  return readJSON(FILE) || {};
}

const accountsStore = {
  /** All 4 account slots for a user (null where not yet connected). */
  getForUser(userId) {
    const store = getStore();
    const slots = store[String(userId)] || emptySlots();
    return { ...emptySlots(), ...slots };
  },

  /** A single saved account slot, or null if that slot was never connected. */
  getAccount(userId, accountType) {
    if (!isValidAccountType(accountType)) return null;
    return accountsStore.getForUser(userId)[accountType] || null;
  },

  hasAccount(userId, accountType) {
    return !!accountsStore.getAccount(userId, accountType);
  },

  /**
   * Save (or update) the credentials for one account slot. Credentials are
   * saved permanently — the user is never asked again for this slot unless
   * they explicitly disconnect it.
   */
  async saveAccount(userId, accountType, { apiKey, apiSecret, startingBalance = null }) {
    if (!isValidAccountType(accountType)) throw new Error('Invalid account type');
    return withFileLock(FILE, () => {
      const store = getStore();
      const uid   = String(userId);
      store[uid]  = { ...emptySlots(), ...(store[uid] || {}) };
      const prev  = store[uid][accountType];
      store[uid][accountType] = {
        api_key:          apiKey,
        api_secret:       apiSecret,
        connected_at:     prev?.connected_at || new Date().toISOString(),
        last_sync:        null,
        starting_balance: startingBalance ?? prev?.starting_balance ?? null,
        balance_snapshot: prev?.balance_snapshot || null,
      };
      writeJSON(FILE, store);
      return store[uid][accountType];
    });
  },

  async updateSnapshot(userId, accountType, snapshot) {
    if (!isValidAccountType(accountType)) return null;
    return withFileLock(FILE, () => {
      const store = getStore();
      const uid   = String(userId);
      if (!store[uid] || !store[uid][accountType]) return null;
      store[uid][accountType] = {
        ...store[uid][accountType],
        balance_snapshot: snapshot,
        last_sync: new Date().toISOString(),
      };
      writeJSON(FILE, store);
      return store[uid][accountType];
    });
  },

  /** Permanently removes one account slot's credentials. */
  async deleteAccount(userId, accountType) {
    if (!isValidAccountType(accountType)) return false;
    return withFileLock(FILE, () => {
      const store = getStore();
      const uid   = String(userId);
      if (!store[uid]) return false;
      store[uid][accountType] = null;
      writeJSON(FILE, store);
      return true;
    });
  },

  async deleteAllForUser(userId) {
    return withFileLock(FILE, () => {
      const store = getStore();
      delete store[String(userId)];
      writeJSON(FILE, store);
      return true;
    });
  },

  /** How many of the 4 slots are connected — used for admin stats. */
  countConnectedSlots() {
    const store = getStore();
    let n = 0;
    for (const slots of Object.values(store)) {
      for (const t of Object.values(ACCOUNT_TYPES)) if (slots?.[t]) n++;
    }
    return n;
  },
};

module.exports = accountsStore;
