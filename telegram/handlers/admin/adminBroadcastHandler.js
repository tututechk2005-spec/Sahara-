'use strict';
const db = require('../../../db');
const sessionManager = require('../../sessionManager');
const broadcastService = require('../../../services/broadcastService');
const { BROADCAST_AUDIENCES } = require('../../../config');
const Markup = require('telegraf').Markup;

function safeAnswer(ctx, t) { try { return ctx.answerCbQuery(t); } catch {} }
async function renderText(ctx, text, extra) {
  try { return await ctx.editMessageText(text, { parse_mode: 'Markdown', ...extra }); }
  catch { return ctx.reply(text, { parse_mode: 'Markdown', ...extra }); }
}

function broadcastListText(broadcasts) {
  if (!broadcasts.length) return '📢 *Broadcasts*\n\nNo broadcasts yet.';
  return '📢 *Broadcasts*\n\n' +
    broadcasts.map((b) => `• [${b.status.toUpperCase()}] ${b.type} → ${b.audience} | ${b.stats.success || 0}/${b.stats.total || 0} sent\n  ${b.created_at ? new Date(b.created_at).toLocaleString() : ''}`).join('\n');
}

const adminBroadcastHandler = {
  async panel(ctx) {
    await safeAnswer(ctx);
    const recent = db.broadcasts.recent(8);
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('📝 New Broadcast', 'broadcast_new')],
      [Markup.button.callback('⬅️ Admin Panel', 'admin_panel')],
    ]);
    return renderText(ctx, broadcastListText(recent), keyboard);
  },

  async startNew(ctx) {
    await safeAnswer(ctx);
    sessionManager.set(ctx.from.id, { flow: 'admin_broadcast_v2', step: 'await_audience' });
    return renderText(ctx,
      '📢 *New Broadcast*\n\nWho should receive this message?',
      Markup.inlineKeyboard([
        [Markup.button.callback('👥 All Users',     'bc_audience_all')],
        [Markup.button.callback('💎 Premium Only',  'bc_audience_premium')],
        [Markup.button.callback('🔰 Trial Only',    'bc_audience_trial')],
        [Markup.button.callback('❌ Cancel',        'admin_broadcast')],
      ])
    );
  },

  async setAudience(ctx, audience) {
    await safeAnswer(ctx);
    const session = sessionManager.get(ctx.from.id) || {};
    session.audience = audience;
    session.step = 'await_content';
    sessionManager.set(ctx.from.id, session);
    return renderText(ctx,
      '📢 *New Broadcast*\n\n' +
      'Now send the message content.\n\n' +
      'You can send: text, photo, video, document, audio, voice, GIF, sticker, or a Telegram post link.\n\n' +
      'For buttons, after sending content reply with:\n`BUTTON: Button Text | https://url.com`\n\nSend /cancel to abort.',
      Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'admin_broadcast')]])
    );
  },

  async handleMessageInput(ctx) {
    const session = sessionManager.get(ctx.from.id);
    if (!session || session.flow !== 'admin_broadcast_v2') return false;
    const msg = ctx.message;
    if (!msg) return false;

    const text = msg.text || '';
    if (text === '/cancel') { sessionManager.clear(ctx.from.id); await ctx.reply('❌ Cancelled.'); return true; }

    if (session.step === 'await_content') {
      let type = 'text', content = '', caption = null;
      if (msg.photo)     { type = 'photo';     content = msg.photo[msg.photo.length - 1].file_id; caption = msg.caption; }
      else if (msg.video)    { type = 'video';     content = msg.video.file_id;       caption = msg.caption; }
      else if (msg.document) { type = 'document';  content = msg.document.file_id;    caption = msg.caption; }
      else if (msg.audio)    { type = 'audio';     content = msg.audio.file_id;       caption = msg.caption; }
      else if (msg.voice)    { type = 'voice';     content = msg.voice.file_id; }
      else if (msg.animation){ type = 'animation'; content = msg.animation.file_id;   caption = msg.caption; }
      else if (msg.sticker)  { type = 'sticker';   content = msg.sticker.file_id; }
      else                   { content = text; }

      session.content = content;
      session.type    = type;
      session.caption = caption;
      session.step    = 'await_options';
      sessionManager.set(ctx.from.id, session);

      await ctx.reply(
        '✅ Content received. Options:',
        Markup.inlineKeyboard([
          [Markup.button.callback('📌 Pin message', 'bc_opt_pin'), Markup.button.callback('⏰ Schedule', 'bc_opt_schedule')],
          [Markup.button.callback('🚀 Send now', 'bc_send_now'), Markup.button.callback('❌ Cancel', 'admin_broadcast')],
        ])
      );
      return true;
    }

    if (session.step === 'await_schedule') {
      // Expect ISO or "YYYY-MM-DD HH:MM" format
      const d = new Date(text.includes('T') ? text : text.replace(' ', 'T') + ':00');
      if (isNaN(d.getTime())) { await ctx.reply('⚠️ Invalid date. Use format: 2026-12-31 14:30'); return true; }
      session.schedule_at = d.toISOString();
      session.step = 'await_options';
      sessionManager.set(ctx.from.id, session);
      await ctx.reply(`⏰ Scheduled for ${d.toLocaleString()}. Tap Send to confirm.`,
        Markup.inlineKeyboard([[Markup.button.callback('🚀 Confirm & Schedule', 'bc_send_now'), Markup.button.callback('❌ Cancel', 'admin_broadcast')]]));
      return true;
    }
    return false;
  },

  async setPinOption(ctx) {
    await safeAnswer(ctx);
    const session = sessionManager.get(ctx.from.id) || {};
    session.pin = !session.pin;
    sessionManager.set(ctx.from.id, session);
    await ctx.answerCbQuery(session.pin ? '📌 Will pin' : '📌 Pin removed');
  },

  async setSchedule(ctx) {
    await safeAnswer(ctx);
    const session = sessionManager.get(ctx.from.id) || {};
    session.step = 'await_schedule';
    sessionManager.set(ctx.from.id, session);
    return renderText(ctx, '⏰ Send the schedule date/time:\nFormat: `2026-12-31 14:30` (server local time)', Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'admin_broadcast')]]));
  },

  async sendNow(ctx) {
    await safeAnswer(ctx, 'Sending...');
    const session = sessionManager.get(ctx.from.id);
    if (!session) return;
    sessionManager.clear(ctx.from.id);

    const b = await db.broadcasts.create({
      type:        session.type    || 'text',
      content:     session.content || '',
      caption:     session.caption || null,
      audience:    session.audience || BROADCAST_AUDIENCES.ALL,
      pin:         session.pin  || false,
      schedule_at: session.schedule_at || null,
      created_by:  ctx.from.id,
    });

    if (b.schedule_at) {
      await ctx.reply(`⏰ Broadcast scheduled for ${new Date(b.schedule_at).toLocaleString()}.`);
      return;
    }

    await ctx.reply('📢 Sending broadcast...');
    try {
      const stats = await broadcastService.send(b.id, ctx.telegram);
      await ctx.reply(`✅ Broadcast complete!\n\n✅ Sent: ${stats.success}\n❌ Failed: ${stats.failed}\n👥 Total: ${stats.total}`);
    } catch (err) {
      await ctx.reply(`❌ Broadcast failed: ${err.message}`);
    }
  },

  async deleteById(ctx, id) {
    await safeAnswer(ctx);
    await broadcastService.delete(id);
    return adminBroadcastHandler.panel(ctx);
  },

  async unpinById(ctx, id) {
    await safeAnswer(ctx);
    await ctx.reply('Unpinning...');
    await broadcastService.unpin(id, ctx.telegram);
    await ctx.reply('✅ Unpinned.');
  },
};

module.exports = adminBroadcastHandler;
