'use strict';

/** ISO date string for "today" in UTC, e.g. "2026-06-28" */
function todayUTC() {
  return new Date().toISOString().split('T')[0];
}

/** Human friendly duration between two ISO timestamps, e.g. "2h 14m" */
function formatDuration(startIso, endIso) {
  if (!startIso) return 'N/A';
  const ms = new Date(endIso || Date.now()) - new Date(startIso);
  if (!Number.isFinite(ms) || ms < 0) return 'N/A';
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

function fmtNum(n, decimals = 4) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0.' + '0'.repeat(decimals);
  return v.toFixed(decimals);
}

function fmtSigned(n, decimals = 4) {
  const v = Number(n) || 0;
  return (v >= 0 ? '+' : '') + v.toFixed(decimals);
}

function fmtPct(n, decimals = 2) {
  const v = Number(n) || 0;
  return (v >= 0 ? '+' : '') + v.toFixed(decimals) + '%';
}

/** Clamp a number between min and max (inclusive). */
function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}

/** Sleep helper for throttling loops without blocking the event loop. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an async function with exponential backoff.
 * Never throws past the caller unless every attempt fails — caller decides
 * what to do with the final error.
 */
async function retryWithBackoff(fn, { attempts = 3, baseDelayMs = 500, maxDelayMs = 8000, onRetry } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1) break;
      const delay = Math.min(baseDelayMs * 2 ** i, maxDelayMs);
      if (onRetry) { try { onRetry(err, i, delay); } catch { /* ignore */ } }
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * A tiny per-key async mutex. Used anywhere we must serialize operations
 * that touch the same JSON file / user / trade so concurrent handlers never
 * race each other (prevents corruption and duplicate writes).
 */
function createKeyedLock() {
  const locks = new Map();
  return async function withLock(key, fn) {
    const prev = locks.get(key) || Promise.resolve();
    let release;
    const next = new Promise((r) => (release = r));
    locks.set(key, prev.then(() => next));
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (locks.get(key) === next) locks.delete(key);
    }
  };
}

function safeParseFloat(v, fallback = 0) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = {
  todayUTC,
  formatDuration,
  fmtNum,
  fmtSigned,
  fmtPct,
  clamp,
  sleep,
  retryWithBackoff,
  createKeyedLock,
  safeParseFloat,
};
