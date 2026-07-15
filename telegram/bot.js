'use strict';
const { Telegraf } = require('telegraf');
const logger = require('../lib/logger');
const db = require('../db');
const { config } = require('../config');

const keyboards           = require('./keyboards');
const startHandler        = require('./handlers/startHandler');
const dashboardHandler    = require('./handlers/dashboardHandler');
const accountHandlers     = require('./handlers/accountHandler');
const tradesHandler       = require('./handlers/tradesHandler');
const tradeHistoryHandler = require('./handlers/tradeHistoryHandler');
const referralHandler     = require('./handlers/referralHandler');
const { subscriptionHandler, helpHandler } = require('./handlers/subscriptionHandler');
const adminHandler        = require('./handlers/admin/adminHandler');
const broadcastHandler    = require('./handlers/admin/broadcastHandler');
const logsHandler         = require('./handlers/admin/logsHandler');
const statsHandler        = require('./handlers/admin/statsHandler');
const premiumHandler      = require('./handlers/admin/premiumHandler');

function createBot() {
  const bot = new Telegraf(config.bot.token);

  // ─── Commands ─────────────────────────────────────────────────────────────
  bot.start((ctx) => startHandler.handleStart(ctx));
  bot.command('cancel', (ctx) => {
    require('./sessionManager').clear(ctx.from.id);
    return ctx.reply('❌ Cancelled.');
  });
  bot.command('setprice', (ctx) => adminHandler.handleSetPriceCommand(ctx));

  // ─── Main navigation ──────────────────────────────────────────────────────
  bot.action('main_menu',            (ctx) => startHandler.showMainMenu(ctx));
  bot.action('dashboard',            (ctx) => dashboardHandler.show(ctx));
  bot.action('toggle_auto_trading',  (ctx) => startHandler.toggleAutoTrading(ctx));
  bot.action('active_trades',        (ctx) => tradesHandler.list(ctx));
  bot.action('trade_history',        (ctx) => tradeHistoryHandler.show(ctx));
  bot.action(/^history_page_(\d+)$/, (ctx) => tradeHistoryHandler.show(ctx, parseInt(ctx.match[1])));
  bot.action(/^history_trade_(.+)$/, (ctx) => tradeHistoryHandler.viewOne(ctx, ctx.match[1]));
  bot.action('referral_page',        (ctx) => referralHandler.show(ctx));
  bot.action('subscription_page',    (ctx) => subscriptionHandler.show(ctx));
  bot.action('help_page',            (ctx) => helpHandler.show(ctx));

  // ─── Switch Account ───────────────────────────────────────────────────────
  bot.action('switch_account',              (ctx) => accountHandlers.showSwitchMenu(ctx));
  bot.action('switch_cat_testnet',          (ctx) => accountHandlers.showCategory(ctx, 'testnet'));
  bot.action('switch_cat_real',             (ctx) => accountHandlers.showCategory(ctx, 'real'));
  bot.action(/^switch_to_(.+)$/,            (ctx) => accountHandlers.selectAccountType(ctx, ctx.match[1]));
  bot.action(/^disconnect_prompt_(.+)$/,    (ctx) => accountHandlers.confirmDisconnectPrompt(ctx, ctx.match[1]));
  bot.action(/^disconnect_confirm_(.+)$/,   (ctx) => accountHandlers.disconnect(ctx, ctx.match[1]));

  // ─── Trades management ────────────────────────────────────────────────────
  bot.action(/^trade_view_(.+)$/,     (ctx) => tradesHandler.view(ctx, ctx.match[1]));
  bot.action(/^trade_be_(.+)$/,       (ctx) => tradesHandler.moveToBreakeven(ctx, ctx.match[1]));
  bot.action(/^trade_partial_(.+)$/,  (ctx) => tradesHandler.closePartial(ctx, ctx.match[1]));
  bot.action(/^trade_close_(.+)$/,    (ctx) => tradesHandler.close(ctx, ctx.match[1]));

  // ─── Subscription plans ───────────────────────────────────────────────────
  bot.action('sub_daily',    (ctx) => subscriptionHandler.selectPlan(ctx, 'daily'));
  bot.action('sub_weekly',   (ctx) => subscriptionHandler.selectPlan(ctx, 'weekly'));
  bot.action('sub_monthly',  (ctx) => subscriptionHandler.selectPlan(ctx, 'monthly'));
  bot.action('sub_lifetime', (ctx) => subscriptionHandler.selectPlan(ctx, 'lifetime'));

  // ─── Admin panel ──────────────────────────────────────────────────────────
  bot.action('admin_panel',             (ctx) => adminHandler.panel(ctx));
  bot.action('admin_users',             (ctx) => adminHandler.users(ctx));
  bot.action('admin_revenue',           (ctx) => adminHandler.revenue(ctx));
  bot.action('admin_channel',           (ctx) => adminHandler.channelSettings(ctx));
  bot.action('admin_payment',           (ctx) => adminHandler.paymentSettings(ctx));
  bot.action('admin_help',              (ctx) => adminHandler.helpSettings(ctx));
  bot.action('admin_settings',          (ctx) => adminHandler.settings(ctx));

  // Admin stats + signal rejections
  bot.action('admin_stats',             (ctx) => statsHandler.show(ctx));
  bot.action('admin_signal_rejections', (ctx) => statsHandler.signalRejections(ctx));

  // Admin bot logs
  bot.action('admin_logs',              (ctx) => logsHandler.show(ctx));
  bot.action(/^logs_filter_(.+)$/,      (ctx) => logsHandler.show(ctx, ctx.match[1]));
  bot.action('logs_clear',              (ctx) => logsHandler.clear(ctx));

  // Admin broadcast
  bot.action('admin_broadcast',         (ctx) => broadcastHandler.menu(ctx));
  bot.action(/^bcast_type_(.+)$/,       (ctx) => broadcastHandler.selectType(ctx, ctx.match[1]));
  bot.action('bcast_history',           (ctx) => broadcastHandler.history(ctx));
  bot.action(/^bcast_delete_(.+)$/,     (ctx) => broadcastHandler.delete(ctx, ctx.match[1]));
  bot.action(/^bcast_aud_(\w+)_(.+)$/,  (ctx) => broadcastHandler.selectAudience(ctx, ctx.match[1], ctx.match[2]));

  // Admin premium management
  bot.action('admin_premium',           (ctx) => premiumHandler.panel(ctx));
  bot.action('pm_add',                  (ctx) => premiumHandler.startFlow(ctx, 'add'));
  bot.action('pm_add_trial',            (ctx) => premiumHandler.startFlow(ctx, 'add_trial'));
  bot.action('pm_renew',                (ctx) => premiumHandler.startFlow(ctx, 'renew'));
  bot.action('pm_suspend',              (ctx) => premiumHandler.startFlow(ctx, 'suspend'));
  bot.action('pm_unsuspend',            (ctx) => premiumHandler.startFlow(ctx, 'unsuspend'));
  bot.action('pm_remove',               (ctx) => premiumHandler.startFlow(ctx, 'remove'));
  bot.action('pm_search',               (ctx) => premiumHandler.search(ctx));
  bot.action('pm_list_premium',         (ctx) => premiumHandler.list(ctx, 'premium'));

  // ─── Text/media routing for multi-step flows ──────────────────────────────
  async function handleInput(ctx) {
    try {
      if (await accountHandlers.handleTextInput(ctx))  return;
      if (await broadcastHandler.handleInput(ctx))     return;
      if (await premiumHandler.handleInput(ctx))       return;
      if (await adminHandler.handleTextInput(ctx))     return;
    } catch (err) {
      logger.error('[INPUT-HANDLER-ERROR]', { err: err.message, user: ctx.from?.id });
      try { await ctx.reply('⚠️ Something went wrong. Please try again.'); } catch { /* ignore */ }
    }
  }

  bot.on('text',      handleInput);
  bot.on('photo',     handleInput);
  bot.on('video',     handleInput);
  bot.on('document',  handleInput);
  bot.on('audio',     handleInput);
  bot.on('voice',     handleInput);
  bot.on('animation', handleInput);
  bot.on('sticker',   handleInput);

  // ─── Global error handler ─────────────────────────────────────────────────
  bot.catch((err, ctx) => {
    logger.error('[BOT-ERROR]', { err: err.message, user: ctx.from?.id });
    try { ctx.reply('⚠️ An error occurred. Please try again.'); } catch { /* ignore */ }
  });

  return bot;
}

async function launchWithAutoReconnect(bot) {
  let attempt = 0;
  async function tryLaunch() {
    try {
      await bot.launch();
      attempt = 0;
      logger.info('[TELEGRAM] Bot launched and polling started.');
    } catch (err) {
      attempt++;
      const delay = Math.min(2000 * 2 ** attempt, 30000);
      logger.error('[TELEGRAM-LAUNCH-FAILED] retrying', { err: err.message, attempt, delayMs: delay });
      setTimeout(tryLaunch, delay);
    }
  }
  await tryLaunch();
}

module.exports = { createBot, launchWithAutoReconnect };
