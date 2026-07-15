'use strict';
const { Markup } = require('telegraf');
const { ACCOUNT_TYPES, ACCOUNT_TYPE_META } = require('../config');

const keyboards = {
  mainMenu(isAdmin = false) {
    const rows = [
      [Markup.button.callback('📊 Dashboard',       'dashboard'),
       Markup.button.callback('🔄 Switch Account',  'switch_account')],
      [Markup.button.callback('📈 Active Trades',   'active_trades'),
       Markup.button.callback('📋 Trade History',   'trade_history')],
      [Markup.button.callback('🎯 Auto-Trading',    'toggle_auto_trading'),
       Markup.button.callback('🤝 Referrals',       'referral_page')],
      [Markup.button.callback('💳 Subscription',    'subscription_page'),
       Markup.button.callback('❓ Help',            'help_page')],
    ];
    if (isAdmin) rows.push([Markup.button.callback('🛠 Admin Panel', 'admin_panel')]);
    return Markup.inlineKeyboard(rows);
  },

  backTo(action, label = '⬅️ Back') {
    return Markup.inlineKeyboard([[Markup.button.callback(label, action)]]);
  },

  switchAccountCategories(slots) {
    const labelFor = (type) => (slots.find((s) => s.type === type)?.connected ? '✅' : '⬜');
    return Markup.inlineKeyboard([
      [Markup.button.callback(`🧪 Testnet  ${labelFor(ACCOUNT_TYPES.TESTNET_SPOT)}${labelFor(ACCOUNT_TYPES.TESTNET_FUTURES)}`, 'switch_cat_testnet')],
      [Markup.button.callback(`💰 Real  ${labelFor(ACCOUNT_TYPES.REAL_SPOT)}${labelFor(ACCOUNT_TYPES.REAL_FUTURES)}`, 'switch_cat_real')],
      [Markup.button.callback('⬅️ Back', 'dashboard')],
    ]);
  },

  switchAccountTypes(category, slots) {
    const types = Object.values(ACCOUNT_TYPES).filter((t) => ACCOUNT_TYPE_META[t].category === category);
    const rows = types.map((t) => {
      const slot = slots.find((s) => s.type === t);
      const mark = slot?.connected ? '✅' : '➕';
      return [Markup.button.callback(`${mark} ${ACCOUNT_TYPE_META[t].label}`, `switch_to_${t}`)];
    });
    rows.push([Markup.button.callback('⬅️ Back', 'switch_account')]);
    return Markup.inlineKeyboard(rows);
  },

  confirmDisconnect(accountType) {
    return Markup.inlineKeyboard([
      [Markup.button.callback('🗑 Yes, disconnect', `disconnect_confirm_${accountType}`)],
      [Markup.button.callback('⬅️ Cancel', 'switch_account')],
    ]);
  },

  dashboardMenu() {
    return Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Refresh',       'dashboard'),
       Markup.button.callback('📈 Active Trades',  'active_trades')],
      [Markup.button.callback('📋 Trade History',  'trade_history'),
       Markup.button.callback('🔄 Switch Account', 'switch_account')],
      [Markup.button.callback('⬅️ Main Menu', 'main_menu')],
    ]);
  },

  tradeManagement(tradeId) {
    return Markup.inlineKeyboard([
      [Markup.button.callback('🔒 Move SL → BE',  `trade_be_${tradeId}`),
       Markup.button.callback('📉 Close 50%',      `trade_partial_${tradeId}`)],
      [Markup.button.callback('❌ Close Trade',    `trade_close_${tradeId}`)],
      [Markup.button.callback('⬅️ Back',           'active_trades')],
    ]);
  },

  activeTradesList(trades) {
    const rows = trades.map((t) => [Markup.button.callback(
      `${t.side === 'BUY' ? '🟢' : '🔴'} ${t.symbol} ${t.side}${t.source === 'manual' ? ' 🔍' : ''}`,
      `trade_view_${t.trade_id}`)]);
    rows.push([Markup.button.callback('⬅️ Main Menu', 'main_menu')]);
    return Markup.inlineKeyboard(rows);
  },

  subscriptionMenu() {
    return Markup.inlineKeyboard([
      [Markup.button.callback('📅 Daily',    'sub_daily'),
       Markup.button.callback('📆 Weekly',   'sub_weekly')],
      [Markup.button.callback('🗓 Monthly',  'sub_monthly'),
       Markup.button.callback('♾️ Lifetime', 'sub_lifetime')],
      [Markup.button.callback('⬅️ Main Menu', 'main_menu')],
    ]);
  },

  adminPanel() {
    return Markup.inlineKeyboard([
      [Markup.button.callback('👥 Users',       'admin_users'),
       Markup.button.callback('📊 Statistics',  'admin_stats')],
      [Markup.button.callback('📢 Broadcast',   'admin_broadcast'),
       Markup.button.callback('👑 Premium Mgmt','admin_premium')],
      [Markup.button.callback('📜 Bot Logs',    'admin_logs'),
       Markup.button.callback('💰 Revenue',     'admin_revenue')],
      [Markup.button.callback('📡 Channel',     'admin_channel'),
       Markup.button.callback('💳 Payment',     'admin_payment')],
      [Markup.button.callback('❓ Help Settings','admin_help'),
       Markup.button.callback('⚙️ Settings',   'admin_settings')],
      [Markup.button.callback('⬅️ Main Menu', 'main_menu')],
    ]);
  },
};

module.exports = keyboards;
