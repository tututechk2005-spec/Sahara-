'use strict';
const { v4: uuidv4 } = require('uuid');
const { readJSON, writeJSON, withFileLock } = require('../jsonStore');
const { config, SIGNAL_COOLDOWN_MS, SIGNAL_STATUS, SIGNAL_ACTIVE_TTL_MS } = require('../../config');
const { todayUTC } = require('../../lib/utils');
const cooldownStore = require('./cooldown');

const FILE = config.paths.signals;

const signalsStore = {
  getAll()     { return readJSON(FILE) || []; },
  findById(id) { return signalsStore.getAll().find((s) => s.signal_id === id) || null; },

  recent(n = 20) {
    return signalsStore.getAll()
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, n);
  },

  /**
   * Requirement 3 (Active Signal Rules): users must NEVER see anything but
   * currently-ACTIVE signals. This is the only method the user-facing
   * dashboard/Telegram layer should ever call for displaying signals.
   * Auto-expires anything past its TTL as a side effect, so callers never
   * need to remember to run expiry separately.
   */
  activeOnly(marketType) {
    signalsStore._expireStaleSync();
    return signalsStore.getAll()
      .filter((s) => s.status === SIGNAL_STATUS.ACTIVE && (!marketType || s.market_type === marketType))
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  },

  /** All rejected signals with their reasons — admin-only view (requirement 6). */
  rejectedRecent(n = 50) {
    return signalsStore.getAll()
      .filter((s) => s.status === SIGNAL_STATUS.REJECTED)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, n);
  },

  todayCount() {
    return signalsStore.getAll().filter((s) => s.timestamp?.startsWith(todayUTC())).length;
  },

  countAccepted() { return signalsStore.getAll().filter((s) => s.status !== SIGNAL_STATUS.REJECTED).length; },
  countRejected() { return signalsStore.getAll().filter((s) => s.status === SIGNAL_STATUS.REJECTED).length; },

  /** Cooldown is per symbol+market+side only — never blocks unrelated pairs. */
  findActiveDuplicate(symbol, side, marketType, entryPrice) {
    if (cooldownStore.isActive(symbol, marketType, side)) {
      return { duplicate: true, reason: 'COOLDOWN_ACTIVE' };
    }
    const sigs     = signalsStore.getAll();
    const now      = Date.now();
    const cooldown = SIGNAL_COOLDOWN_MS;

    const recentSame = sigs.find((s) => {
      if (s.symbol !== symbol || s.signal !== side || s.market_type !== marketType) return false;
      if (s.status === SIGNAL_STATUS.REJECTED) return false;
      const age = now - new Date(s.timestamp).getTime();
      if (age >= cooldown) return false;
      if (entryPrice && s.entry) {
        const diff = Math.abs(entryPrice - s.entry) / s.entry;
        if (diff > 0.005) return false;
      }
      return true;
    });
    if (recentSame) return { duplicate: true, reason: 'COOLDOWN_ACTIVE', signal: recentSame };
    return { duplicate: false };
  },

  /** Records a tradable sniper signal as ACTIVE (visible to users immediately). */
  async create(data) {
    return withFileLock(FILE, async () => {
      const sigs = readJSON(FILE) || [];
      const now  = Date.now();
      const sig  = {
        signal_id:     uuidv4(),
        market_type:   data.market_type || 'spot',
        symbol:        data.symbol,
        signal:        data.signal,
        entry:         data.entry,
        sl:            data.sl,
        tp:            data.tp,
        rr:            data.rr || '',
        score:         data.score || 0,
        grade:         data.grade || 'SNIPER',
        confirmations: data.confirmations || {},
        atr:           data.atr || 0,
        status:        SIGNAL_STATUS.ACTIVE,
        rejection_reason: null,
        expires_at:    new Date(now + SIGNAL_ACTIVE_TTL_MS).toISOString(),
        timestamp:     new Date(now).toISOString(),
      };
      sigs.push(sig);
      signalsStore._trim(sigs);
      writeJSON(FILE, sigs);
      await cooldownStore.set(data.symbol, data.market_type || 'spot', data.signal);
      return sig;
    });
  },

  /**
   * Records a REJECTED signal candidate with its exact rejection reason
   * (requirement 6). Rejected signals are never visible to users — only to
   * the admin logs/statistics pages.
   */
  async logRejected(data) {
    return withFileLock(FILE, () => {
      const sigs = readJSON(FILE) || [];
      const sig = {
        signal_id:     uuidv4(),
        market_type:   data.market_type || 'spot',
        symbol:        data.symbol,
        signal:        data.signal || null,
        entry:         data.entry || null,
        sl:            null, tp: null, rr: '',
        score:         data.score || 0,
        grade:         null,
        confirmations: data.confirmations || {},
        atr:           data.atr || 0,
        status:        SIGNAL_STATUS.REJECTED,
        rejection_reason: data.reason || 'Confidence below threshold',
        expires_at:    null,
        timestamp:     new Date().toISOString(),
      };
      sigs.push(sig);
      signalsStore._trim(sigs);
      writeJSON(FILE, sigs);
      return sig;
    });
  },

  /** Marks a signal CLOSED once its associated trade has closed (it should no longer be "active"). */
  async markClosed(signalId) {
    if (!signalId) return null;
    return withFileLock(FILE, () => {
      const sigs = readJSON(FILE) || [];
      const idx  = sigs.findIndex((s) => s.signal_id === signalId);
      if (idx === -1) return null;
      sigs[idx].status = SIGNAL_STATUS.CLOSED;
      writeJSON(FILE, sigs);
      return sigs[idx];
    });
  },

  async cancel(signalId) {
    if (!signalId) return null;
    return withFileLock(FILE, () => {
      const sigs = readJSON(FILE) || [];
      const idx  = sigs.findIndex((s) => s.signal_id === signalId);
      if (idx === -1) return null;
      sigs[idx].status = SIGNAL_STATUS.CANCELLED;
      writeJSON(FILE, sigs);
      return sigs[idx];
    });
  },

  /** Flips any ACTIVE signal past its TTL to EXPIRED. Called automatically by activeOnly(). */
  _expireStaleSync() {
    const sigs = readJSON(FILE) || [];
    const now = Date.now();
    let changed = false;
    for (const s of sigs) {
      if (s.status === SIGNAL_STATUS.ACTIVE && s.expires_at && new Date(s.expires_at).getTime() <= now) {
        s.status = SIGNAL_STATUS.EXPIRED;
        changed = true;
      }
    }
    if (changed) writeJSON(FILE, sigs);
  },

  /** Async wrapper for use in scheduled background jobs (lock-safe). */
  async expireStale() {
    return withFileLock(FILE, () => signalsStore._expireStaleSync());
  },

  _trim(sigs) {
    if (sigs.length > 3000) sigs.splice(0, sigs.length - 3000);
  },

  count() { return signalsStore.getAll().length; },
};

module.exports = signalsStore;
