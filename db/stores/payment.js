'use strict';
const { readJSON, writeJSON, withFileLock } = require('../jsonStore');
const { config } = require('../../config');
const logger = require('../../lib/logger');

const FILE = config.paths.payment;

function defaults() {
  return {
    monthly_price:  29.99,
    weekly_price:   9.99,
    lifetime_price: 99.99,
    daily_price:    2.99,
    currency:       'USD',
    admin_username: '',
    payment_note:   '',
  };
}

const paymentStore = {
  get() {
    return { ...defaults(), ...(readJSON(FILE) || {}) };
  },
  async update(patch) {
    return withFileLock(FILE, () => {
      const updated = { ...paymentStore.get(), ...patch };
      writeJSON(FILE, updated);
      logger.info('[PAYMENT-UPDATE] Payment settings updated', { patch });
      return updated;
    });
  },
};

module.exports = paymentStore;
