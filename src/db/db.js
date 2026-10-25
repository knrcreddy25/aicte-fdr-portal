'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { initSchema } = require('./schema');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'portal.db');

// Singleton connection
let _db = null;

function getDb() {
  if (_db) return _db;

  // Ensure data directory exists
  const fs = require('fs');
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  _db = new Database(DB_PATH);

  // Performance pragmas (safe for single-writer SQLite)
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('synchronous = NORMAL');

  // Initialize schema
  initSchema(_db);

  return _db;
}

/**
 * Seed default settings if not already present.
 * Call after getDb() during startup or seed.
 */
function seedDefaultSettings(db) {
  const defaults = [
    { key: 'reminder_days',          value: '90,60,30,7' },
    { key: 'escalation_after_days',  value: '14' },
    { key: 'demo_today',             value: '' },   // empty = use real date
    {
      key: 'release_checklist_template',
      value: JSON.stringify([
        'FDR has been verified by AICTE Officer',
        'No open discrepancies exist on this FDR',
        'No pending renewal obligation for this FDR',
        'Institution declares all prescribed conditions are fulfilled',
        'Applicable lock-in / regulatory period has elapsed'
      ])
    }
  ];

  const upsert = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO NOTHING
  `);

  for (const { key, value } of defaults) {
    upsert.run(key, value);
  }
}

module.exports = { getDb, seedDefaultSettings };
