'use strict';
const db             = require('../../../db');
const premiumService = require('../../../services/premiumService');
const sessionManager = require('../../sessionManager');
const { config, PLAN_TYPES, PLAN_DURATIONS_DAYS } = require('../../../config');

function isAdmin(ctx) { return String(ctx.from.id) === String(config.bot.adminChatId); }
function safeAnswer(ctx, t) { try { return ctx.answerCbQuery(t); } catch { /* ignore */ } }
async function renderText(ctx, text, extra) {
  try { return await ctx.editMessageText(text, { parse_mode: 'Markdown', ...extra }); }
  catch { return ctx.reply(text, { parse_mode: 'Markdown', ...extra }); }
}

function backBtn(action = 'admin_premium') {
  return { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: action }]] }};
}

function planTag(u) {
  if (u.suspended)      return '🚫 Suspended';
  if (u.subscription !== 'active' || !u.plan) return '⚪ Free';
  if (u.plan === PLAN_TYPES.TRIAL)   return '🔔 Trial';
  if (u.plan === PLAN_TYPES.PREMIUM) return '👑 Premium';
  return u.plan;
}

function formatUser(u) {
  return (
    `👤 @${u.username || u.telegram_id} (${u.telegram_id})\n` +
    `Plan: ${planTag(u)}\n` +
    `Remaining: ${u.remaining_days} days\n` +
    (u.expiry ? `Expires: ${new Date(u.expiry).toLocaleDateString()}\n` : '') +
    (u.purchased_at ? `Purchased: ${new Date(u.purchased_at).toLocaleDateString()}\n` : '')
  );
}

const premiumHandler = {
  async panel(ctx) {
    if (!isAdmin(ctx)) return;
    await safeAnswer(ctx);
    return renderText(ctx, '👑 *Premium Management*\n\nSelect an action:', { reply_markup: { inline_keyboard: [
      [{ text: '➕ Add Premium', callback_data: 'pm_add' }, { text: '➕ Add Trial', callback_data: 'pm_add_trial' }],
      [{ text: '🔄 Renew', callback_data: 'pm_renew' }, { text: '🚫 Suspend', callback_data: 'pm_suspend' }],
      [{ text: '✅ Unsuspend', callback_data: 'pm_unsuspend' }, { text: '🗑 Remove', callback_data: 'pm_remove' }],
      [{ text: '🔍 Search User', callback_data: 'pm_search' }, { text: '📋 List Premium', callback_data: 'pm_list_premium' }],
      [{ text: '⬅️ Admin Panel', callback_data: 'admin_panel' }],
    ]}});
  },

  async list(ctx, planFilter) {
    if (!isAdmin(ctx)) return;
    await safeAnswer(ctx);
    const users = premiumService.getUserList(null, planFilter);
    if (!users.length) return renderText(ctx, '📋 No users found.', backBtn());
    const lines = users.slice(0, 20).map(formatUser).join('\n---\n').slice(0, 3500);
    return renderText(ctx, `📋 *${planFilter ? planFilter.toUpperCase() : 'All'} Users*\n\n${lines}`, backBtn());
  },

  async startFlow(ctx, action) {
    if (!isAdmin(ctx)) return;
    await safeAnswer(ctx);
    sessionManager.set(ctx.from.id, { flow: 'premium_mgmt', step: 'await_user', action });
    return renderText(ctx, `👤 Send the *Telegram User ID or @username* for action: \`${action}\`\nSend /cancel to abort.`,
      { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'admin_premium' }]] }});
  },

  async handleInput(ctx) {
    if (!isAdmin(ctx)) return false;
    const session = sessionManager.get(ctx.from.id);
    if (!session || session.flow !== 'premium_mgmt') return false;
    const text = (ctx.message.text || '').trim();
    if (text === '/cancel') { sessionManager.clear(ctx.from.id); await ctx.reply('❌ Cancelled.'); return true; }

    if (session.step === 'await_user') {
      const q = text.replace(/^@/, '');
      let user = db.users.findById(q) || db.users.findByUsername(q);
      if (!user) { await ctx.reply('⚠️ User not found. Check the ID or username.'); return true; }

      if (['add', 'add_trial', 'renew'].includes(session.action)) {
        session.targetId = user.telegram_id;
        session.step = 'await_days';
        sessionManager.set(ctx.from.id, session);
        await ctx.reply(`📅 How many days to add for @${user.username || user.telegram_id}?`);
        return true;
      }

      let result;
      if (session.action === 'suspend')    result = await premiumService.suspend(user.telegram_id);
      else if (session.action === 'unsuspend') result = await premiumService.unsuspend(user.telegram_id);
      else if (session.action === 'remove') result = await premiumService.remove(user.telegram_id);
      sessionManager.clear(ctx.from.id);
      await ctx.reply(result?.ok ? `✅ Done for @${user.username || user.telegram_id}` : `❌ Failed: ${result?.reason}`);
      return true;
    }

    if (session.step === 'await_days') {
      const days = parseInt(text, 10);
      if (!Number.isFinite(days) || days <= 0) { await ctx.reply('⚠️ Enter a valid positive number of days.'); return true; }
      const plan = session.action === 'add_trial' ? PLAN_TYPES.TRIAL : PLAN_TYPES.PREMIUM;
      const result = await premiumService.activate(session.targetId, plan, days);
      sessionManager.clear(ctx.from.id);
      await ctx.reply(result.ok
        ? `✅ Activated ${plan} (${days} days). Expires: ${new Date(result.expiry).toLocaleDateString()}`
        : `❌ Failed: ${result.reason}`);
      return true;
    }

    return false;
  },

  async search(ctx) {
    if (!isAdmin(ctx)) return;
    await safeAnswer(ctx);
    sessionManager.set(ctx.from.id, { flow: 'premium_mgmt', step: 'await_user', action: 'view' });
    return renderText(ctx, '🔍 Send Telegram User ID or @username to view their plan info.\nSend /cancel to abort.',
      { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'admin_premium' }]] }});
  },
};

module.exports = premiumHandler;
