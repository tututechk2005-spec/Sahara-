'use strict';
const db = require('../../db');
const keyboards = require('../keyboards');

function safeAnswer(ctx) { try { return ctx.answerCbQuery(); } catch { /* ignore */ } }
async function renderText(ctx, text, extra) {
  try { return await ctx.editMessageText(text, { parse_mode: 'Markdown', ...extra }); }
  catch { return ctx.reply(text, { parse_mode: 'Markdown', ...extra }); }
}

const subscriptionHandler = {
  async show(ctx) {
    await safeAnswer(ctx);
    const userId = ctx.from.id;
    const user = db.users.findById(userId);
    const payment = db.payment.get();

    const status = user?.subscription === 'active'
      ? `✅ Active${user.subscription_expiry ? ` until ${new Date(user.subscription_expiry).toLocaleDateString()}` : ''}`
      : '❌ Inactive';

    const text =
      `💳 *Subscription*\n\n` +
      `Status: ${status}\n\n` +
      `*Plans:*\n` +
      `📅 Daily — $${payment.daily_price}\n` +
      `📆 Weekly — $${payment.weekly_price}\n` +
      `🗓 Monthly — $${payment.monthly_price}\n` +
      `♾️ Lifetime — $${payment.lifetime_price}\n\n` +
      `${payment.payment_note ? payment.payment_note + '\n\n' : ''}` +
      `${payment.admin_username ? `Contact @${payment.admin_username} to upgrade.` : 'Contact the admin to upgrade.'}`;

    return renderText(ctx, text, keyboards.subscriptionMenu());
  },

  async selectPlan(ctx, plan) {
    await safeAnswer(ctx);
    const payment = db.payment.get();
    const priceMap = { daily: payment.daily_price, weekly: payment.weekly_price, monthly: payment.monthly_price, lifetime: payment.lifetime_price };
    const text =
      `🛒 *${plan[0].toUpperCase() + plan.slice(1)} Plan — $${priceMap[plan]}*\n\n` +
      `${payment.admin_username ? `To purchase, message @${payment.admin_username} with your Telegram username and selected plan.` : 'Contact the admin to complete your purchase.'}`;
    return renderText(ctx, text, keyboards.backTo('subscription_page'));
  },
};

const helpHandler = {
  async show(ctx) {
    await safeAnswer(ctx);
    const help = db.help.get();
    const text =
      `❓ *Help & Support*\n\n` +
      `${help.help_message}\n\n` +
      `${help.support_username ? `Contact: @${help.support_username}` : ''}`;
    return renderText(ctx, text, keyboards.backTo('main_menu'));
  },
};

module.exports = { subscriptionHandler, helpHandler };
