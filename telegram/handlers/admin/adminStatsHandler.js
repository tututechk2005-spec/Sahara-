'use strict';
const os = require('os');
const fs = require('fs');
const db = require('../../../db');
const { fmtNum } = require('../../../lib/utils');
const { config } = require('../../../config');

const Markup = require('telegraf').Markup;

function safeAnswer(ctx) { try { return ctx.answerCbQuery(); } catch {} }
async function renderText(ctx, text, extra) {
  try { return await ctx.editMessageText(text, { parse_mode: 'Markdown', ...extra }); }
  catch { return ctx.reply(text, { parse_mode: 'Markdown', ...extra }); }
}

function cpuUsage() {
  try {
    const cpus = os.cpus();
    const usage = cpus.map((c) => {
      const t = Object.values(c.times).reduce((a, b) => a + b, 0);
      return ((1 - c.times.idle / t) * 100).toFixed(1);
    });
    return (usage.reduce((a, b) => a + parseFloat(b), 0) / usage.length).toFixed(1) + '%';
  } catch { return 'N/A'; }
}

function ramUsage() {
  try {
    const used = (os.totalmem() - os.freemem()) / 1024 / 1024;
    const total = os.totalmem() / 1024 / 1024;
    return `${used.toFixed(0)}MB / ${total.toFixed(0)}MB`;
  } catch { return 'N/A'; }
}

function dbSize() {
  try {
    const dataDir = config.paths.dataDir || './data';
    const files = fs.readdirSync(dataDir).filter((f) => f.endsWith('.json'));
    const bytes = files.reduce((s, f) => {
      try { return s + fs.statSync(`${dataDir}/${f}`).size; } catch { return s; }
    }, 0);
    return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  } catch { return 'N/A'; }
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

const adminStatsHandler = {
  async show(ctx) {
    await safeAnswer(ctx);

    const today    = db.trades.todayStats();
    const week     = db.trades.weekStats();
    const month    = db.trades.monthStats();
    const year     = db.trades.yearStats();
    const allSigs  = db.signals.getAll();
    const allTrades = db.trades.getAll();
    const closed   = allTrades.filter((t) => t.status === 'closed');
    const wins     = closed.filter((t) => t.result === 'WIN').length;
    const losses   = closed.filter((t) => t.result === 'LOSS').length;
    const winRate  = closed.length ? ((wins / closed.length) * 100).toFixed(1) : '0.0';
    const avgWin   = wins   ? (closed.filter((t) => t.result === 'WIN').reduce((s, t)  => s + t.profit, 0) / wins).toFixed(4)   : '0';
    const avgLoss  = losses ? (closed.filter((t) => t.result === 'LOSS').reduce((s, t) => s + Math.abs(t.profit), 0) / losses).toFixed(4) : '0';
    const { best, worst } = db.trades.pairPerformance();
    const mostTraded = db.trades.mostTradedPair();
    const apiErrs = (db.apiErrors.getAll() || []).length;

    const text =
      `📊 *Bot Statistics*\n\n` +
      `👥 *Users*\n` +
      `• Total: ${db.users.count()}\n` +
      `• Premium: ${db.users.countPremium()}\n` +
      `• Trial: ${db.users.countTrial()}\n` +
      `• Free: ${db.users.countFree()}\n\n` +
      `📈 *Trades*\n` +
      `• Total: ${db.trades.count()}\n` +
      `• Bot: ${db.trades.countBotOpened()}\n` +
      `• Manual: ${db.trades.countManual()}\n` +
      `• Open: ${db.trades.countOpen()}\n` +
      `• Closed: ${db.trades.countClosed()}\n` +
      `• Wins: ${wins}  Losses: ${losses}\n` +
      `• Win Rate: ${winRate}%\n` +
      `• Avg Win: +${avgWin} USDT\n` +
      `• Avg Loss: -${avgLoss} USDT\n\n` +
      `💰 *PnL*\n` +
      `• Today: ${today.pnl >= 0 ? '+' : ''}${today.pnl.toFixed(4)} USDT\n` +
      `• Weekly: ${week.pnl >= 0 ? '+' : ''}${week.pnl.toFixed(4)} USDT\n` +
      `• Monthly: ${month.pnl >= 0 ? '+' : ''}${month.pnl.toFixed(4)} USDT\n` +
      `• Yearly: ${year.pnl >= 0 ? '+' : ''}${year.pnl.toFixed(4)} USDT\n\n` +
      `🎯 *Signals*\n` +
      `• Generated: ${db.signals.count()}\n` +
      `• Accepted: ${db.signals.countAccepted()}\n` +
      `• Rejected: ${db.signals.countRejected()}\n` +
      `• Today: ${db.signals.todayCount()}\n\n` +
      `🏆 *Pairs*\n` +
      `• Most Traded: ${mostTraded ? `${mostTraded.symbol} (${mostTraded.count})` : '—'}\n` +
      `• Best: ${best ? `${best.symbol} +${best.pnl}` : '—'}\n` +
      `• Worst: ${worst ? `${worst.symbol} ${worst.pnl}` : '—'}\n\n` +
      `⚙️ *System*\n` +
      `• Uptime: ${formatUptime(process.uptime())}\n` +
      `• DB Size: ${dbSize()}\n` +
      `• API Errors: ${apiErrs}\n` +
      `• CPU: ${cpuUsage()}\n` +
      `• RAM: ${ramUsage()}\n` +
      `• Scheduler: 🟢 Running\n` +
      `• Bot Logs: ${db.botLogs.count()} entries`;

    return renderText(ctx, text, Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Refresh', 'admin_statistics')],
      [Markup.button.callback('⬅️ Admin Panel', 'admin_panel')],
    ]));
  },
};

module.exports = adminStatsHandler;
