'use strict';
const db = require('../../../db');
const { LOG_LEVELS_UI } = require('../../../config');
const Markup = require('telegraf').Markup;

function safeAnswer(ctx) { try { return ctx.answerCbQuery(); } catch {} }
async function renderText(ctx, text, extra) {
  try { return await ctx.editMessageText(text, { parse_mode: 'Markdown', ...extra }); }
  catch { return ctx.reply(text, { parse_mode: 'Markdown', ...extra }); }
}

const BADGE = {
  [LOG_LEVELS_UI.INFO]:    'ℹ️',
  [LOG_LEVELS_UI.SUCCESS]: '✅',
  [LOG_LEVELS_UI.WARNING]: '⚠️',
  [LOG_LEVELS_UI.ERROR]:   '❌',
};

function formatEntry(e) {
  const time = e.ts ? new Date(e.ts).toLocaleTimeString() : '—';
  const badge = BADGE[e.level] || '⚪';
  const user  = e.user_id ? ` [u:${e.user_id}]` : '';
  const pair  = e.pair ? ` [${e.pair}]` : '';
  return `${badge} \`${time}\` *${e.module}*${user}${pair}\n   ${e.message}${e.detail ? `\n   _${e.detail}_` : ''}`;
}

const adminLogsHandler = {
  async show(ctx, level = null) {
    await safeAnswer(ctx);
    const entries = level
      ? db.botLogs.filterByLevel(level, 25)
      : db.botLogs.recent(25);

    const lines = entries.length
      ? entries.map(formatEntry).join('\n\n')
      : '_No logs yet._';

    const filterRow = [
      Markup.button.callback('✅ Success', 'logs_filter_SUCCESS'),
      Markup.button.callback('⚠️ Warn',    'logs_filter_WARNING'),
      Markup.button.callback('❌ Error',   'logs_filter_ERROR'),
    ];
    const navRow = [
      Markup.button.callback('🔄 Refresh', level ? `logs_filter_${level}` : 'admin_logs'),
      Markup.button.callback('🗑 Clear',   'admin_logs_clear'),
      Markup.button.callback('⬅️ Admin',  'admin_panel'),
    ];

    return renderText(ctx, `📜 *Live Bot Logs* (last 25${level ? ` — ${level}` : ''})\n\n${lines}`,
      Markup.inlineKeyboard([filterRow, navRow])
    );
  },

  async clear(ctx) {
    await safeAnswer(ctx);
    db.botLogs.clear();
    return adminLogsHandler.show(ctx);
  },
};

module.exports = adminLogsHandler;
