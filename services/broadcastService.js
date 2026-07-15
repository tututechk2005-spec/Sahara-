'use strict';
const db          = require('../db');
const logger      = require('../lib/logger');
const { BROADCAST_AUDIENCES, BROADCAST_THROTTLE_MS } = require('../config');

function audienceUsers(audience) {
  const all = db.users.getAll();
  if (audience === BROADCAST_AUDIENCES.PREMIUM) return all.filter((u) => u.plan === 'premium' && u.subscription === 'active');
  if (audience === BROADCAST_AUDIENCES.TRIAL)   return all.filter((u) => u.plan === 'trial'   && u.subscription === 'active');
  return all;
}

/**
 * Sends one Telegram message of any type (text/photo/video/document/audio/voice/animation/sticker)
 * to a single user, returns { ok, messageId } or { ok: false, error }.
 */
async function sendToUser(telegram, userId, bcast) {
  const chatId = Number(userId);
  const extra  = {
    parse_mode: bcast.parse_mode || 'Markdown',
    ...(bcast.caption ? {} : {}),
  };

  try {
    let msg;
    const type = bcast.type || 'text';
    if (type === 'text')      msg = await telegram.sendMessage(chatId, bcast.content, extra);
    else if (type === 'photo') msg = await telegram.sendPhoto(chatId, bcast.content, { caption: bcast.caption, ...extra });
    else if (type === 'video') msg = await telegram.sendVideo(chatId, bcast.content, { caption: bcast.caption, ...extra });
    else if (type === 'document') msg = await telegram.sendDocument(chatId, bcast.content, { caption: bcast.caption, ...extra });
    else if (type === 'audio')    msg = await telegram.sendAudio(chatId, bcast.content, { caption: bcast.caption, ...extra });
    else if (type === 'voice')    msg = await telegram.sendVoice(chatId, bcast.content, { caption: bcast.caption, ...extra });
    else if (type === 'animation') msg = await telegram.sendAnimation(chatId, bcast.content, { caption: bcast.caption, ...extra });
    else if (type === 'sticker')   msg = await telegram.sendSticker(chatId, bcast.content);
    else                           msg = await telegram.sendMessage(chatId, bcast.content, extra);
    return { ok: true, messageId: msg.message_id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const broadcastService = {
  /** Creates a broadcast record and immediately sends it (or schedules it). */
  async create(telegram, data) {
    const bcast = await db.broadcasts.create({
      type:         data.type     || 'text',
      content:      data.content  || '',
      caption:      data.caption  || '',
      parse_mode:   data.parse_mode || 'Markdown',
      audience:     data.audience || BROADCAST_AUDIENCES.ALL,
      pinned:       data.pinned   || false,
      scheduled_at: data.scheduled_at || null,
      created_by:   data.created_by   || null,
    });

    if (data.scheduled_at && data.scheduled_at > new Date().toISOString()) {
      await db.broadcasts.update(bcast.id, { status: 'scheduled' });
      return { bcast, scheduled: true };
    }
    return broadcastService.send(telegram, bcast.id);
  },

  async send(telegram, broadcastId) {
    const bcast = db.broadcasts.findById(broadcastId);
    if (!bcast) return { ok: false, reason: 'NOT_FOUND' };

    const users = audienceUsers(bcast.audience);
    await db.broadcasts.update(broadcastId, { status: 'sending', stats: { sent: 0, failed: 0, total: users.length }, sent_at: new Date().toISOString() });

    let sent = 0, failed = 0;
    const pinnedIds = [];

    for (const u of users) {
      const result = await sendToUser(telegram, u.telegram_id, bcast);
      if (result.ok) {
        sent++;
        await db.broadcasts.recordSent(broadcastId, u.telegram_id, result.messageId);
        if (bcast.pinned) pinnedIds.push({ chatId: u.telegram_id, messageId: result.messageId });
      } else {
        failed++;
        await db.broadcasts.recordFailed(broadcastId);
      }
      await new Promise((r) => setTimeout(r, BROADCAST_THROTTLE_MS));
    }

    if (bcast.pinned) {
      for (const { chatId, messageId } of pinnedIds) {
        try { await telegram.pinChatMessage(chatId, messageId); } catch { /* ignore */ }
      }
    }

    await db.broadcasts.update(broadcastId, { status: 'done', stats: { sent, failed, total: users.length } });
    logger.info(`[BROADCAST] done id:${broadcastId} sent:${sent} failed:${failed} total:${users.length}`);
    return { ok: true, bcast: db.broadcasts.findById(broadcastId), sent, failed, total: users.length };
  },

  async delete(telegram, broadcastId) {
    const bcast = db.broadcasts.findById(broadcastId);
    if (!bcast) return { ok: false };
    for (const [uid, mid] of Object.entries(bcast.message_ids || {})) {
      try { await telegram.deleteMessage(Number(uid), mid); } catch { /* already deleted or not accessible */ }
    }
    await db.broadcasts.delete(broadcastId);
    return { ok: true };
  },

  async unpin(telegram, broadcastId) {
    const bcast = db.broadcasts.findById(broadcastId);
    if (!bcast) return { ok: false };
    for (const [uid, mid] of Object.entries(bcast.message_ids || {})) {
      try { await telegram.unpinChatMessage(Number(uid), mid); } catch { /* ignore */ }
    }
    return { ok: true };
  },

  /** Run on every monitoring cycle — fires any scheduled broadcasts that are now due. */
  async runScheduled(telegram) {
    const due = db.broadcasts.pendingScheduled();
    for (const b of due) {
      await broadcastService.send(telegram, b.id);
    }
  },
};

module.exports = broadcastService;
