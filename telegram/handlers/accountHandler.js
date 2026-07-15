'use strict';
const db = require('../../db');
const logger = require('../../lib/logger');
const keyboards = require('../keyboards');
const sessionManager = require('../sessionManager');
const accountManager = require('../../services/accountManager');
const { ACCOUNT_TYPE_META } = require('../../config');

function safeAnswer(ctx) { try { return ctx.answerCbQuery(); } catch { /* ignore */ } }

async function renderText(ctx, text, extra) {
  try { return await ctx.editMessageText(text, { parse_mode: 'Markdown', ...extra }); }
  catch { return ctx.reply(text, { parse_mode: 'Markdown', ...extra }); }
}

const accountHandlers = {
  /** Entry point — "🔄 Switch Account" button. */
  async showSwitchMenu(ctx) {
    await safeAnswer(ctx);
    const userId = ctx.from.id;
    const slots  = accountManager.getSlotsOverview(userId);
    const user   = db.users.findById(userId);
    const activeLabel = accountManager.formatAccountLabel(user?.active_account_type);

    const text =
      `🔄 *Switch Account*\n\n` +
      `Current active account: *${activeLabel}*\n\n` +
      `Choose a category. Connected accounts show ✅ — you'll never be asked for those API keys again.`;

    return renderText(ctx, text, keyboards.switchAccountCategories(slots));
  },

  async showCategory(ctx, category) {
    await safeAnswer(ctx);
    const userId = ctx.from.id;
    const slots  = accountManager.getSlotsOverview(userId);
    const label  = category === 'testnet' ? '🧪 Testnet' : '💰 Real';
    const text   = `${label}\n\nSelect a market type:`;
    return renderText(ctx, text, keyboards.switchAccountTypes(category, slots));
  },

  /** User tapped a specific account type (e.g. real_spot). */
  async selectAccountType(ctx, accountType) {
    await safeAnswer(ctx);
    const userId = ctx.from.id;
    const meta = ACCOUNT_TYPE_META[accountType];
    if (!meta) return renderText(ctx, '❌ Unknown account type.', keyboards.backTo('switch_account'));

    const result = await accountManager.switchAccount(userId, accountType);

    if (result.switched) {
      const text =
        `✅ *Switched to ${meta.label}*\n\n` +
        `${meta.testnet ? '🧪 This is a TESTNET account — no real funds are at risk.' : '💰 This is a REAL account — real funds are at risk.'}\n\n` +
        `Your Binance connection has been reconnected automatically — no restart needed.`;
      return renderText(ctx, text, keyboards.dashboardMenu());
    }

    if (result.needsCredentials) {
      sessionManager.set(userId, { flow: 'connect_account', step: 'await_api_key', accountType });
      const text =
        `🔑 *Connect ${meta.label}*\n\n` +
        `This is the first time you're using this account slot. Send your *Binance API Key* now.\n\n` +
        `${meta.testnet ? '👉 Get testnet keys at testnet.binance.vision or testnet.binancefuture.com' : '⚠️ Make sure the key has trading permission enabled and NO withdrawal permission.'}\n\n` +
        `Send /cancel to abort.`;
      return renderText(ctx, text, keyboards.backTo('switch_account', '❌ Cancel'));
    }

    return renderText(ctx, '❌ Could not switch account. Please try again.', keyboards.backTo('switch_account'));
  },

  /** Routes free-text messages while the user is in the connect-account flow. Returns true if it handled the message. */
  async handleTextInput(ctx) {
    const userId = ctx.from.id;
    const session = sessionManager.get(userId);
    if (!session || session.flow !== 'connect_account') return false;

    const text = (ctx.message.text || '').trim();
    if (text === '/cancel') {
      sessionManager.clear(userId);
      await ctx.reply('❌ Cancelled.');
      return true;
    }

    const meta = ACCOUNT_TYPE_META[session.accountType];

    if (session.step === 'await_api_key') {
      if (text.length < 10) { await ctx.reply('⚠️ That doesn\'t look like a valid API key. Please send your Binance API Key.'); return true; }
      session.apiKey = text;
      session.step = 'await_api_secret';
      sessionManager.set(userId, session);
      await ctx.reply(`✅ API Key received.\n\nNow send your *Binance API Secret*.`, { parse_mode: 'Markdown' });
      return true;
    }

    if (session.step === 'await_api_secret') {
      if (text.length < 10) { await ctx.reply('⚠️ That doesn\'t look like a valid API secret. Please send your Binance API Secret.'); return true; }
      const apiSecret = text;
      const apiKey    = session.apiKey;
      sessionManager.clear(userId);

      const verifying = await ctx.reply(`🔍 Verifying credentials for ${meta.label}...`);
      const result = await accountManager.connectAccount(userId, session.accountType, apiKey, apiSecret);

      try { await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id); } catch { /* best effort: scrub secret from chat history */ }

      if (!result.success) {
        const reason = result.result?.errorReason || 'Unknown error';
        const title  = result.result?.errorTitle  || '❌ Verification Failed';
        try { await ctx.telegram.editMessageText(ctx.chat.id, verifying.message_id, undefined,
          `${title}\n\n${reason}\n\nPlease try connecting again.`, keyboards.backTo('switch_account')); }
        catch { await ctx.reply(`${title}\n\n${reason}`, keyboards.backTo('switch_account')); }
        return true;
      }

      const bal = result.result.usdtBalance ?? result.result.availableBalance ?? 0;
      const successText =
        `✅ *${meta.label} connected!*\n\n` +
        `Account type: ${result.result.accountType}\n` +
        `Balance: $${Number(bal).toFixed(2)} USDT\n\n` +
        `You're now switched to this account. Your keys are saved permanently — you'll never be asked again unless you disconnect.`;
      try { await ctx.telegram.editMessageText(ctx.chat.id, verifying.message_id, undefined, successText, { parse_mode: 'Markdown', ...keyboards.dashboardMenu() }); }
      catch { await ctx.reply(successText, { parse_mode: 'Markdown', ...keyboards.dashboardMenu() }); }
      return true;
    }

    return false;
  },

  async confirmDisconnectPrompt(ctx, accountType) {
    await safeAnswer(ctx);
    const meta = ACCOUNT_TYPE_META[accountType];
    return renderText(ctx,
      `⚠️ Disconnect *${meta.label}*?\n\nThis permanently deletes the saved API keys for this slot. You'll need to re-enter them to use this account again.`,
      keyboards.confirmDisconnect(accountType)
    );
  },

  async disconnect(ctx, accountType) {
    await safeAnswer(ctx);
    const userId = ctx.from.id;
    await accountManager.disconnectAccount(userId, accountType);
    return accountHandlers.showSwitchMenu(ctx);
  },
};

module.exports = accountHandlers;
