'use strict';
const { config, validateConfig } = require('./config');
const logger    = require('./lib/logger');
const db        = require('./db');
const botLogger = require('./services/botLogger');

process.on('uncaughtException',  (err) => { botLogger.error('SYSTEM', 'Uncaught exception', { detail: err.message }); });
process.on('unhandledRejection', (r)   => { botLogger.error('SYSTEM', 'Unhandled rejection', { detail: r?.message || String(r) }); });

async function main() {
  validateConfig();
  logger.info('[STARTUP] Configuration OK');

  const cleanup = await db.cleanOrphansAndDuplicates();
  botLogger.dbConnected();
  logger.info('[STARTUP] DB integrity check', cleanup);

  const { createBot, launchWithAutoReconnect } = require('./telegram/bot');
  const botInstance = require('./telegram/botInstance');
  const scheduler   = require('./scheduler');

  const bot = createBot();
  botInstance.setBot(bot);
  botLogger.botStarted();

  await launchWithAutoReconnect(bot);

  scheduler.start(bot);
  logger.info('[STARTUP] Scheduler started — 24/7 sniper scanning active.');

  try {
    const http   = require('http');
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    });
    server.listen(config.env.port, () => logger.info(`[STARTUP] Health endpoint :${config.env.port}`));
  } catch (err) {
    logger.warn('[STARTUP] Health endpoint failed (non-fatal)', { err: err.message });
  }

  const shutdown = (sig) => {
    logger.info(`[SHUTDOWN] ${sig}`);
    scheduler.stop();
    try { bot.stop(sig); } catch { /* ignore */ }
    setTimeout(() => process.exit(0), 1000);
  };
  process.once('SIGINT',  () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  logger.info('[STARTUP] Bot fully online.');
}

main().catch((err) => {
  logger.error('[FATAL]', { err: err.message, stack: err.stack });
  process.exit(1);
});
