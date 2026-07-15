'use strict';
const db = require('../db');
const logger = require('../lib/logger');
const { PLAN_TYPES, PLAN_DURATIONS_DAYS } = require('../config');

function addDays(fromIso, days) {
  const base = fromIso && new Date(fromIso) > new Date() ? new Date(fromIso) : new Date();
  base.setDate(base.getDate() + days);
  return base.toISOString();
}

const premiumService = {
  /** Grants a paid plan. Stacks on top of any remaining days. */
  async activate(userId, plan, days) {
    const user = db.users.findById(userId);
    if (!user) return { ok: false, reason: 'USER_NOT_FOUND' };
    const expiry = addDays(user.subscription_expiry, days);
    await db.users.update(userId, {
      subscription:            'active',
      plan,
      subscription_expiry:     expiry,
      subscription_purchased_at: user.subscription_purchased_at || new Date().toISOString(),
      subscription_suspended:  false,
      trial_used:              plan === PLAN_TYPES.TRIAL ? true : user.trial_used,
    });
    logger.info(`[PREMIUM] activated user:${userId} plan:${plan} days:${days} expiry:${expiry}`);
    return { ok: true, expiry, remainingDays: db.users.remainingDays(db.users.findById(userId)) };
  },

  async activateByPlanKey(userId, planKey) {
    const days = PLAN_DURATIONS_DAYS[planKey];
    if (!days) return { ok: false, reason: 'INVALID_PLAN' };
    const planType = planKey === 'daily' || planKey === 'weekly' ? PLAN_TYPES.PREMIUM : PLAN_TYPES.PREMIUM;
    return premiumService.activate(userId, planType, days);
  },

  async renew(userId, days) {
    const user = db.users.findById(userId);
    if (!user) return { ok: false, reason: 'USER_NOT_FOUND' };
    return premiumService.activate(userId, user.plan || PLAN_TYPES.PREMIUM, days);
  },

  async suspend(userId) {
    const user = db.users.findById(userId);
    if (!user) return { ok: false, reason: 'USER_NOT_FOUND' };
    await db.users.update(userId, { subscription_suspended: true, auto_trading: false });
    return { ok: true };
  },

  async unsuspend(userId) {
    const user = db.users.findById(userId);
    if (!user) return { ok: false, reason: 'USER_NOT_FOUND' };
    if (!user.subscription_expiry || new Date(user.subscription_expiry) <= new Date()) {
      return { ok: false, reason: 'SUBSCRIPTION_EXPIRED' };
    }
    await db.users.update(userId, { subscription_suspended: false });
    return { ok: true };
  },

  async remove(userId) {
    await db.users.update(userId, {
      subscription: 'inactive', plan: PLAN_TYPES.FREE,
      subscription_expiry: null, subscription_suspended: false, auto_trading: false,
    });
    return { ok: true };
  },

  isPremiumActive(user) {
    if (!user) return false;
    if (user.subscription !== 'active') return false;
    if (user.subscription_suspended) return false;
    if (user.subscription_expiry && new Date(user.subscription_expiry) <= new Date()) return false;
    return true;
  },

  /** Run on every monitoring cycle — auto-expires overdue plans. */
  async runExpiry(bot) {
    const expired = await db.users.expireOverduePlans();
    for (const uid of expired) {
      logger.info(`[PREMIUM] Auto-expired subscription for user:${uid}`);
      if (bot) {
        try {
          await bot.telegram.sendMessage(uid,
            '⏰ *Your subscription has expired.*\n\nYou have been moved to the Free plan. Contact support or use /start to renew.',
            { parse_mode: 'Markdown' });
        } catch { /* user may have blocked the bot */ }
      }
    }
    return expired;
  },

  /** Admin-facing user list with plan info, supporting search + filter. */
  getUserList(query, planFilter) {
    let users = query ? db.users.search(query) : db.users.getAll();
    if (planFilter) users = users.filter((u) => u.plan === planFilter);
    return users.map((u) => ({
      telegram_id:    u.telegram_id,
      username:       u.username || '',
      first_name:     u.first_name || '',
      plan:           u.plan || 'free',
      subscription:   u.subscription,
      suspended:      u.subscription_suspended || false,
      expiry:         u.subscription_expiry,
      purchased_at:   u.subscription_purchased_at,
      remaining_days: db.users.remainingDays(u),
      auto_trading:   u.auto_trading,
    })).sort((a, b) => (b.remaining_days || 0) - (a.remaining_days || 0));
  },
};

module.exports = premiumService;
