'use strict';
const db = require('../../../db');
const { config, LOG_LEVELS_UI } = require('../../../config');

function isAdmin(ctx) { return String(ctx.from.id) === String(config.bot.adminChatId); }
function safeAnswer(ctx) { try { return ctx.answerCbQuery(); } catch { /* ignore */ } }
async function renderText(ctx, text, extra) {
  try { return await ctx.editMessageText(text, { parse_mode: 'Markdown', ...extra }); }
  catch { return ctx.reply(text, { parse_mode: 'Markdown', ...extra }); }
}

function levelBadge(level) {
  return { INFO: 'ℹ️', SUCCESS: '✅', WARNING: '⚠️', ERROR: '❌' }[level] || '•';
}

function formatLogLine(entry) {
  const ts   = new Date(entry.ts).toLocaleTimeString();
  const badge = levelBadge(entry.level);
  const user  = entry.user ? ` [u:${entry.user}]` : '';
  const pair  = entry.pair ? ` ${entry.pair}` : '';
  return `${badge} \`${ts}\` *${entry.module}*${user}${pair}: ${entry.message}`;
}

const logsHandler = {
  async show(ctx, filter = null) {
    if (!isAdmin(ctx)) return;
    await safeAnswer(ctx);
    let logs = db.botLogs.recent(50);
    if (filter) logs = logs.filter((l) => l.level === filter);
    if (!logs.length) return renderText(ctx, '📜 *Bot Logs*\n\nNo logs yet.', { reply_markup: { inline_keyboard: [[{ text: '⬅️ Admin Panel', callback_data: 'admin_panel' }]] }});

    // Telegram message limit = 4096 chars; slice to fit
    const lines = logs.slice(0, 30).map(formatLogLine).join('\n');
    const text = `📜 *Bot Logs* (live — ${logs.length} entries)\n\n${lines}`.slice(0, 3900);

    return renderText(ctx, text, { reply_markup: { inline_keyboard: [
      [
        { text: '🔄 Refresh', callback_data: 'admin_logs' },
        { text: '⚠️ Warnings', callback_data: 'logs_filter_WARNING' },
      ],
      [
        { text: '❌ Errors',   callback_data: 'logs_filter_ERROR' },
        { text: '✅ Success',  callback_data: 'logs_filter_SUCCESS' },
      ],
      [{ text: '🗑 Clear Logs', callback_data: 'logs_clear' }],
      [{ text: '⬅️ Admin Panel', callback_data: 'admin_panel' }],
    ]}});
  },

  async clear(ctx) {
    if (!isAdmin(ctx)) return;
    await safeAnswer(ctx);
    db.botLogs.clear();
    return logsHandler.show(ctx);
  },
};

module.exports = logsHandler;
