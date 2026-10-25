'use strict';

/**
 * discrepancy.js
 * Runs the 12-rule discrepancy engine against an FDR.
 *
 * Rules:
 *  R01 High   Missing document — no accepted/uploaded document
 *  R02 High   Maturity date mismatch — declared vs extracted
 *  R03 High   Amount mismatch — declared vs extracted
 *  R04 High   FDR number mismatch — declared vs extracted
 *  R05 Medium Bank name mismatch — normalized comparison
 *  R06 Medium Issue date mismatch — declared vs extracted
 *  R07 High   Already matured at submission
 *  R08 High   Invalid tenure — maturity before issue date
 *  R09 High   Duplicate FDR number across system
 *  R10 High   Renewal lapse — old FDR matured with no replacement
 *  R11 Medium Replacement amount lower than original
 *  R12 High   Duplicate document file hash (possible reuse)
 *
 * Entry point: runDiscrepancyEngine(fdrId)
 * - Opens discrepancies for newly detected violations (one per rule per FDR)
 * - Does NOT re-open already Resolved or Waived discrepancies
 * - Does NOT duplicate already-Open discrepancies
 */

const { getDb } = require('../db/db');
const { getToday, getTodayStr } = require('./status');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize bank name for comparison: lowercase, collapse whitespace, strip punctuation */
function normalizeBankName(name) {
  if (!name) return '';
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

/** Compare two date strings (YYYY-MM-DD). Returns true if equal. */
function datesMatch(a, b) {
  if (!a || !b) return false;
  return a.trim() === b.trim();
}

/** Compare two amounts. Returns true if equal within a small tolerance. */
function amountsMatch(a, b) {
  if (a == null || b == null) return false;
  return Math.abs(Number(a) - Number(b)) < 0.01;
}

/**
 * raiseDiscrepancy(db, fdrId, ruleCode, severity, message)
 * Inserts an Open discrepancy ONLY if no Open discrepancy with the same
 * rule_code already exists for this fdr_id.
 */
function raiseDiscrepancy(db, fdrId, ruleCode, severity, message) {
  const existing = db.prepare(`
    SELECT id FROM discrepancies
    WHERE fdr_id = ? AND rule_code = ? AND status = 'Open'
  `).get(fdrId, ruleCode);

  if (existing) return null; // Already open — skip

  const result = db.prepare(`
    INSERT INTO discrepancies (fdr_id, rule_code, severity, message, status, raised_at)
    VALUES (?, ?, ?, ?, 'Open', datetime('now'))
  `).run(fdrId, ruleCode, severity, message);

  return result.lastInsertRowid;
}

// ---------------------------------------------------------------------------
// Main engine
// ---------------------------------------------------------------------------

/**
 * runDiscrepancyEngine(fdrId)
 * Runs all applicable rules for a given FDR.
 * Returns { raised: string[], skipped: string[] } — rule codes.
 */
function runDiscrepancyEngine(fdrId) {
  const db = getDb();
  const raised = [];
  const skipped = [];

  const fdr = db.prepare(`SELECT * FROM fdrs WHERE id = ?`).get(fdrId);
  if (!fdr) throw new Error(`FDR id=${fdrId} not found`);

  const todayStr = getTodayStr();

  // Latest uploaded document (not rejected)
  const latestDoc = db.prepare(`
    SELECT * FROM fdr_documents
    WHERE fdr_id = ? AND doc_status != 'Rejected'
    ORDER BY version_no DESC LIMIT 1
  `).get(fdrId);

  // Latest extracted values (if any)
  const extracted = db.prepare(`
    SELECT * FROM document_extracted_values
    WHERE fdr_id = ?
    ORDER BY entered_at DESC LIMIT 1
  `).get(fdrId);

  // -------------------------------------------------------------------------
  // R01: Missing document
  // -------------------------------------------------------------------------
  if (!latestDoc) {
    if (raiseDiscrepancy(db, fdrId, 'R01', 'High',
      'R01: No document has been uploaded for this FDR.')) {
      raised.push('R01');
    } else skipped.push('R01');
  }

  // -------------------------------------------------------------------------
  // R02: Maturity date mismatch (only if extracted values exist)
  // -------------------------------------------------------------------------
  if (extracted && extracted.maturity_date) {
    if (!datesMatch(fdr.maturity_date, extracted.maturity_date)) {
      if (raiseDiscrepancy(db, fdrId, 'R02', 'High',
        `R02: Maturity date mismatch — declared: ${fdr.maturity_date}, document-extracted: ${extracted.maturity_date}.`)) {
        raised.push('R02');
      } else skipped.push('R02');
    }
  }

  // -------------------------------------------------------------------------
  // R03: Amount mismatch
  // -------------------------------------------------------------------------
  if (extracted && extracted.amount != null) {
    if (!amountsMatch(fdr.amount, extracted.amount)) {
      if (raiseDiscrepancy(db, fdrId, 'R03', 'High',
        `R03: Amount mismatch — declared: ₹${fdr.amount}, document-extracted: ₹${extracted.amount}.`)) {
        raised.push('R03');
      } else skipped.push('R03');
    }
  }

  // -------------------------------------------------------------------------
  // R04: FDR number mismatch
  // -------------------------------------------------------------------------
  if (extracted && extracted.fdr_number) {
    if (fdr.fdr_number.trim() !== extracted.fdr_number.trim()) {
      if (raiseDiscrepancy(db, fdrId, 'R04', 'High',
        `R04: FDR number mismatch — declared: ${fdr.fdr_number}, document-extracted: ${extracted.fdr_number}.`)) {
        raised.push('R04');
      } else skipped.push('R04');
    }
  }

  // -------------------------------------------------------------------------
  // R05: Bank name mismatch
  // -------------------------------------------------------------------------
  if (extracted && extracted.bank_name) {
    if (normalizeBankName(fdr.bank_name) !== normalizeBankName(extracted.bank_name)) {
      if (raiseDiscrepancy(db, fdrId, 'R05', 'Medium',
        `R05: Bank name mismatch — declared: "${fdr.bank_name}", document-extracted: "${extracted.bank_name}".`)) {
        raised.push('R05');
      } else skipped.push('R05');
    }
  }

  // -------------------------------------------------------------------------
  // R06: Issue date mismatch
  // -------------------------------------------------------------------------
  if (extracted && extracted.issue_date) {
    if (!datesMatch(fdr.issue_date, extracted.issue_date)) {
      if (raiseDiscrepancy(db, fdrId, 'R06', 'Medium',
        `R06: Issue date mismatch — declared: ${fdr.issue_date}, document-extracted: ${extracted.issue_date}.`)) {
        raised.push('R06');
      } else skipped.push('R06');
    }
  }

  // -------------------------------------------------------------------------
  // R07: Already matured at submission
  // -------------------------------------------------------------------------
  if (fdr.maturity_date <= todayStr) {
    // Only raise if this is a new FDR (not a superseded/renewed one being reviewed)
    if (!fdr.supersedes_fdr_id) {
      if (raiseDiscrepancy(db, fdrId, 'R07', 'High',
        `R07: FDR maturity date (${fdr.maturity_date}) is on or before today (${todayStr}) at time of submission.`)) {
        raised.push('R07');
      } else skipped.push('R07');
    }
  }

  // -------------------------------------------------------------------------
  // R08: Maturity before issue date
  // -------------------------------------------------------------------------
  if (fdr.maturity_date <= fdr.issue_date) {
    if (raiseDiscrepancy(db, fdrId, 'R08', 'High',
      `R08: Invalid tenure — maturity date (${fdr.maturity_date}) is not after issue date (${fdr.issue_date}).`)) {
      raised.push('R08');
    } else skipped.push('R08');
  }

  // -------------------------------------------------------------------------
  // R09: Duplicate FDR number across system (different FDR id, same number)
  // -------------------------------------------------------------------------
  const duplicate = db.prepare(`
    SELECT id FROM fdrs
    WHERE fdr_number = ? AND id != ?
    LIMIT 1
  `).get(fdr.fdr_number, fdrId);

  if (duplicate) {
    if (raiseDiscrepancy(db, fdrId, 'R09', 'High',
      `R09: FDR number "${fdr.fdr_number}" already exists in the system (FDR id=${duplicate.id}).`)) {
      raised.push('R09');
    } else skipped.push('R09');
  }

  // -------------------------------------------------------------------------
  // R10: Renewal lapse — this FDR is the old one that matured with no replacement
  // -------------------------------------------------------------------------
  if (fdr.maturity_date < todayStr && !fdr.superseded_by_id) {
    // Only raise if it's not a brand-new submission (i.e. it actually existed before)
    // We check: it was not submitted today
    const submittedToday = fdr.created_at && fdr.created_at.slice(0, 10) === todayStr;
    if (!submittedToday) {
      if (raiseDiscrepancy(db, fdrId, 'R10', 'High',
        `R10: Renewal lapse — FDR matured on ${fdr.maturity_date} with no replacement/renewal submitted.`)) {
        raised.push('R10');
      } else skipped.push('R10');
    }
  }

  // -------------------------------------------------------------------------
  // R11: Replacement amount lower than original
  // -------------------------------------------------------------------------
  if (fdr.supersedes_fdr_id) {
    const original = db.prepare(`SELECT amount FROM fdrs WHERE id = ?`).get(fdr.supersedes_fdr_id);
    if (original && fdr.amount < original.amount) {
      if (raiseDiscrepancy(db, fdrId, 'R11', 'Medium',
        `R11: Replacement FDR amount (₹${fdr.amount}) is lower than original FDR amount (₹${original.amount}).`)) {
        raised.push('R11');
      } else skipped.push('R11');
    }
  }

  // -------------------------------------------------------------------------
  // R12: Duplicate document file hash (possible reuse across FDRs)
  // -------------------------------------------------------------------------
  if (latestDoc) {
    const hashDuplicate = db.prepare(`
      SELECT d.fdr_id FROM fdr_documents d
      WHERE d.sha256 = ? AND d.fdr_id != ?
      LIMIT 1
    `).get(latestDoc.sha256, fdrId);

    if (hashDuplicate) {
      if (raiseDiscrepancy(db, fdrId, 'R12', 'High',
        `R12: Document file hash matches a document already uploaded for FDR id=${hashDuplicate.fdr_id}. Possible document reuse.`)) {
        raised.push('R12');
      } else skipped.push('R12');
    }
  }

  return { raised, skipped };
}

/**
 * hasOpenHighDiscrepancy(fdrId)
 * Returns true if the FDR has any Open High-severity discrepancy.
 * Used to block Verified status.
 */
function hasOpenHighDiscrepancy(fdrId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT id FROM discrepancies
    WHERE fdr_id = ? AND severity = 'High' AND status = 'Open'
    LIMIT 1
  `).get(fdrId);
  return !!row;
}

/**
 * getDiscrepanciesForFdr(fdrId)
 * Returns all discrepancy rows for an FDR, newest first.
 */
function getDiscrepanciesForFdr(fdrId) {
  const db = getDb();
  return db.prepare(`
    SELECT d.*, u.name AS resolved_by_name
    FROM discrepancies d
    LEFT JOIN users u ON u.id = d.resolved_by
    WHERE d.fdr_id = ?
    ORDER BY
      CASE d.status WHEN 'Open' THEN 0 ELSE 1 END,
      CASE d.severity WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END,
      d.raised_at DESC
  `).all(fdrId);
}

module.exports = {
  runDiscrepancyEngine,
  hasOpenHighDiscrepancy,
  getDiscrepanciesForFdr,
  normalizeBankName,
};
