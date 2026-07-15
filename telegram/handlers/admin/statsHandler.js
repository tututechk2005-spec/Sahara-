'use strict';
const adminStatsService = require('../../../services/adminStatsService');
const { config } = require('../../../config');

function isAdmin(ctx) { return String(ctx.from.id) === String(config.bot.adminChatId); }
function safeAnswer(ctx) { try { return ctx.answerCbQuery(); } catch { /* ignore */ } }
async function renderText(ctx, text, extra) {
  try { return await ctx.editMessageText(text, { parse_mode: 'Markdown', ...extra }); }
  catch { return ctx.reply(text, { parse_mode: 'Markdown', ...extra }); }
}

function fmtUSDT(n) { return `$${Number(n || 0).toFixed(4)} USDT`; }

const statsHandler = {
  async show(ctx) {
    if (!isAdmin(ctx)) return;
    await safeAnswer(ctx);
    const s = adminStatsService.getFullStats();

    const text =
      `📊 *Admin Statistics*\n\n` +
      `👥 *Users*\n` +
      `Total: ${s.totalUsers} | Premium: ${s.premiumUsers} | Trial: ${s.trialUsers} | Free: ${s.freeUsers}\n` +
      `Auto-trading: ${s.activeTrading} | Banned: ${s.bannedUsers}\n\n` +
      `🔌 *APIs*\n` +
      `Connected: ${s.connectedApis} | Disconnected: ${s.disconnectedApis} | Errors: ${s.apiErrors}\n\n` +
      `📈 *Trades*\n` +
      `Total: ${s.totalTrades} (Bot: ${s.botTrades} | Manual: ${s.manualTrades})\n` +
      `Open: ${s.openTrades} | Closed: ${s.closedTrades}\n` +
      `Wins: ${s.winningTrades} | Losses: ${s.losingTrades} | Win Rate: ${s.winRate}%\n` +
      `Avg Win: ${fmtUSDT(s.avgWin)} | Avg Loss: ${fmtUSDT(s.avgLoss)}\n\n` +
      `💰 *Profit*\n` +
      `Today: ${fmtUSDT(s.dailyProfit)} | Week: ${fmtUSDT(s.weeklyProfit)}\n` +
      `Month: ${fmtUSDT(s.monthlyProfit)} | Year: ${fmtUSDT(s.yearlyProfit)}\n\n` +
      `🎯 *Signals*\n` +
      `Generated: ${s.signalsGenerated} | Accepted: ${s.signalsAccepted} | Rejected: ${s.signalsRejected}\n\n` +
      `🔥 *Best Pair:* ${s.bestPair}  |  ❄️ *Worst:* ${s.worstPair}\n` +
      `📊 *Most Traded:* ${s.mostTradedPair}\n\n` +
      `⚙️ *System*\n` +
      `Uptime: ${s.uptimeHuman} | DB: ${s.dbSizeKB}KB\n` +
      `CPU: ${s.cpuPercent}% | RAM: ${s.ramUsageMB}MB\n` +
      `Scheduler: ${s.schedulerStatus}`;

    return renderText(ctx, text, { reply_markup: { inline_keyboard: [
      [{ text: '🔄 Refresh', callback_data: 'admin_stats' }],
      [{ text: '📜 Signal Rejections', callback_data: 'admin_signal_rejections' }],
      [{ text: '⬅️ Admin Panel', callback_data: 'admin_panel' }],
    ]}});
  },

  async signalRejections(ctx) {
    if (!isAdmin(ctx)) return;
    await safeAnswer(ctx);
    const rejected = require('../../../db').signals.rejectedRecent(15);
    if (!rejected.length) {
      return renderText(ctx, '✅ No rejected signals recently.', { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'admin_stats' }]] }});
    }
    const lines = rejected.map((s) =>
      `• *${s.symbol}* (${s.market_type}) — Score: ${s.score}\n  ↳ _{${s.rejection_reason}}_`
    ).join('\n\n').slice(0, 3500);
    return renderText(ctx, `🚫 *Signal Rejections* (recent ${rejected.length})\n\n${lines}`, {
      reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'admin_stats' }]] },
    });
  },
};

module.exports = statsHandler;
