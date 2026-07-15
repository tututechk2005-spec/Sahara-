'use strict';
const logger = require('../lib/logger');
const {
  SL_ATR_MULT, TP_ATR_MULT, MIN_RR,
  SNIPER_MIN_SCORE, SNIPER_ELITE_SCORE, CONFIRMATION_WEIGHTS,
} = require('../config');

// ════════════════════════════════════════════════════════════════════════════
// INDICATOR MATH
// ════════════════════════════════════════════════════════════════════════════

function parseKlines(raw) {
  return raw.map((k) => ({
    time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
  }));
}

function ema(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out = [values.slice(0, period).reduce((a, b) => a + b, 0) / period];
  for (let i = period; i < values.length; i++) out.push(values[i] * k + out[out.length - 1] * (1 - k));
  return out;
}

function sma(values, period) {
  if (values.length < period) return null;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses += Math.abs(d);
  }
  let ag = gains / period, al = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
  }
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let val = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) val = (val * (period - 1) + trs[i]) / period;
  return val;
}

function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  if (closes.length < slow + signalPeriod) return null;
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const offset  = slow - fast;
  const macdLine = emaSlow.map((v, i) => (emaFast[i + offset] !== undefined ? emaFast[i + offset] - v : null)).filter((v) => v !== null);
  if (macdLine.length < signalPeriod) return null;
  const signalLine = ema(macdLine, signalPeriod);
  const histOffset = macdLine.length - signalLine.length;
  const histogram  = signalLine.map((v, i) => macdLine[i + histOffset] - v);
  return {
    macdLine: macdLine.slice(-3), signalLine: signalLine.slice(-3), histogram,
    latest: { macd: macdLine[macdLine.length - 1], signal: signalLine[signalLine.length - 1], hist: histogram[histogram.length - 1] },
    prevHist: histogram[histogram.length - 2] ?? histogram[histogram.length - 1],
  };
}

function supportResistance(candles, lookback = 60, wing = 2) {
  const slice = candles.slice(-lookback);
  const highs = [], lows = [];
  for (let i = wing; i < slice.length - wing; i++) {
    const c = slice[i];
    const left = slice.slice(i - wing, i), right = slice.slice(i + 1, i + 1 + wing);
    if (left.every((x) => c.high > x.high) && right.every((x) => c.high > x.high)) highs.push(c.high);
    if (left.every((x) => c.low  < x.low)  && right.every((x) => c.low  < x.low))  lows.push(c.low);
  }
  return {
    support:    lows.length  ? Math.min(...lows.slice(-5))  : null,
    resistance: highs.length ? Math.max(...highs.slice(-5)) : null,
  };
}

function candlePattern(candles) {
  if (candles.length < 2) return { bullish: false, bearish: false, pattern: null };
  const [prev, cur] = candles.slice(-2);
  const body  = Math.abs(cur.close - cur.open);
  const range = cur.high - cur.low || 1e-9;
  const upperWick = cur.high - Math.max(cur.open, cur.close);
  const lowerWick = Math.min(cur.open, cur.close) - cur.low;
  const bullishEngulf = cur.close > cur.open && prev.close < prev.open && cur.close >= prev.open && cur.open <= prev.close;
  const bearishEngulf = cur.close < cur.open && prev.close > prev.open && cur.close <= prev.open && cur.open >= prev.close;
  const hammer       = lowerWick > body * 1.8 && upperWick < body * 0.6 && body / range > 0.08;
  const shootingStar  = upperWick > body * 1.8 && lowerWick < body * 0.6 && body / range > 0.08;
  if (bullishEngulf) return { bullish: true, bearish: false, pattern: 'BULLISH_ENGULFING' };
  if (bearishEngulf) return { bullish: false, bearish: true, pattern: 'BEARISH_ENGULFING' };
  if (hammer)        return { bullish: true, bearish: false, pattern: 'HAMMER' };
  if (shootingStar)  return { bullish: false, bearish: true, pattern: 'SHOOTING_STAR' };
  return { bullish: false, bearish: false, pattern: null };
}

function trendDirection(closes) {
  const e21 = ema(closes, 21), e50 = ema(closes, 50);
  if (e21.length < 2 || e50.length < 2) return 'neutral';
  const fast = e21[e21.length - 1], fastPrev = e21[e21.length - 2], slow = e50[e50.length - 1];
  if (fast > slow && fast > fastPrev) return 'BUY';
  if (fast < slow && fast < fastPrev) return 'SELL';
  return 'neutral';
}

function emaStructure(candles) {
  const closes = candles.map((c) => c.close);
  const e50 = ema(closes, 50), e200 = ema(closes, 200);
  if (!e50.length || !e200.length) return 'neutral';
  const price = closes[closes.length - 1], f50 = e50[e50.length - 1], f200 = e200[e200.length - 1];
  if (price > f50 && f50 > f200) return 'BUY';
  if (price < f50 && f50 < f200) return 'SELL';
  return 'neutral';
}

function volumeConfirmed(candles, mult = 1.3) {
  if (candles.length < 21) return false;
  const avg  = sma(candles.slice(-21, -1).map((c) => c.volume), 20);
  const last = candles[candles.length - 1].volume;
  return avg ? last >= avg * mult : false;
}

function atrValid(atrValue, price) {
  if (!atrValue || !price) return false;
  const pct = (atrValue / price) * 100;
  return pct >= 0.15 && pct <= 6;
}

function rsiConfirmed(value, direction) {
  if (value === null || value === undefined) return false;
  return direction === 'BUY' ? (value > 30 && value < 65) : (value > 35 && value < 70);
}

function macdConfirmed(macdData, direction) {
  if (!macdData) return false;
  const { macd: m, signal, hist } = macdData.latest;
  const momentumUp = hist > macdData.prevHist;
  if (direction === 'BUY')  return m > signal && hist > 0 && momentumUp;
  if (direction === 'SELL') return m < signal && hist < 0 && !momentumUp;
  return false;
}

function srConfirmed(sr, price, direction) {
  if (!sr || (sr.support === null && sr.resistance === null)) return false;
  const tolerance = price * 0.006;
  if (direction === 'BUY') {
    if (sr.support !== null && Math.abs(price - sr.support) <= tolerance) return true;
    if (sr.resistance !== null && price > sr.resistance && (price - sr.resistance) <= tolerance * 2) return true;
    return false;
  }
  if (sr.resistance !== null && Math.abs(price - sr.resistance) <= tolerance) return true;
  if (sr.support !== null && price < sr.support && (sr.support - price) <= tolerance * 2) return true;
  return false;
}

// ════════════════════════════════════════════════════════════════════════════
// CONFIRMATION EVALUATION
// ════════════════════════════════════════════════════════════════════════════

function evaluateDirection(direction, { candles4h, candles1h, candles15m }) {
  const closes4h  = candles4h.map((c) => c.close);
  const closes1h  = candles1h.map((c) => c.close);
  const closes15m = candles15m.map((c) => c.close);
  const price     = closes15m[closes15m.length - 1];

  const trend4h = trendDirection(closes4h), trend1h = trendDirection(closes1h);
  const trendOk = trend4h === direction && trend1h === direction;
  const emaTrendOk = emaStructure(candles1h) === direction;
  const macdData   = macd(closes15m);
  const macdOk     = macdConfirmed(macdData, direction);
  const rsiValue   = rsi(closes15m);
  const rsiOk      = rsiConfirmed(rsiValue, direction);
  const volOk      = volumeConfirmed(candles15m);
  const atrValue   = atr(candles15m);
  const atrOk      = atrValid(atrValue, price);
  const sr         = supportResistance(candles15m);
  const srOk       = srConfirmed(sr, price, direction);
  const candle     = candlePattern(candles15m);
  const candleOk   = direction === 'BUY' ? candle.bullish : candle.bearish;

  const confirmations = {
    trend: trendOk, ema_trend: emaTrendOk, macd: macdOk, rsi: rsiOk,
    volume: volOk, atr: atrOk, support_resistance: srOk, candle: candleOk,
  };

  let score = 0;
  for (const [key, weight] of Object.entries(CONFIRMATION_WEIGHTS)) if (confirmations[key]) score += weight;
  const allConfirmed = Object.values(confirmations).every(Boolean);

  return { direction, price, score, allConfirmed, confirmations, atrValue, rsiValue, macdData, sr, candle };
}

/**
 * Requirement 6 — builds a human-readable rejection reason string
 * listing every failing confirmation by name.
 */
function buildRejectionReason(confirmations, score) {
  const failing = [];
  const labels = {
    trend:             'Multi-timeframe trend mismatch',
    ema_trend:         'EMA structure not aligned',
    macd:              'MACD confirmation failed',
    rsi:               'RSI out of confirming zone',
    volume:            'Volume too low',
    atr:               'ATR volatility out of range',
    support_resistance:'No key S/R level near price',
    candle:            'No confirming candle pattern',
  };
  for (const [k, ok] of Object.entries(confirmations)) if (!ok) failing.push(labels[k] || k);
  if (score < SNIPER_MIN_SCORE) failing.push(`Confidence below ${SNIPER_MIN_SCORE}% (got ${score}%)`);
  return failing.length ? failing.join(' | ') : 'Score below threshold';
}

/**
 * Full sniper analysis for one symbol. Returns { tradable, ... }.
 * When tradable is false, always includes rejection_reason for requirement 6.
 */
function analyze(symbol, marketType, { candles4h, candles1h, candles15m }) {
  if (candles4h.length < 60 || candles1h.length < 210 || candles15m.length < 60) {
    return { tradable: false, symbol, marketType, score: 0, rejection_reason: 'Insufficient candle data', confirmations: {} };
  }

  const buy  = evaluateDirection('BUY',  { candles4h, candles1h, candles15m });
  const sell = evaluateDirection('SELL', { candles4h, candles1h, candles15m });
  const best = buy.score >= sell.score ? buy : sell;

  if (!best.allConfirmed || best.score < SNIPER_MIN_SCORE) {
    return {
      tradable: false, symbol, marketType,
      score: best.score, confirmations: best.confirmations,
      rejection_reason: buildRejectionReason(best.confirmations, best.score),
    };
  }

  const price  = best.price;
  const slDist = best.atrValue * SL_ATR_MULT;
  const tpDist = best.atrValue * TP_ATR_MULT;
  const sl     = best.direction === 'BUY' ? price - slDist : price + slDist;
  const tp     = best.direction === 'BUY' ? price + tpDist : price - tpDist;
  const rr     = slDist > 0 ? tpDist / slDist : 0;

  if (rr < MIN_RR) {
    return {
      tradable: false, symbol, marketType, score: best.score, confirmations: best.confirmations,
      rejection_reason: `Risk/reward ratio too low (${rr.toFixed(2)} < ${MIN_RR})`,
    };
  }

  return {
    tradable: true, symbol, marketType,
    signal: best.direction, entry: price, sl, tp, rr: rr.toFixed(2),
    score: best.score,
    grade: best.score >= SNIPER_ELITE_SCORE ? 'ELITE_SNIPER' : 'SNIPER',
    confirmations: best.confirmations,
    atr: best.atrValue,
    rejection_reason: null,
  };
}

module.exports = {
  analyze, evaluateDirection, buildRejectionReason,
  parseKlines, ema, sma, rsi, atr, macd,
  supportResistance, candlePattern, trendDirection, emaStructure,
  volumeConfirmed, atrValid, rsiConfirmed, macdConfirmed, srConfirmed,
};
