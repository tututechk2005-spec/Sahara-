'use strict';
const os   = require('os');
const fs   = require('fs');
const db   = require('../db');
const { config } = require('../config');

const startTime = Date.now();

function dbSizeBytes() {
  let total = 0;
  for (const p of Object.values(config.paths)) {
    try {
      if (typeof p === 'string' && fs.existsSync(p)) total += fs.statSync(p).size;
    } catch { /* ignore */ }
  }
  return total;
}

function cpuPercent() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const cpu of cpus) {
    for (const type of Object.keys(cpu.times)) total += cpu.times[type];
    idle += cpu.times.idle;
  }
  return parseFloat(((1 - idle / total) * 100).toFixed(1));
}

function ramUsageMB() {
  const used = process.memoryUsage().rss;
  return parseFloat((used / 1024 / 1024).toFixed(1));
}

function uptimeSeconds() {
  return Math.floor((Date.now() - startTime) / 1000);
}

const adminStatsService = {
  getFullStats() {
    const todayT  = db.trades.todayStats();
    const weekT   = db.trades.weekStats();
    const monthT  = db.trades.monthStats();
    const yearT   = db.trades.yearStats();
    const allClosedT = db.trades.getAll().filter((t) => t.status === 'closed');
    const wins    = allClosedT.filter((t) => t.result === 'WIN').length;
    const losses  = allClosedT.filter((t) => t.result === 'LOSS').length;
    const totalClosed = allClosedT.length;
    const winRate = totalClosed > 0 ? parseFloat(((wins / totalClosed) * 100).toFixed(1)) : 0;
    const avgWin  = wins > 0
      ? parseFloat((allClosedT.filter((t) => t.result === 'WIN').reduce((s, t) => s + t.profit, 0) / wins).toFixed(4))
      : 0;
    const avgLoss = losses > 0
      ? parseFloat((Math.abs(allClosedT.filter((t) => t.result === 'LOSS').reduce((s, t) => s + t.profit, 0)) / losses).toFixed(4))
      : 0;

    const pairPerf = db.trades.pairPerformance();
    const mostTraded = db.trades.mostTradedPair();

    const connectedSlots = db.accounts.countConnectedSlots();
    const totalSlotsPossible = db.users.count() * 4;
    const disconnectedSlots = Math.max(0, totalSlotsPossible - connectedSlots);

    const dbSize  = dbSizeBytes();
    const apiErrors = db.apiErrors.getAll().length;

    return {
      // users
      totalUsers:      db.users.count(),
      premiumUsers:    db.users.countPremium(),
      trialUsers:      db.users.countTrial(),
      freeUsers:       db.users.countFree(),
      bannedUsers:     db.users.countBanned(),
      activeTrading:   db.users.countActive(),

      // apis
      connectedApis:    connectedSlots,
      disconnectedApis: disconnectedSlots,
      apiErrors,

      // trades
      totalTrades:   db.trades.count(),
      botTrades:     db.trades.countBotOpened(),
      manualTrades:  db.trades.countManual(),
      openTrades:    db.trades.countOpen(),
      closedTrades:  db.trades.countClosed(),
      winningTrades: wins,
      losingTrades:  losses,
      winRate,
      avgWin,
      avgLoss,

      // profit
      dailyProfit:   parseFloat((todayT.pnl).toFixed(4)),
      weeklyProfit:  parseFloat((weekT.pnl).toFixed(4)),
      monthlyProfit: parseFloat((monthT.pnl).toFixed(4)),
      yearlyProfit:  parseFloat((yearT.pnl).toFixed(4)),
      totalProfit:   parseFloat(db.trades.totalProfit()),

      // signals
      signalsGenerated: db.signals.count(),
      signalsAccepted:  db.signals.countAccepted(),
      signalsRejected:  db.signals.countRejected(),

      // pairs
      mostTradedPair: mostTraded?.symbol || '—',
      bestPair:       pairPerf.best?.symbol  || '—',
      worstPair:      pairPerf.worst?.symbol || '—',

      // system
      uptimeSeconds:  uptimeSeconds(),
      uptimeHuman:    formatUptime(uptimeSeconds()),
      dbSizeKB:       parseFloat((dbSize / 1024).toFixed(1)),
      cpuPercent:     cpuPercent(),
      ramUsageMB:     ramUsageMB(),
      schedulerStatus: 'RUNNING',
      botLogs:         db.botLogs.count(),
      broadcasts:      db.broadcasts.getAll().length,
    };
  },
};

function formatUptime(secs) {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

module.exports = adminStatsService;
