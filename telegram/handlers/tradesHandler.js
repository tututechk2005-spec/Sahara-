'use strict';
const db = require('../../db');
const keyboards = require('../keyboards');
const tradingEngine = require('../../services/tradingEngine');
const { fmtNum, fmtSigned, formatDuration } = require('../../lib/utils');

function safeAnswer(ctx, text) { try { return ctx.answerCbQuery(text); } catch { /* ignore */ } }
async function renderText(ctx, text, extra) {
  try { return await ctx.editMessageText(text, { parse_mode: 'Markdown', ...extra }); }
  catch { return ctx.reply(text, { parse_mode: 'Markdown', ...extra }); }
}

function tradeSummaryLine(t) {
  const emoji = t.side === 'BUY' ? '🟢' : '🔴';
  return `${emoji} *${t.symbol}* ${t.side} — ${fmtSigned(t.profit, 4)} USDT (${fmtSigned(t.profit_pct, 2)}%)`;
}

function tradeDetailText(t) {
  return (
    `${t.side === 'BUY' ? '🟢' : '🔴'} *${t.symbol}* ${t.side} (${t.market_type.toUpperCase()})\n\n` +
    `Entry: ${fmtNum(t.entry, 6)}\n` +
    `Current: ${fmtNum(t.current_price, 6)}\n` +
    `SL: ${t.sl ? fmtNum(t.sl, 6) : '—'}\n` +
    `TP: ${t.tp ? fmtNum(t.tp, 6) : '—'}\n` +
    `Quantity: ${t.quantity}\n` +
    `Leverage: ${t.leverage}x\n` +
    `PNL: ${fmtSigned(t.profit, 4)} USDT (${fmtSigned(t.profit_pct, 2)}%)\n` +
    `Opened: ${formatDuration(t.open_time)} ago\n` +
    `Score: ${t.score}/100`
  );
}

const tradesHandler = {
  async list(ctx) {
    await safeAnswer(ctx);
    const userId = ctx.from.id;
    const trades = db.trades.openForUser(userId);
    if (!trades.length) {
      return renderText(ctx, '📈 *Active Trades*\n\nNo open trades right now. The bot is scanning 24/7 for sniper-quality setups.', keyboards.backTo('main_menu'));
    }
    const lines = trades.map(tradeSummaryLine).join('\n');
    return renderText(ctx, `📈 *Active Trades* (${trades.length})\n\n${lines}\n\nTap a trade below to manage it.`, keyboards.activeTradesList(trades));
  },

  async view(ctx, tradeId) {
    await safeAnswer(ctx);
    const trade = db.trades.findById(tradeId);
    if (!trade || trade.status !== 'open') return renderText(ctx, '⚠️ This trade is no longer open.', keyboards.backTo('active_trades'));
    return renderText(ctx, tradeDetailText(trade), keyboards.tradeManagement(tradeId));
  },

  async moveToBreakeven(ctx, tradeId) {
    await safeAnswer(ctx, 'Moving stop loss...');
    const trade = db.trades.findById(tradeId);
    if (!trade || trade.status !== 'open') return renderText(ctx, '⚠️ Trade no longer open.', keyboards.backTo('active_trades'));
    await tradingEngine.moveStopLoss(trade, trade.entry);
    const updated = db.trades.findById(tradeId);
    return renderText(ctx, `✅ Stop loss moved to breakeven (${fmtNum(trade.entry, 6)}).\n\n${tradeDetailText(updated)}`, keyboards.tradeManagement(tradeId));
  },

  async closePartial(ctx, tradeId) {
    await safeAnswer(ctx, 'Closing 50%...');
    const trade = db.trades.findById(tradeId);
    if (!trade || trade.status !== 'open') return renderText(ctx, '⚠️ Trade no longer open.', keyboards.backTo('active_trades'));
    const result = await tradingEngine.closePartial(trade, 0.5);
    if (!result.closed) return renderText(ctx, `❌ Could not close partial position: ${result.error || result.reason}`, keyboards.tradeManagement(tradeId));
    return tradesHandler.list(ctx);
  },

  async close(ctx, tradeId) {
    await safeAnswer(ctx, 'Closing trade...');
    const trade = db.trades.findById(tradeId);
    if (!trade || trade.status !== 'open') return renderText(ctx, '⚠️ Trade no longer open.', keyboards.backTo('active_trades'));
    const result = await tradingEngine.closeTrade(trade, 'MANUAL');
    if (!result.closed) return renderText(ctx, `❌ Could not close trade: ${result.error || result.reason}`, keyboards.tradeManagement(tradeId));
    const emoji = result.result === 'WIN' ? '✅' : result.result === 'LOSS' ? '❌' : '➖';
    return renderText(ctx, `${emoji} *${trade.symbol}* closed — ${fmtSigned(result.profit, 4)} USDT (${result.result})`, keyboards.backTo('active_trades'));
  },
};

module.exports = tradesHandler;
