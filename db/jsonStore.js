'use strict';
const fs   = require('fs');
const path = require('path');
const logger = require('../lib/logger');
const { createKeyedLock } = require('../lib/utils');
const { DB_BACKUP_DIR, DB_BACKUP_KEEP } = require('../config');

const withLock = createKeyedLock();

function ensureDirFor(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function ensureBackupDir() {
  if (!fs.existsSync(DB_BACKUP_DIR)) fs.mkdirSync(DB_BACKUP_DIR, { recursive: true });
}

function backupPathFor(filePath, ts) {
  const base = path.basename(filePath);
  return path.join(DB_BACKUP_DIR, `${base}.${ts}.bak`);
}

/** Keep only the most recent DB_BACKUP_KEEP backups for a given file. */
function pruneBackups(filePath) {
  try {
    const base = path.basename(filePath);
    ensureBackupDir();
    const files = fs.readdirSync(DB_BACKUP_DIR)
      .filter((f) => f.startsWith(base + '.') && f.endsWith('.bak'))
      .sort(); // timestamp-prefixed names sort chronologically
    const excess = files.length - DB_BACKUP_KEEP;
    for (let i = 0; i < excess; i++) {
      try { fs.unlinkSync(path.join(DB_BACKUP_DIR, files[i])); } catch { /* ignore */ }
    }
  } catch { /* never let backup housekeeping break a write */ }
}

/** Snapshot the current on-disk file into the backup directory before overwriting it. */
function snapshotBeforeWrite(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    ensureBackupDir();
    const ts = Date.now();
    fs.copyFileSync(filePath, backupPathFor(filePath, ts));
    pruneBackups(filePath);
  } catch (err) {
    logger.warn('[DB-BACKUP] snapshot failed', { file: filePath, err: err.message });
  }
}

/** Find the newest valid backup for a corrupted file, used for auto-recovery. */
function findLatestValidBackup(filePath) {
  try {
    const base = path.basename(filePath);
    if (!fs.existsSync(DB_BACKUP_DIR)) return null;
    const files = fs.readdirSync(DB_BACKUP_DIR)
      .filter((f) => f.startsWith(base + '.') && f.endsWith('.bak'))
      .sort()
      .reverse();
    for (const f of files) {
      const full = path.join(DB_BACKUP_DIR, f);
      try {
        const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
        return parsed;
      } catch { /* try the next older backup */ }
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Read JSON from disk. If the file is missing, returns null (caller decides
 * the default shape). If the file exists but is corrupted, attempts recovery
 * from the most recent backup and logs loudly — it never throws.
 */
function readJSON(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw || !raw.trim()) return null;
    return JSON.parse(raw);
  } catch (err) {
    logger.error('[DB-CORRUPT] Failed to parse JSON — attempting backup recovery', { file: filePath, err: err.message });
    const recovered = findLatestValidBackup(filePath);
    if (recovered !== null) {
      logger.warn('[DB-RECOVERED] Restored from latest backup', { file: filePath });
      try { writeJSONSync(filePath, recovered, { skipSnapshot: true }); } catch { /* ignore */ }
      return recovered;
    }
    logger.error('[DB-RECOVERY-FAILED] No valid backup found', { file: filePath });
    return null;
  }
}

/**
 * Atomic write: write to a temp file in the same directory, fsync, then
 * rename over the destination. Rename is atomic on POSIX filesystems, so a
 * crash mid-write can never leave a half-written / corrupted JSON file.
 * A timestamped backup of the previous version is taken first.
 */
function writeJSONSync(filePath, data, { skipSnapshot = false } = {}) {
  ensureDirFor(filePath);
  if (!skipSnapshot) snapshotBeforeWrite(filePath);

  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const json    = JSON.stringify(data, null, 2);

  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeFileSync(fd, json, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
  return true;
}

function writeJSON(filePath, data) {
  try {
    return writeJSONSync(filePath, data);
  } catch (err) {
    logger.error('[DB-WRITE-FAILED]', { file: filePath, err: err.message });
    return false;
  }
}

/**
 * Read-modify-write a JSON file under a per-file async lock so concurrent
 * handlers can never interleave writes (the #1 cause of JSON DB corruption).
 */
async function withFileLock(filePath, fn) {
  return withLock(filePath, fn);
}

module.exports = {
  readJSON,
  writeJSON,
  withFileLock,
  ensureDirFor,
};
