'use strict';
const { v4: uuidv4 } = require('uuid');
const { readJSON, writeJSON, withFileLock } = require('../jsonStore');
const { config } = require('../../config');

const FILE = config.paths.referrals;

const referralsStore = {
  getAll() {
    return readJSON(FILE) || [];
  },

  forReferrer(referrerId) {
    return referralsStore.getAll().filter((r) => String(r.referrer_id) === String(referrerId));
  },

  forReferee(refereeId) {
    return referralsStore.getAll().filter((r) => String(r.referee_id) === String(refereeId));
  },

  /** True if this referee has already redeemed a referral (prevents duplicate rewards). */
  hasRedeemed(refereeId) {
    return referralsStore.forReferee(refereeId).length > 0;
  },

  /** True if a referral code is already in use by someone (prevents collisions). */
  codeExists(code, usersStore) {
    return !!usersStore.getAll().find((u) => u.referral_code === code);
  },

  async log(data) {
    return withFileLock(FILE, () => {
      const all = readJSON(FILE) || [];
      const entry = {
        id:            uuidv4(),
        referrer_id:   String(data.referrer_id),
        referee_id:    String(data.referee_id),
        code:          data.code,
        referrer_days: data.referrer_days,
        referee_days:  data.referee_days,
        created_at:    new Date().toISOString(),
      };
      all.push(entry);
      writeJSON(FILE, all);
      return entry;
    });
  },

  count() { return referralsStore.getAll().length; },

  countForReferrer(referrerId) { return referralsStore.forReferrer(referrerId).length; },
};

module.exports = referralsStore;
