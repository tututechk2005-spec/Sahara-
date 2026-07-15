'use strict';
const crypto = require('crypto');
const db = require('../db');
const logger = require('../lib/logger');
const { createKeyedLock } = require('../lib/utils');
const { REFERRAL_REFERRER_DAYS, REFERRAL_REFEREE_DAYS, REFERRAL_CODE_LENGTH } = require('../config');

const withLock = createKeyedLock();
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars (0/O, 1/I, etc.)

function randomCode(len) {
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

function addDaysToExpiry(currentExpiryIso, days) {
  const base = currentExpiryIso && new Date(currentExpiryIso) > new Date() ? new Date(currentExpiryIso) : new Date();
  base.setDate(base.getDate() + days);
  return base.toISOString();
}

const referralService = {
  /** Returns the user's permanent referral code, generating + saving a guaranteed-unique one if missing. */
  async getOrCreateCode(userId) {
    const user = db.users.findById(userId);
    if (!user) return null;
    if (user.referral_code) return user.referral_code;

    return withLock('referral-code-gen', async () => {
      const fresh = db.users.findById(userId);
      if (fresh.referral_code) return fresh.referral_code;

      let code;
      let attempts = 0;
      do {
        code = 'REF' + randomCode(REFERRAL_CODE_LENGTH - 3);
        attempts++;
      } while (db.referrals.codeExists(code, db.users) && attempts < 25);

      await db.users.update(userId, { referral_code: code });
      return code;
    });
  },

  findByCode(code) {
    if (!code) return null;
    return db.users.getAll().find((u) => u.referral_code === code) || null;
  },

  buildReferralLink(botUsername, code) {
    return `https://t.me/${botUsername}?start=${code}`;
  },

  /**
   * Applies a referral for a brand-new user. Idempotent and race-safe:
   * - locked per referee so a double /start can never double-apply
   * - checked against BOTH user.referred_by AND the referrals log, so even
   *   if one write partially failed before, the reward is never duplicated
   * Returns a result object instead of throwing, so callers can always
   * continue the normal /start flow regardless of referral outcome.
   */
  async applyReferral(refereeId, code, bot) {
    if (!code) return { applied: false, reason: 'NO_CODE' };

    return withLock(`referral-apply-${refereeId}`, async () => {
      try {
        const referee = db.users.findById(refereeId);
        if (!referee) return { applied: false, reason: 'REFEREE_NOT_FOUND' };
        if (referee.referred_by) return { applied: false, reason: 'ALREADY_REFERRED' };
        if (db.referrals.hasRedeemed(refereeId)) return { applied: false, reason: 'ALREADY_REDEEMED' };

        const referrer = referralService.findByCode(code);
        if (!referrer) return { applied: false, reason: 'INVALID_CODE' };
        if (String(referrer.telegram_id) === String(refereeId)) return { applied: false, reason: 'SELF_REFERRAL' };

        const referrerNewExpiry = addDaysToExpiry(referrer.subscription_expiry, REFERRAL_REFERRER_DAYS);
        const refereeNewExpiry  = addDaysToExpiry(referee.subscription_expiry,  REFERRAL_REFEREE_DAYS);

        await db.users.update(referrer.telegram_id, {
          total_referrals:    (referrer.total_referrals || 0) + 1,
          referral_earnings:  (referrer.referral_earnings || 0) + REFERRAL_REFERRER_DAYS,
          subscription:       'active',
          subscription_expiry: referrerNewExpiry,
        });

        await db.users.update(refereeId, {
          referred_by:         String(referrer.telegram_id),
          referred_by_code:    code,
          subscription:        'active',
          subscription_expiry: refereeNewExpiry,
        });

        await db.referrals.log({
          referrer_id: referrer.telegram_id,
          referee_id:  refereeId,
          code,
          referrer_days: REFERRAL_REFERRER_DAYS,
          referee_days:  REFERRAL_REFEREE_DAYS,
        });

        logger.info(`[REFERRAL-APPLIED] ${refereeId} referred by ${referrer.telegram_id} via ${code}`);

        if (bot) {
          try {
            await bot.telegram.sendMessage(
              referrer.telegram_id,
              `🎉 *New referral!*\n\nSomeone joined using your referral link.\nYou've earned *+${REFERRAL_REFERRER_DAYS} days* of Premium.\n\nTotal referrals: *${(referrer.total_referrals || 0) + 1}*`,
              { parse_mode: 'Markdown' }
            );
          } catch (err) {
            logger.warn('[REFERRAL] Failed to notify referrer', { err: err.message });
          }
        }

        return { applied: true, referrerId: referrer.telegram_id, referrerDays: REFERRAL_REFERRER_DAYS, refereeDays: REFERRAL_REFEREE_DAYS };
      } catch (err) {
        logger.error('[REFERRAL-ERROR] applyReferral failed', { err: err.message, refereeId, code });
        return { applied: false, reason: 'ERROR', error: err.message };
      }
    });
  },

  /** Builds the data needed to render the referral page — never throws. */
  async getReferralStats(userId, botUsername) {
    const user = db.users.findById(userId);
    if (!user) return null;
    const code = await referralService.getOrCreateCode(userId);
    const log  = db.referrals.forReferrer(userId);
    return {
      code,
      link:            referralService.buildReferralLink(botUsername, code),
      totalReferrals:  user.total_referrals || 0,
      earnedDays:      user.referral_earnings || 0,
      recentReferrals: log.slice(-10).reverse(),
    };
  },
};

module.exports = referralService;
