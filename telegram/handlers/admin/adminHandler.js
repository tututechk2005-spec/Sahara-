'use strict';
const db = require('../../../db');
const logger = require('../../../lib/logger');
const keyboards = require('../../keyboards');
const sessionManager = require('../../sessionManager');
const { config } = require('../../../config');

function isAdmin(ctx) { return String(ctx.from.id) === String(config.bot.adminChatId); }
function safeAnswer(ctx, text) { try { return ctx.answerCbQuery(text); } catch { /* ignore */ } }
async function renderText(ctx, text, extra) {
  try { return await ctx.editMessageText(text, { parse_mode: 'Markdown', ...extra }); }
  catch { return ctx.reply(text, { parse_mode: 'Markdown', ...extra }); }
}
function guard(ctx) {
  if (!isAdmin(ctx)) { safeAnswer(ctx, '⛔ Admins only'); return false; }
  return true;
}

const adminHandler = {
  async panel(ctx) {
    if (!guard(ctx)) return;
    await safeAnswer(ctx);
    return renderText(ctx, '🛠 *Admin Panel*\n\nSelect a section:', keyboards.adminPanel());
  },

  async users(ctx) {
    if (!guard(ctx)) return;
    await safeAnswer(ctx);
    const total   = db.users.count();
    const premium = db.users.countPremium();
    const free    = db.users.countFree();
    const active  = db.users.countActive();
    const banned  = db.users.countBanned();
    const connectedSlots = db.accounts.countConnectedSlots();

    const text =
      `👥 *Users*\n\n` +
      `Total: *${total}*\n` +
      `Premium: *${premium}*\n` +
      `Free: *${free}*\n` +
      `Auto-trading enabled: *${active}*\n` +
      `Banned: *${banned}*\n` +
      `Connected Binance accounts: *${connectedSlots}*\n\n` +
      `Active today: *${db.users.countActiveToday()}*`;
    return renderText(ctx, text, keyboards.backTo('admin_panel'));
  },

  async revenue(ctx) {
    if (!guard(ctx)) return;
    await safeAnswer(ctx);
    const todayStats = db.trades.todayStats();
    const monthStats = db.trades.monthStats();
    const total = db.trades.totalProfit();
    const text =
      `💰 *Revenue / Performance*\n\n` +
      `Total realized PNL (all users): *${total}* USDT\n\n` +
      `Today: ${todayStats.total} trades, ${todayStats.wins}W/${todayStats.losses}L, PNL: ${todayStats.pnl.toFixed(4)}\n` +
      `This month: ${monthStats.total} trades, ${monthStats.wins}W/${monthStats.losses}L, PNL: ${monthStats.pnl.toFixed(4)}\n\n` +
      `Total signals generated: *${db.signals.count()}*\n` +
      `Total trades: *${db.trades.count()}* (open: ${db.trades.countOpen()})\n` +
      `Total referrals: *${db.referrals.count()}*`;
    return renderText(ctx, text, keyboards.backTo('admin_panel'));
  },

  async startBroadcast(ctx) {
    if (!guard(ctx)) return;
    await safeAnswer(ctx);
    sessionManager.set(ctx.from.id, { flow: 'admin_broadcast', step: 'await_message' });
    return renderText(ctx, '📢 *Broadcast*\n\nSend the message you want to broadcast to all users. Send /cancel to abort.', keyboards.backTo('admin_panel'));
  },

  async channelSettings(ctx) {
    if (!guard(ctx)) return;
    await safeAnswer(ctx);
    const channel = db.channel.get();
    sessionManager.set(ctx.from.id, { flow: 'admin_channel', step: 'await_channel_id' });
    return renderText(ctx,
      `📡 *Channel Settings*\n\nCurrent channel: \`${channel.channel_id || 'not set'}\`\nEnabled: ${channel.enabled ? '✅' : '❌'}\n\nSend the new channel ID (e.g. -1001234567890), or /cancel.`,
      keyboards.backTo('admin_panel'));
  },

  async paymentSettings(ctx) {
    if (!guard(ctx)) return;
    await safeAnswer(ctx);
    const payment = db.payment.get();
    const text =
      `💳 *Payment Settings*\n\n` +
      `Daily: $${payment.daily_price}\nWeekly: $${payment.weekly_price}\nMonthly: $${payment.monthly_price}\nLifetime: $${payment.lifetime_price}\n` +
      `Admin contact: @${payment.admin_username || 'not set'}\n\n` +
      `To update, send: \`/setprice daily 2.99\` (or weekly/monthly/lifetime)`;
    return renderText(ctx, text, keyboards.backTo('admin_panel'));
  },

  async helpSettings(ctx) {
    if (!guard(ctx)) return;
    await safeAnswer(ctx);
    sessionManager.set(ctx.from.id, { flow: 'admin_help', step: 'await_message' });
    return renderText(ctx, '❓ *Help Settings*\n\nSend the new help message text shown to users, or /cancel.', keyboards.backTo('admin_panel'));
  },

  async settings(ctx) {
    if (!guard(ctx)) return;
    await safeAnswer(ctx);
    const settings = db.settings.get();
    const text =
      `⚙️ *Bot Settings*\n\n` +
      `Scan interval: ${settings.scan_interval}s\n` +
      `Maintenance mode: ${settings.maintenance ? '🔴 ON' : '🟢 OFF'}\n\n` +
      `Strategy: Sniper-only (8 confirmations, no recovery mode, no trade limit)`;
    return renderText(ctx, text, keyboards.backTo('admin_panel'));
  },

  async logs(ctx) {
    if (!guard(ctx)) return;
    await safeAnswer(ctx);
    const lines = logger.recentLines(30);
    const text = `📜 *Recent Logs*\n\n\`\`\`\n${lines.join('\n').slice(-3500)}\n\`\`\``;
    return renderText(ctx, text, keyboards.backTo('admin_panel'));
  },

  /** Routes free-text admin messages while in an admin session flow. Returns true if handled. */
  async handleTextInput(ctx) {
    const userId = ctx.from.id;
    if (!isAdmin(ctx)) return false;
    const session = sessionManager.get(userId);
    if (!session || !session.flow?.startsWith('admin_')) return false;

    const text = (ctx.message.text || '').trim();
    if (text === '/cancel') { sessionManager.clear(userId); await ctx.reply('❌ Cancelled.'); return true; }

    if (session.flow === 'admin_broadcast') {
      sessionManager.clear(userId);
      const users = db.users.getAll();
      let sent = 0, failed = 0;
      const statusMsg = await ctx.reply(`📢 Broadcasting to ${users.length} users...`);
      for (const u of users) {
        try { await ctx.telegram.sendMessage(u.telegram_id, text); sent++; }
        catch { failed++; }
        await new Promise((r) => setTimeout(r, 35)); // gentle throttle, avoid Telegram flood limits
      }
      try { await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, `📢 Broadcast complete.\n\n✅ Sent: ${sent}\n❌ Failed: ${failed}`); }
      catch { /* ignore */ }
      return true;
    }

    if (session.flow === 'admin_channel') {
      sessionManager.clear(userId);
      await db.channel.update({ channel_id: text, enabled: true });
      await ctx.reply(`✅ Channel set to \`${text}\` and enabled.`, { parse_mode: 'Markdown' });
      return true;
    }

    if (session.flow === 'admin_help') {
      sessionManager.clear(userId);
      await db.help.update({ help_message: text });
      await ctx.reply('✅ Help message updated.');
      return true;
    }

    return false;
  },

  async handleSetPriceCommand(ctx) {
    if (!isAdmin(ctx)) return;
    const parts = (ctx.message.text || '').trim().split(/\s+/);
    if (parts.length !== 3) return ctx.reply('Usage: /setprice <daily|weekly|monthly|lifetime> <amount>');
    const [, plan, amountStr] = parts;
    const amount = parseFloat(amountStr);
    const validPlans = ['daily', 'weekly', 'monthly', 'lifetime'];
    if (!validPlans.includes(plan) || !Number.isFinite(amount) || amount < 0) {
      return ctx.reply('⚠️ Invalid plan or amount. Usage: /setprice <daily|weekly|monthly|lifetime> <amount>');
    }
    await db.payment.update({ [`${plan}_price`]: amount });
    return ctx.reply(`✅ ${plan} price set to $${amount}`);
  },
};

module.exports = adminHandler;
