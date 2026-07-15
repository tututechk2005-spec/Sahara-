'use strict';
const db = require('../../db');
const logger = require('../../lib/logger');
const keyboards = require('../keyboards');
const referralService = require('../../services/referralService');
const { config } = require('../../config');

function isAdmin(ctx) { return String(ctx.from.id) === String(config.bot.adminChatId); }

function safeAnswer(ctx, text) { try { return ctx.answerCbQuery(text); } catch { /* ignore */ } }
async function renderText(ctx, text, extra) {
  try { return await ctx.editMessageText(text, { parse_mode: 'Markdown', ...extra }); }
  catch { return ctx.reply(text, { parse_mode: 'Markdown', ...extra }); }
}

function mainMenuText(user) {
  return (
    `🤖 *Sniper Trading Bot*\n\n` +
    `Welcome${user.first_name ? `, ${user.first_name}` : ''}!\n\n` +
    `🎯 Sniper-only strategy — 8 confirmations required\n` +
    `🔄 24/7 continuous scanning, no trade limits\n` +
    `📊 Live Binance statistics\n\n` +
    `Auto-Trading: ${user.auto_trading ? '🟢 ON' : '🔴 OFF'}\n\n` +
    `Select an option below:`
  );
}

const startHandler = {
  async handleStart(ctx) {
    const userId = ctx.from.id;
    const payload = (ctx.startPayload || '').trim();

    let user = db.users.findById(userId);
    const isNew = !user;
    if (!user) {
      user = await db.users.create({ telegram_id: userId, username: ctx.from.username || '', first_name: ctx.from.first_name || '' });
    }

    if (isNew && payload) {
      const result = await referralService.applyReferral(userId, payload, ctx.telegram ? ctx : null);
      if (result.applied) {
        await ctx.reply(`🎉 Welcome! You joined via a referral link and received *+${result.refereeDays} day* of Premium.`, { parse_mode: 'Markdown' });
        user = db.users.findById(userId);
      }
    }

    return ctx.reply(mainMenuText(user), { parse_mode: 'Markdown', ...keyboards.mainMenu(isAdmin(ctx)) });
  },

  async showMainMenu(ctx) {
    await safeAnswer(ctx);
    const user = db.users.findById(ctx.from.id);
    if (!user) return startHandler.handleStart(ctx);
    return renderText(ctx, mainMenuText(user), keyboards.mainMenu(isAdmin(ctx)));
  },

  async toggleAutoTrading(ctx) {
    const userId = ctx.from.id;
    const user = db.users.findById(userId);
    if (!user) return safeAnswer(ctx, 'Please /start the bot first.');

    if (!user.active_account_type) {
      return safeAnswer(ctx, '⚠️ Connect a Binance account first via Switch Account.');
    }

    const next = !user.auto_trading;
    await db.users.update(userId, { auto_trading: next });
    await safeAnswer(ctx, next ? '🟢 Auto-Trading enabled' : '🔴 Auto-Trading disabled');

    const updated = db.users.findById(userId);
    return renderText(ctx, mainMenuText(updated), keyboards.mainMenu(isAdmin(ctx)));
  },
};

module.exports = startHandler;
