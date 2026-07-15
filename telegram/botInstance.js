'use strict';
const logger = require('../lib/logger');

let botRef = null;

module.exports = {
  setBot(bot) { botRef = bot; },

  async notifyUser(telegramId, text, extra = {}) {
    if (!botRef) return false;
    try {
      await botRef.telegram.sendMessage(telegramId, text, { parse_mode: 'Markdown', ...extra });
      return true;
    } catch (err) {
      logger.debug('[NOTIFY-FAILED]', { user: telegramId, err: err.message });
      return false;
    }
  },
};
