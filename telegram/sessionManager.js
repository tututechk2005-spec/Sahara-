'use strict';
// Simple in-memory per-user conversation state. Lost on restart by design —
// nothing sensitive or important is ever stored only here; it just tracks
// "what step of a multi-message flow is this user on".
const sessions = new Map();

const sessionManager = {
  set(userId, state) { sessions.set(String(userId), { ...state, updatedAt: Date.now() }); },
  get(userId) { return sessions.get(String(userId)) || null; },
  clear(userId) { sessions.delete(String(userId)); },
  has(userId) { return sessions.has(String(userId)); },
};

module.exports = sessionManager;
