'use strict';

/**
 * audit.js — The ONLY place that writes to the audit_log table.
 *
 * Hash chain: entry_hash = SHA-256(prev_hash + ts + actor_user_id + action + entity_type + entity_id + details_json)
 *
 * RULES:
 *  - No UPDATE or DELETE on audit_log anywhere in the codebase.
 *  - All audit writes must go through logAudit() in this file.
 *  - This is an append-only, tamper-evident log.
 */

const crypto = require('crypto');
const { getDb } = require('../db/db');

/**
 * logAudit(params)
 *
 * @param {object} params
 * @param {number|null} params.actorUserId   - User who performed the action (null for system)
 * @param {string|null} params.actorRole     - Role string (null for system)
 * @param {string}      params.action        - Action label e.g. 'FDR_SUBMITTED', 'USER_LOGIN'
 * @param {string}      params.entityType    - e.g. 'fdr', 'user', 'release_request', 'system'
 * @param {string|null} params.entityId      - ID of the entity (string for flexibility)
 * @param {object}      params.details       - Arbitrary details object (will be JSON-stringified)
 *
 * @returns {number} The inserted row id
 */
function logAudit({ actorUserId = null, actorRole = null, action, entityType, entityId = null, details = {} }) {
  const db = getDb();

  const ts = new Date().toISOString();
  const detailsJson = JSON.stringify(details);

  // Get previous hash (last row's entry_hash)
  const lastRow = db.prepare(`SELECT entry_hash FROM audit_log ORDER BY id DESC LIMIT 1`).get();
  const prevHash = lastRow ? lastRow.entry_hash : '';

  // Compute entry hash
  const hashInput = [
    prevHash,
    ts,
    String(actorUserId ?? ''),
    String(actorRole ?? ''),
    action,
    entityType,
    String(entityId ?? ''),
    detailsJson,
  ].join('|');

  const entryHash = crypto.createHash('sha256').update(hashInput).digest('hex');

  const stmt = db.prepare(`
    INSERT INTO audit_log
      (ts, actor_user_id, actor_role, action, entity_type, entity_id, details_json, prev_hash, entry_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    ts,
    actorUserId,
    actorRole,
    action,
    entityType,
    entityId !== null ? String(entityId) : null,
    detailsJson,
    prevHash,
    entryHash
  );

  return result.lastInsertRowid;
}

/**
 * verifyAuditChain()
 * Recomputes the hash chain from the first entry.
 *
 * @returns {{ ok: boolean, brokenAtId: number|null, message: string }}
 */
function verifyAuditChain() {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM audit_log ORDER BY id ASC`).all();

  if (rows.length === 0) {
    return { ok: true, brokenAtId: null, message: 'Audit log is empty — nothing to verify.' };
  }

  let prevHash = '';

  for (const row of rows) {
    const hashInput = [
      prevHash,
      row.ts,
      String(row.actor_user_id ?? ''),
      String(row.actor_role ?? ''),
      row.action,
      row.entity_type,
      String(row.entity_id ?? ''),
      row.details_json,
    ].join('|');

    const expected = crypto.createHash('sha256').update(hashInput).digest('hex');

    if (expected !== row.entry_hash) {
      return {
        ok: false,
        brokenAtId: row.id,
        message: `Chain broken at audit_log entry id=${row.id} (ts: ${row.ts}). Expected hash ${expected}, found ${row.entry_hash}.`
      };
    }

    prevHash = row.entry_hash;
  }

  return { ok: true, brokenAtId: null, message: `All ${rows.length} entries verified. Chain intact.` };
}

/**
 * getAuditLogs(filters)
 * Returns paginated audit log entries with optional filters.
 *
 * @param {object} filters
 * @param {string}  filters.entityType
 * @param {string}  filters.entityId
 * @param {number}  filters.actorUserId
 * @param {string}  filters.dateFrom   - YYYY-MM-DD
 * @param {string}  filters.dateTo     - YYYY-MM-DD
 * @param {number}  filters.page       - 1-indexed
 * @param {number}  filters.pageSize
 */
function getAuditLogs({ entityType, entityId, actorUserId, dateFrom, dateTo, page = 1, pageSize = 50 } = {}) {
  const db = getDb();
  const conditions = [];
  const params = [];

  if (entityType) { conditions.push(`a.entity_type = ?`); params.push(entityType); }
  if (entityId)   { conditions.push(`a.entity_id = ?`);   params.push(String(entityId)); }
  if (actorUserId){ conditions.push(`a.actor_user_id = ?`);params.push(actorUserId); }
  if (dateFrom)   { conditions.push(`a.ts >= ?`);          params.push(dateFrom); }
  if (dateTo)     { conditions.push(`a.ts <= ?`);          params.push(dateTo + 'T23:59:59'); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (page - 1) * pageSize;

  const rows = db.prepare(`
    SELECT a.*, u.name AS actor_name
    FROM audit_log a
    LEFT JOIN users u ON u.id = a.actor_user_id
    ${where}
    ORDER BY a.id DESC
    LIMIT ? OFFSET ?
  `).all([...params, pageSize, offset]);

  const countRow = db.prepare(`SELECT COUNT(*) AS cnt FROM audit_log a ${where}`).get(params);

  return { rows, total: countRow.cnt, page, pageSize };
}

module.exports = { logAudit, verifyAuditChain, getAuditLogs };
