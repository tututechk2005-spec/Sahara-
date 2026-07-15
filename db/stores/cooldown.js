'use strict';
const { readJSON, writeJSON, withFileLock } = require('../jsonStore');
const { config, SIGNAL_COOLDOWN_MS } = require('../../config');

const FILE = config.paths.cooldown;

function key(symbol, market, side) {
  return `${symbol}:${market}:${side}`;
}

const cooldownStore = {
  getAll() { return readJSON(FILE) || {}; },

  isActive(symbol, market, side) {
    const store = cooldownStore.getAll();
    const entry = store[key(symbol, market, side)];
    if (!entry) return false;
    const elapsed = Date.now() - entry.timestamp;
    const active  = elapsed < SIGNAL_COOLDOWN_MS;
    if (!active) cooldownStore.clear(symbol, market, side);
    return active;
  },

  set(symbol, market, side) {
    return withFileLock(FILE, () => {
      const store = readJSON(FILE) || {};
      store[key(symbol, market, side)] = { symbol, market, side, timestamp: Date.now() };
      writeJSON(FILE, store);
      return true;
    });
  },

  clear(symbol, market, side) {
    const store = readJSON(FILE) || {};
    delete store[key(symbol, market, side)];
    writeJSON(FILE, store);
  },

  clearAll() { writeJSON(FILE, {}); },

  cleanup() {
    const store = readJSON(FILE) || {};
    const now = Date.now();
    let changed = false;
    for (const [k, entry] of Object.entries(store)) {
      if (now - entry.timestamp >= SIGNAL_COOLDOWN_MS) { delete store[k]; changed = true; }
    }
    if (changed) writeJSON(FILE, store);
  },
};

module.exports = cooldownStore;
