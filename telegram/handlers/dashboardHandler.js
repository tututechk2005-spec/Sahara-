'use strict';
const db = require('../../db');
const keyboards = require('../keyboards');
const statisticsService = require('../../services/statisticsService');
const { fmtNum, fmtSigned, fmtPct } = require('../../lib/utils');

function safeAnswer(ctx) { try { return ctx.answerCbQuery(); } catch { /* ignore */ } }
async function renderText(ctx, text, extra) {
  try { return await ctx.editMessageText(text, { parse_mode: 'Markdown', ...extra }); }
  catch { return ctx.reply(text, { parse_mode: 'Markdown', ...extra }); }
}

function buildDashboardText(stats) {
  if (!stats.connected) {
    return `📊 *Dashboard*\n\nYou don't have an active Binance account connected.\n\nUse 🔄 Switch Account to connect one.`;
  }
  if (stats.error) {
    return `📊 *Dashboard* — ${stats.label}\n\n⚠️ Stats are temporarily unavailable (showing cached data may follow). Try refreshing in a moment.`;
  }

  const testnetTag = stats.testnet ? ' 🧪' : ' 💰';
  return (
    `📊 *Dashboard* — ${stats.label}${testnetTag}\n\n` +
    `💰 *Balance:* $${fmtNum(stats.balance, 2)}\n` +
    `📦 *Wallet Value:* $${fmtNum(stats.walletValue, 2)}\n` +
    `💵 *Available:* $${fmtNum(stats.availableBalance, 2)}\n` +
    `📈 *Open Positions:* ${stats.openPositions}\n` +
    `📋 *Open Orders:* ${stats.openOrders}\n` +
    `📊 *Unrealized PNL:* ${fmtSigned(stats.unrealizedPnl, 4)} USDT\n` +
    `🎯 *ROI:* ${fmtPct(stats.roi)}\n` +
    `🏆 *Win Rate:* ${fmtNum(stats.winRate, 1)}%\n` +
    `🔢 *Total Trades:* ${stats.totalTrades}\n` +
    `☀️ *Today's PNL:* ${fmtSigned(stats.dailyProfit, 4)} USDT\n` +
    `🗓 *Monthly PNL:* ${fmtSigned(stats.monthlyProfit, 4)} USDT\n` +
    `🪙 *Symbol:* ${stats.currentSymbol}\n` +
    `⚡ *Leverage:* ${stats.leverage}x\n` +
    `🔒 *Margin Used:* $${fmtNum(stats.marginUsed, 4)}\n\n` +
    `_Updated: ${new Date(stats.fetchedAt).toLocaleTimeString()}_`
  );
}

const dashboardHandler = {
  async show(ctx) {
    await safeAnswer(ctx);
    const userId = ctx.from.id;
    const stats  = await statisticsService.getLiveStats(userId);
    return renderText(ctx, buildDashboardText(stats), keyboards.dashboardMenu());
  },
};

module.exports = dashboardHandler;
