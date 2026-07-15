'use strict';
const { readJSON, writeJSON, withFileLock } = require('../jsonStore');
const { config } = require('../../config');
const logger = require('../../lib/logger');

const FILE = config.paths.help;

function defaults() {
  return {
    support_username:  '',
    telegram_username: '',
    help_message:      'Need help? Contact support.',
  };
}

const helpStore = {
  get() {
    return { ...defaults(), ...(readJSON(FILE) || {}) };
  },
  async update(patch) {
    return withFileLock(FILE, () => {
      const updated = { ...helpStore.get(), ...patch };
      writeJSON(FILE, updated);
      logger.info('[HELP-UPDATE] Help settings updated', { patch });
      return updated;
    });
  },
};

module.exports = helpStore;
