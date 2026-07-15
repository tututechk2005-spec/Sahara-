'use strict';
const { readJSON, writeJSON, withFileLock } = require('../jsonStore');
const { config, SCAN_INTERVAL_SEC } = require('../../config');

const FILE = config.paths.settings;

function defaults() {
  return {
    scan_interval:   SCAN_INTERVAL_SEC,
    maintenance:     false,
    welcome_message: '',
    channel_id:      '',
    channel_enabled: false,
  };
}

const settingsStore = {
  get() {
    return { ...defaults(), ...(readJSON(FILE) || {}) };
  },
  async update(patch) {
    return withFileLock(FILE, () => {
      const updated = { ...settingsStore.get(), ...patch };
      writeJSON(FILE, updated);
      return updated;
    });
  },
};

module.exports = settingsStore;
