'use strict';
const db = require('../../../db');
const premiumService = require('../../../services/premiumService');
const sessionManager = require('../../sessionManager');
const { PLAN_TYPES, PLAN_DURATIONS_DAYS } = require('../../../config');
const Markup = require('telegraf').Markup;

function safeAnswer(ctx, t) { try { return ctx.answerCbQuery(t); } catch {} }
async function renderText(ctx, text, extra) {
  try { return await ctx.editMessageText(text, { parse_mode: 'Markdown', ...extra }); }
  catch { return ctx.reply(text, { parse_mode: 'Markdown', ...extra }); }
}

function statusTag(row) {
  if (row.status === 'SUSPENDED') return '⏸';
  if (row.status === 'ACTIVE')    return '✅';
  return '❌';
}

function listText(items, page, pages) {
  if (!items.length) return '💳 *Premium Management*\n\nNo premium/trial users yet.';
  const rows = items.map((r) =>
    `${statusTag(r)} @${r.username || r.telegram_id} | ${r.plan?.toUpperCase()} | ${r.remaining_days}d left`
  ).join('\n');
  return `💳 *Premium Management* (page ${page}/${pages})\n\n${rows}\n\nTap a user to manage them.`;
}

function buildListKeyboard(items, page, pages) {
  const rows = items.map((r) => [Markup.button.callback(
    `${statusTag(r)} ${r.username || r.telegram_id} (${r.remaining_days}d)`, `premium_manage_${r.telegram_id}`
  )]);
  const nav = [];
  if (page > 1) nav.push(Markup.button.callback('⬅️', `premium_page_${page - 1}`));
  nav.push(Markup.button.callback(`${page}/${pages}`, 'noop'));
  if (page < pages) nav.push(Markup.button.callback('➡️', `premium_page_${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([Markup.button.callback('➕ Add User', 'premium_add'), Markup.button.callback('🔍 Search', 'premium_search')]);
  rows.push([Markup.button.callback('⬅️ Admin Panel', 'admin_panel')]);
  return Markup.inlineKeyboard(rows);
}

function manageText(row) {
  return (
    `👤 *User: @${row.username || row.telegram_id}*\n\n` +
    `Plan: ${row.plan?.toUpperCase() || 'FREE'}\n` +
    `Status: ${row.status}\n` +
    `Purchased: ${row.purchased_at}\n` +
    `Expires: ${row.expiry}\n` +
    `Days left: ${row.remaining_days}`
  );
}

function manageKeyboard(uid) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Activate',  `premium_activate_${uid}`), Markup.button.callback('❌ Revoke', `premium_revoke_${uid}`)],
    [Markup.button.callback('➕ Renew 30d', `premium_renew_30_${uid}`), Markup.button.callback('⏸ Suspend', `premium_suspend_${uid}`)],
    [Markup.button.callback('▶️ Unsuspend',`premium_unsuspend_${uid}`)],
    [Markup.button.callback('⬅️ Back', 'admin_premium')],
  ]);
}

const adminPremiumHandler = {
  async list(ctx, page = 1) {
    await safeAnswer(ctx);
    const { items, total, pages } = premiumService.listPremium(page);
    return renderText(ctx, listText(items, page, Math.max(1, pages)), buildListKeyboard(items, page, Math.max(1, pages)));
  },

  async manageUser(ctx, uid) {
    await safeAnswer(ctx);
    const user = db.users.findById(uid);
    if (!user) return safeAnswer(ctx, 'User not found');
    const row = premiumService.buildRow(user);
    return renderText(ctx, manageText(row), manageKeyboard(uid));
  },

  async activate(ctx, uid)     { await safeAnswer(ctx); await premiumService.activate(uid, PLAN_TYPES.PREMIUM, 30); return adminPremiumHandler.manageUser(ctx, uid); },
  async revoke(ctx, uid)       { await safeAnswer(ctx); await premiumService.revoke(uid);   return adminPremiumHandler.manageUser(ctx, uid); },
  async suspend(ctx, uid)      { await safeAnswer(ctx); await premiumService.suspend(uid);  return adminPremiumHandler.manageUser(ctx, uid); },
  async unsuspend(ctx, uid)    { await safeAnswer(ctx); await premiumService.unsuspend(uid);return adminPremiumHandler.manageUser(ctx, uid); },
  async renew(ctx, uid, days)  { await safeAnswer(ctx); await premiumService.renew(uid, days); return adminPremiumHandler.manageUser(ctx, uid); },

  async startAdd(ctx) {
    await safeAnswer(ctx);
    sessionManager.set(ctx.from.id, { flow: 'admin_premium_add', step: 'await_userid' });
    return renderText(ctx, '➕ *Add Premium User*\n\nSend the user\'s Telegram ID or @username, or /cancel.', Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'admin_premium')]]));
  },

  async startSearch(ctx) {
    await safeAnswer(ctx);
    sessionManager.set(ctx.from.id, { flow: 'admin_premium_search', step: 'await_query' });
    return renderText(ctx, '🔍 *Search User*\n\nSend a Telegram ID or @username to search, or /cancel.', Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'admin_premium')]]));
  },

  async handleTextInput(ctx) {
    const session = sessionManager.get(ctx.from.id);
    if (!session) return false;
    const text = (ctx.message.text || '').trim();
    if (text === '/cancel') { sessionManager.clear(ctx.from.id); await ctx.reply('❌ Cancelled.'); return true; }

    if (session.flow === 'admin_premium_search') {
      sessionManager.clear(ctx.from.id);
      const results = db.users.search(text);
      if (!results.length) { await ctx.reply('No users found.'); return true; }
      const rows = results.slice(0, 10).map((u) => [Markup.button.callback(
        `@${u.username || u.telegram_id} (${u.plan || 'free'})`, `premium_manage_${u.telegram_id}`
      )]);
      await ctx.reply(`Found ${results.length} user(s):`, Markup.inlineKeyboard(rows));
      return true;
    }

    if (session.flow === 'admin_premium_add' && session.step === 'await_userid') {
      const query = text.replace('@', '');
      const user = db.users.search(query)[0] || db.users.findById(query);
      if (!user) { await ctx.reply('⚠️ User not found. They must have started the bot first.'); return true; }
      session.step = 'await_plan';
      session.targetId = user.telegram_id;
      sessionManager.set(ctx.from.id, session);
      await ctx.reply(`Found: @${user.username || user.telegram_id}\n\nHow many days of Premium?`, { reply_markup: { force_reply: true } });
      return true;
    }

    if (session.flow === 'admin_premium_add' && session.step === 'await_plan') {
      const days = parseInt(text, 10);
      if (!days || days < 1) { await ctx.reply('⚠️ Send a valid number of days (e.g. 30).'); return true; }
      sessionManager.clear(ctx.from.id);
      const activated = await premiumService.activate(session.targetId, PLAN_TYPES.PREMIUM, days);
      await ctx.reply(`✅ Premium activated for ${days} days.\nExpiry: ${activated.subscription_expiry ? new Date(activated.subscription_expiry).toLocaleDateString() : '—'}`);
      return true;
    }
    return false;
  },
};

module.exports = adminPremiumHandler;
