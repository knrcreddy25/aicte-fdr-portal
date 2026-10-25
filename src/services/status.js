'use strict';

const { getDb } = require('../db/db');

/**
 * getToday()
 * Single source of truth for "today" across the entire application.
 * Reads settings.demo_today first; falls back to real date.
 * Returns a Date object with time zeroed to midnight UTC.
 *
 * NO other part of the codebase should call `new Date()` for business logic.
 */
function getToday() {
  const db = getDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'demo_today'`).get();
  if (row && row.value && row.value.trim() !== '') {
    const d = new Date(row.value.trim() + 'T00:00:00.000Z');
    if (!isNaN(d.getTime())) return d;
  }
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

/**
 * getTodayStr()
 * Returns today's date as YYYY-MM-DD string.
 */
function getTodayStr() {
  return getToday().toISOString().slice(0, 10);
}

/**
 * daysBetween(dateStrA, dateStrB)
 * Returns dateStrB - dateStrA in whole days (positive = B is after A).
 */
function daysBetween(dateStrA, dateStrB) {
  const a = new Date(dateStrA + 'T00:00:00.000Z');
  const b = new Date(dateStrB + 'T00:00:00.000Z');
  return Math.round((b - a) / 86400000);
}

/**
 * getTimingStatus(fdr)
 * Derives the timing status of an FDR at read time.
 * Does NOT read from the database — pass the fdr row object.
 *
 * Returns one of:
 *   'Superseded'     — has superseded_by_id
 *   'Matured'        — maturity_date < today
 *   'Expiring Soon'  — 0–90 days to maturity (configurable)
 *   'Active'         — otherwise
 *
 * Never stored in the database.
 */
function getTimingStatus(fdr, reminderDays = null) {
  if (fdr.superseded_by_id) return 'Superseded';

  const today = getToday();
  const maturity = new Date(fdr.maturity_date + 'T00:00:00.000Z');
  const daysToMaturity = Math.round((maturity - today) / 86400000);

  if (daysToMaturity < 0) return 'Matured';

  // Configurable threshold — default 90 days
  let threshold = 90;
  if (reminderDays === null) {
    try {
      const db = getDb();
      const row = db.prepare(`SELECT value FROM settings WHERE key = 'reminder_days'`).get();
      if (row && row.value) {
        const parts = row.value.split(',').map(Number).filter(Boolean);
        if (parts.length > 0) threshold = Math.max(...parts);
      }
    } catch (_) { /* use default */ }
  } else {
    threshold = reminderDays;
  }

  if (daysToMaturity <= threshold) return 'Expiring Soon';
  return 'Active';
}

/**
 * getBadgeInfo(status, type)
 * Returns { label, cssClass } for Bootstrap badge rendering.
 *
 * type: 'verification' | 'timing' | 'release' | 'severity' | 'doc'
 */
function getBadgeInfo(status, type) {
  const maps = {
    verification: {
      'Pending Review':    { label: 'Pending Review',   cssClass: 'bg-warning text-dark' },
      'Under Review':      { label: 'Under Review',     cssClass: 'bg-info text-dark' },
      'Verified':          { label: 'Verified',          cssClass: 'bg-success' },
      'Discrepancy Found': { label: 'Discrepancy Found', cssClass: 'bg-danger' },
      'Rejected':          { label: 'Rejected',          cssClass: 'bg-secondary' },
    },
    timing: {
      'Active':       { label: 'Active',        cssClass: 'bg-success' },
      'Expiring Soon':{ label: 'Expiring Soon', cssClass: 'bg-warning text-dark' },
      'Matured':      { label: 'Matured',       cssClass: 'bg-danger' },
      'Superseded':   { label: 'Superseded',    cssClass: 'bg-secondary' },
    },
    release: {
      'None':              { label: 'No Release Request', cssClass: 'bg-light text-dark border' },
      'Requested':         { label: 'Release Requested',  cssClass: 'bg-primary' },
      'Recommended':       { label: 'Recommended',        cssClass: 'bg-info text-dark' },
      'Approved-Released': { label: 'Released',           cssClass: 'bg-success' },
      'Rejected':          { label: 'Release Rejected',   cssClass: 'bg-danger' },
    },
    severity: {
      'High':   { label: 'High',   cssClass: 'bg-danger' },
      'Medium': { label: 'Medium', cssClass: 'bg-warning text-dark' },
      'Low':    { label: 'Low',    cssClass: 'bg-info text-dark' },
    },
    doc: {
      'Uploaded': { label: 'Uploaded', cssClass: 'bg-info text-dark' },
      'Accepted': { label: 'Accepted', cssClass: 'bg-success' },
      'Rejected': { label: 'Rejected', cssClass: 'bg-danger' },
    },
    trust: {
      'Institution-submitted':   { label: 'Institution-submitted',    cssClass: 'bg-warning text-dark' },
      'Officer-verified':        { label: 'Officer-verified',          cssClass: 'bg-success' },
      'Bank-confirmed (simulated)': { label: 'Bank-confirmed (sim.)', cssClass: 'bg-primary' },
    }
  };

  const map = maps[type] || {};
  return map[status] || { label: status || 'Unknown', cssClass: 'bg-secondary' };
}

/**
 * getTrustTag(fdr)
 * Returns the trust tag string for an FDR.
 */
function getTrustTag(fdr) {
  if (fdr.bank_confirmation === 'Simulated - Confirmed') return 'Bank-confirmed (simulated)';
  if (fdr.verification_status === 'Verified') return 'Officer-verified';
  return 'Institution-submitted';
}

/**
 * enrichFdr(fdr)
 * Attaches derived fields to an FDR row object:
 *   .timingStatus, .trustTag, .daysToMaturity
 * Returns the same object (mutated for convenience).
 */
function enrichFdr(fdr) {
  fdr.timingStatus = getTimingStatus(fdr);
  fdr.trustTag = getTrustTag(fdr);
  const today = getToday();
  const maturity = new Date(fdr.maturity_date + 'T00:00:00.000Z');
  fdr.daysToMaturity = Math.round((maturity - today) / 86400000);
  return fdr;
}

module.exports = {
  getToday,
  getTodayStr,
  daysBetween,
  getTimingStatus,
  getBadgeInfo,
  getTrustTag,
  enrichFdr,
};
