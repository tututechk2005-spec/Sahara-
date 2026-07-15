'use strict';
const { v4: uuidv4 } = require('uuid');
const { readJSON, writeJSON, withFileLock } = require('../jsonStore');
const { config } = require('../../config');

const FILE = config.paths.apiErrors;

const apiErrorsStore = {
  getAll() { return readJSON(FILE) || []; },

  async log(data) {
    return withFileLock(FILE, () => {
      const errors = readJSON(FILE) || [];
      errors.push({
        id:            uuidv4(),
        user_id:       String(data.user_id || ''),
        username:      data.username || '',
        time:          new Date().toISOString(),
        market_type:   data.market_type || '',
        account_type:  data.account_type || '',
        error_code:    data.error_code || null,
        error_message: data.error_message || '',
        binance_code:  data.binance_code || null,
        binance_msg:   data.binance_msg  || '',
      });
      if (errors.length > 500) errors.splice(0, errors.length - 500);
      writeJSON(FILE, errors);
      return true;
    });
  },
};

module.exports = apiErrorsStore;
