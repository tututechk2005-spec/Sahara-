'use strict';
const fs   = require('fs');
const path = require('path');

const LOG_DIR  = './logs';
const LOG_FILE = path.join(LOG_DIR, 'bot.log');
const ERR_FILE = path.join(LOG_DIR, 'error.log');
const MAX_SIZE = 5 * 1024 * 1024; // 5 MB rotate
const MAX_ROTATED = 3;

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

// Small in-memory ring buffer so admin "recent logs" doesn't need disk I/O.
const RING_SIZE = 300;
const ring = [];

function ensureDir() {
  try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }
}

function rotate(file) {
  try {
    if (!fs.existsSync(file)) return;
    if (fs.statSync(file).size <= MAX_SIZE) return;
    for (let i = MAX_ROTATED - 1; i >= 1; i--) {
      const src = `${file}.${i}`;
      const dst = `${file}.${i + 1}`;
      if (fs.existsSync(src)) { try { fs.renameSync(src, dst); } catch { /* ignore */ } }
    }
    fs.renameSync(file, `${file}.1`);
  } catch { /* never let logging crash the process */ }
}

function safeStringify(meta) {
  try { return JSON.stringify(meta); } catch { return '"[unserializable meta]"'; }
}

function write(level, msg, meta) {
  const ts   = new Date().toISOString();
  const line = meta !== undefined
    ? `[${ts}] [${level.toUpperCase()}] ${msg} ${safeStringify(meta)}`
    : `[${ts}] [${level.toUpperCase()}] ${msg}`;

  ring.push(line);
  if (ring.length > RING_SIZE) ring.shift();

  if (LEVELS[level] > currentLevel) return; // below configured verbosity

  // Console output — Render/Replit capture stdout for their own log viewers.
  if (level === 'error') console.error(line);
  else console.log(line);

  try {
    ensureDir();
    rotate(LOG_FILE);
    fs.appendFileSync(LOG_FILE, line + '\n');
    if (level === 'error') {
      rotate(ERR_FILE);
      fs.appendFileSync(ERR_FILE, line + '\n');
    }
  } catch { /* disk issues should never crash the bot */ }
}

const logger = {
  info:  (msg, meta) => write('info',  msg, meta),
  warn:  (msg, meta) => write('warn',  msg, meta),
  error: (msg, meta) => write('error', msg, meta),
  debug: (msg, meta) => write('debug', msg, meta),

  /** Returns the last N log lines straight from memory (fast, no disk I/O). */
  recentLines(n = 100) {
    return ring.slice(-n);
  },
};

module.exports = logger;
