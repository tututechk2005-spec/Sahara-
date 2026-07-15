'use strict';
const db = require('../../db');
const keyboards = require('../keyboards');
const { fmtNum, fmtSigned, fmtPct } = require('../../lib/utils');

function safeAnswer(ctx) { try { return ctx.answerCbQuery(); } catch { /* ignore */ } }
async function renderText(ctx, text, extra) {
  try { return await ctx.editMessageText(text, { parse_mode: 'Markdown', ...extra }); }
  catch { return ctx.reply(text, { parse_mode: 'Markdown', ...extra }); }
}

function statusEmoji(status) {
  return { ACTIVE: '🔵', WIN: '✅', LOSS: '❌', BREAKEVEN: '➖', CANCELLED: '🚫' }[status] || '❓';
}

function historyPage(records, page = 0, pageSize = 5) {
  const total  = records.length;
  const pages  = Math.ceil(total / pageSize) || 1;
  const slice  = records.slice(page * pageSize, (page + 1) * pageSize);
  return { slice, total, pages, page };
}

function buildHistoryText(record) {
  const e = statusEmoji(record.status);
  const pnl = record.final_profit !== null ? record.final_profit : (record.current_profit || 0);
  return (
    `${e} *${record.symbol}* ${record.side} [${record.status}]\n` +
    `Market: ${record.market_type.toUpperCase()} | ${record.source === 'manual' ? '🔍 Manual' : '🤖 Bot'}\n` +
    `Entry: ${fmtNum(record.entry_price, 6)}${record.exit_price ? `  Exit: ${fmtNum(record.exit_price, 6)}` : ''}\n` +
    `Qty: ${record.quantity}  Lev: ${record.leverage}x  Margin: $${fmtNum(record.margin, 2)}\n` +
    `SL: ${record.stop_loss ? fmtNum(record.stop_loss, 6) : '—'}  TP: ${record.take_profit ? fmtNum(record.take_profit, 6) : '—'}\n` +
    `Open: ${record.open_time ? new Date(record.open_time).toLocaleString() : '—'}\n` +
    `${record.close_time ? `Close: ${new Date(record.close_time).toLocaleString()}  Duration: ${record.duration}\n` : ''}` +
    `PNL: *${fmtSigned(pnl, 4)} USDT*  ROI: ${fmtPct(record.roi_pct)}`
  );
}

const tradeHistoryHandler = {
  async show(ctx, page = 0) {
    await safeAnswer(ctx);
    const userId  = ctx.from.id;
    const records = db.trades.historyForUser(userId, 200);
    if (!records.length) {
      return renderText(ctx, '📋 *Trade History*\n\nNo trades yet.', keyboards.backTo('main_menu'));
    }
    const { slice, total, pages, page: pg } = historyPage(records, page);

    const lines = slice.map((r, i) => {
      const e = statusEmoji(r.status);
      const pnl = r.final_profit !== null ? r.final_profit : (r.current_profit || 0);
      return `${e} *${r.symbol}* ${r.side} — ${fmtSigned(pnl, 4)} USDT (${r.status})`;
    }).join('\n');

    const text = `📋 *Trade History* (${total} trades)\nPage ${pg + 1}/${pages}\n\n${lines}`;
    const navRow = [];
    if (pg > 0)        navRow.push({ text: '⬅️ Prev', callback_data: `history_page_${pg - 1}` });
    if (pg < pages - 1) navRow.push({ text: 'Next ➡️', callback_data: `history_page_${pg + 1}` });
    const keyboard = { reply_markup: { inline_keyboard: [
      ...slice.map((r, i) => [{ text: `${statusEmoji(r.status)} ${r.symbol} ${r.side}`, callback_data: `history_trade_${r.trade_id}` }]),
      ...(navRow.length ? [navRow] : []),
      [{ text: '⬅️ Main Menu', callback_data: 'main_menu' }],
    ]}};
    return renderText(ctx, text, keyboard);
  },

  async viewOne(ctx, tradeId) {
    await safeAnswer(ctx);
    const trade  = db.trades.findById(tradeId);
    if (!trade) return renderText(ctx, '⚠️ Trade not found.', keyboards.backTo('trade_history'));
    const record = db.trades.toHistoryRecord(trade);
    return renderText(ctx, buildHistoryText(record), keyboards.backTo('trade_history'));
  },
};

module.exports = tradeHistoryHandler;
