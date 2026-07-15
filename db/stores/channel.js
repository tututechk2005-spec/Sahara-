'use strict';
const { readJSON, writeJSON, withFileLock } = require('../jsonStore');
const { config } = require('../../config');

const FILE = config.paths.channel;

function defaults() {
  return { channel_id: '', enabled: false, messages: {} };
}

const channelStore = {
  get() {
    return { ...defaults(), ...(readJSON(FILE) || {}) };
  },
  async update(patch) {
    return withFileLock(FILE, () => {
      const updated = { ...channelStore.get(), ...patch };
      writeJSON(FILE, updated);
      return updated;
    });
  },
  async saveMessageId(signalId, messageId) {
    return withFileLock(FILE, () => {
      const cur = channelStore.get();
      cur.messages = cur.messages || {};
      cur.messages[signalId] = { message_id: messageId };
      const keys = Object.keys(cur.messages);
      if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete cur.messages[k];
      writeJSON(FILE, cur);
      return true;
    });
  },
  getMessageId(signalId) {
    return channelStore.get().messages?.[signalId]?.message_id || null;
  },
};

module.exports = channelStore;
