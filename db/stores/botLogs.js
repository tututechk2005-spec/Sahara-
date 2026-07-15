'use strict';
const { v4: uuidv4 } = require('uuid');
const { readJSON, writeJSON, withFileLock } = require('../jsonStore');
const { config, BOT_LOG_KEEP, LOG_LEVELS_UI } = require('../../config');

const FILE = config.paths.botLogs;

const botLogsStore = {
  getAll() { return readJSON(FILE) || []; },

  recent(n = 100) {
    return botLogsStore.getAll().slice(-n).reverse();
  },

  async add(data) {
    return withFileLock(FILE, () => {
      const logs = readJSON(FILE) || [];
      const entry = {
        id:        uuidv4(),
        ts:        new Date().toISOString(),
        level:     data.level     || LOG_LEVELS_UI.INFO,
        module:    data.module    || 'BOT',
        message:   data.message   || '',
        user:      data.user      || null,
        pair:      data.pair      || null,
        status:    data.status    || null,
        detail:    data.detail    || null,
      };
      logs.push(entry);
      if (logs.length > BOT_LOG_KEEP) logs.splice(0, logs.length - BOT_LOG_KEEP);
      writeJSON(FILE, logs);
      return entry;
    });
  },

  clear() { writeJSON(FILE, []); },
  count() { return botLogsStore.getAll().length; },
};

module.exports = botLogsStore;
