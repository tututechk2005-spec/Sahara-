'use strict';
const { v4: uuidv4 } = require('uuid');
const { readJSON, writeJSON, withFileLock } = require('../jsonStore');
const { config } = require('../../config');

const FILE = config.paths.broadcasts;

const broadcastsStore = {
  getAll() { return readJSON(FILE) || []; },
  findById(id) { return broadcastsStore.getAll().find((b) => b.id === id) || null; },

  recent(n = 20) {
    return broadcastsStore.getAll()
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, n);
  },

  async create(data) {
    return withFileLock(FILE, () => {
      const all = readJSON(FILE) || [];
      const entry = {
        id:           uuidv4(),
        type:         data.type        || 'text',  // text|photo|video|document|audio|voice|animation|sticker
        content:      data.content     || '',
        caption:      data.caption     || '',
        parse_mode:   data.parse_mode  || 'Markdown',
        audience:     data.audience    || 'all',   // all|premium|trial
        pinned:       data.pinned      || false,
        scheduled_at: data.scheduled_at || null,
        status:       'pending',                   // pending|sending|done|failed|scheduled
        stats: { sent: 0, failed: 0, total: 0 },
        message_ids:  {},
        created_at:   new Date().toISOString(),
        sent_at:      null,
        created_by:   data.created_by || null,
      };
      all.push(entry);
      writeJSON(FILE, all);
      return entry;
    });
  },

  async update(id, patch) {
    return withFileLock(FILE, () => {
      const all = readJSON(FILE) || [];
      const idx = all.findIndex((b) => b.id === id);
      if (idx === -1) return null;
      all[idx] = { ...all[idx], ...patch };
      writeJSON(FILE, all);
      return all[idx];
    });
  },

  async delete(id) {
    return withFileLock(FILE, () => {
      const all = readJSON(FILE) || [];
      writeJSON(FILE, all.filter((b) => b.id !== id));
      return true;
    });
  },

  async recordSent(id, userId, messageId) {
    return withFileLock(FILE, () => {
      const all = readJSON(FILE) || [];
      const idx = all.findIndex((b) => b.id === id);
      if (idx === -1) return null;
      all[idx].stats.sent++;
      all[idx].message_ids[String(userId)] = messageId;
      writeJSON(FILE, all);
      return all[idx];
    });
  },

  async recordFailed(id) {
    return withFileLock(FILE, () => {
      const all = readJSON(FILE) || [];
      const idx = all.findIndex((b) => b.id === id);
      if (idx === -1) return null;
      all[idx].stats.failed++;
      writeJSON(FILE, all);
      return all[idx];
    });
  },

  pendingScheduled() {
    const now = new Date().toISOString();
    return broadcastsStore.getAll().filter((b) =>
      b.status === 'scheduled' && b.scheduled_at && b.scheduled_at <= now
    );
  },
};

module.exports = broadcastsStore;
