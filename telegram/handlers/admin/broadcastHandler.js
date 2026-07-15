'use strict';
const db               = require('../../../db');
const sessionManager   = require('../../sessionManager');
const broadcastService = require('../../../services/broadcastService');
const { BROADCAST_AUDIENCES } = require('../../../config');
const { config } = require('../../../config');

function isAdmin(ctx) { return String(ctx.from.id) === String(config.bot.adminChatId); }
function safeAnswer(ctx, t) { try { return ctx.answerCbQuery(t); } catch { /* ignore */ } }
async function renderText(ctx, text, extra) {
  try { return await ctx.editMessageText(text, { parse_mode: 'Markdown', ...extra }); }
  catch { return ctx.reply(text, { parse_mode: 'Markdown', ...extra }); }
}

function broadcastMenu() {
  return { reply_markup: { inline_keyboard: [
    [{ text: '📝 Text', callback_data: 'bcast_type_text' }, { text: '🖼 Photo', callback_data: 'bcast_type_photo' }],
    [{ text: '🎬 Video', callback_data: 'bcast_type_video' }, { text: '📎 Document', callback_data: 'bcast_type_document' }],
    [{ text: '🎵 Audio', callback_data: 'bcast_type_audio' }, { text: '🎤 Voice', callback_data: 'bcast_type_voice' }],
    [{ text: '🎞 GIF', callback_data: 'bcast_type_animation' }, { text: '🎭 Sticker', callback_data: 'bcast_type_sticker' }],
    [{ text: '📋 Broadcast History', callback_data: 'bcast_history' }],
    [{ text: '⬅️ Admin Panel', callback_data: 'admin_panel' }],
  ]}};
}

function audienceMenu(type) {
  return { reply_markup: { inline_keyboard: [
    [{ text: '📢 All Users', callback_data: `bcast_aud_all_${type}` }],
    [{ text: '👑 Premium Only', callback_data: `bcast_aud_premium_${type}` }],
    [{ text: '🔔 Trial Only', callback_data: `bcast_aud_trial_${type}` }],
    [{ text: '⬅️ Cancel', callback_data: 'admin_broadcast' }],
  ]}};
}

const broadcastHandler = {
  async menu(ctx) {
    if (!isAdmin(ctx)) return;
    await safeAnswer(ctx);
    return renderText(ctx, '📢 *Broadcast Panel*\n\nChoose message type:', broadcastMenu());
  },

  async selectType(ctx, type) {
    if (!isAdmin(ctx)) return;
    await safeAnswer(ctx);
    sessionManager.set(ctx.from.id, { flow: 'broadcast', step: 'await_content', type });
    const prompts = {
      text: 'Send the text message to broadcast (Markdown supported):',
      photo: 'Send the photo (forward or upload) to broadcast:',
      video: 'Send the video file to broadcast:',
      document: 'Send the document/file to broadcast:',
      audio: 'Send the audio file to broadcast:',
      voice: 'Send the voice message to broadcast:',
      animation: 'Send the GIF to broadcast:',
      sticker: 'Send the sticker to broadcast:',
    };
    return renderText(ctx, `📢 *Broadcast — ${type}*\n\n${prompts[type] || 'Send content:'}\n\nSend /cancel to abort.`,
      { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'admin_broadcast' }]] }});
  },

  async history(ctx) {
    if (!isAdmin(ctx)) return;
    await safeAnswer(ctx);
    const recent = db.broadcasts.recent(10);
    if (!recent.length) return renderText(ctx, '📋 No broadcasts yet.', { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'admin_broadcast' }]] }});
    const lines = recent.map((b) =>
      `• [${b.status.toUpperCase()}] ${b.type} → ${b.audience} — ${b.stats?.sent || 0}✅ ${b.stats?.failed || 0}❌ (${new Date(b.created_at).toLocaleString()})`
    ).join('\n');
    const rows = recent.map((b) => [{ text: `🗑 Delete #${b.id.slice(0,8)}`, callback_data: `bcast_delete_${b.id}` }]);
    return renderText(ctx, `📋 *Recent Broadcasts*\n\n${lines}`, { reply_markup: { inline_keyboard: [...rows, [{ text: '⬅️ Back', callback_data: 'admin_broadcast' }]] }});
  },

  async delete(ctx, id) {
    if (!isAdmin(ctx)) return;
    await safeAnswer(ctx);
    await broadcastService.delete(ctx.telegram, id);
    return broadcastHandler.history(ctx);
  },

  /** Called from the text/media on handler. Returns true if it consumed the message. */
  async handleInput(ctx) {
    if (!isAdmin(ctx)) return false;
    const session = sessionManager.get(ctx.from.id);
    if (!session || session.flow !== 'broadcast') return false;

    const text = (ctx.message.text || '').trim();
    if (text === '/cancel') { sessionManager.clear(ctx.from.id); await ctx.reply('❌ Cancelled.'); return true; }

    if (session.step === 'await_content') {
      let content = '';
      const type = session.type || 'text';
      const msg  = ctx.message;
      if (type === 'text')       content = msg.text || '';
      else if (type === 'photo') content = msg.photo?.[msg.photo.length - 1]?.file_id || '';
      else if (type === 'video') content = msg.video?.file_id || '';
      else if (type === 'document') content = msg.document?.file_id || '';
      else if (type === 'audio')    content = msg.audio?.file_id || '';
      else if (type === 'voice')    content = msg.voice?.file_id || '';
      else if (type === 'animation') content = msg.animation?.file_id || '';
      else if (type === 'sticker')   content = msg.sticker?.file_id || '';
      else content = msg.text || '';

      if (!content) { await ctx.reply('⚠️ Could not extract content. Please try again.'); return true; }

      sessionManager.set(ctx.from.id, { ...session, step: 'await_audience', content,
        caption: msg.caption || '' });
      await ctx.reply('👥 Choose audience:', audienceMenu(type));
      return true;
    }
    return false;
  },

  async selectAudience(ctx, audience, type) {
    if (!isAdmin(ctx)) return;
    await safeAnswer(ctx);
    const session = sessionManager.get(ctx.from.id);
    const content = session?.content || '';
    const caption = session?.caption || '';
    sessionManager.clear(ctx.from.id);

    if (!content) return renderText(ctx, '⚠️ Session expired. Please restart.', { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'admin_broadcast' }]] }});

    const total = (audience === BROADCAST_AUDIENCES.PREMIUM ? db.users.countPremium()
      : audience === BROADCAST_AUDIENCES.TRIAL ? db.users.countTrial()
      : db.users.count());

    const sendingMsg = await ctx.telegram.sendMessage(ctx.from.id, `📢 Sending to *${total}* users...`, { parse_mode: 'Markdown' });
    const result = await broadcastService.create(ctx.telegram, { type, content, caption, audience, created_by: ctx.from.id });

    try {
      await ctx.telegram.editMessageText(ctx.from.id, sendingMsg.message_id, undefined,
        `✅ *Broadcast Complete*\n\n📤 Sent: ${result.sent || 0}\n❌ Failed: ${result.failed || 0}\n👥 Total: ${result.total || 0}`,
        { parse_mode: 'Markdown' });
    } catch { /* ignore */ }
    return true;
  },
};

module.exports = broadcastHandler;
