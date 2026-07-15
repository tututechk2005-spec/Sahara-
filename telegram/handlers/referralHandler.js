'use strict';
const keyboards = require('../keyboards');
const referralService = require('../../services/referralService');

function safeAnswer(ctx) { try { return ctx.answerCbQuery(); } catch { /* ignore */ } }
async function renderText(ctx, text, extra) {
  try { return await ctx.editMessageText(text, { parse_mode: 'Markdown', disable_web_page_preview: true, ...extra }); }
  catch { return ctx.reply(text, { parse_mode: 'Markdown', disable_web_page_preview: true, ...extra }); }
}

const referralHandler = {
  async show(ctx) {
    await safeAnswer(ctx);
    const userId = ctx.from.id;
    const botUsername = ctx.botInfo?.username || (await ctx.telegram.getMe()).username;
    const stats = await referralService.getReferralStats(userId, botUsername);

    if (!stats) return renderText(ctx, '⚠️ Could not load your referral info. Please try again.', keyboards.backTo('main_menu'));

    const text =
      `🤝 *Your Referral Program*\n\n` +
      `Invite friends and both of you get rewarded:\n` +
      `• You get *+3 days* Premium per referral\n` +
      `• They get *+1 day* Premium for joining\n\n` +
      `🔗 Your link:\n\`${stats.link}\`\n\n` +
      `📊 Total referrals: *${stats.totalReferrals}*\n` +
      `🎁 Days earned: *${stats.earnedDays}*`;

    return renderText(ctx, text, keyboards.backTo('main_menu'));
  },
};

module.exports = referralHandler;
