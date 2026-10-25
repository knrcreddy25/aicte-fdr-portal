'use strict';

/**
 * reminders.js
 * Nightly reminder and escalation job.
 *
 * Call runReminderJob() from node-cron or the admin "Run reminder job now" button.
 *
 * Logic:
 *  1. For each unsuperseded FDR, check if days-to-maturity crosses a configured
 *     threshold (90/60/30/7). Use fdr_reminders table to avoid duplicates.
 *  2. Escalation matrix:
 *     Level 1 — reminder to college (thresholds above)
 *     Level 2 — if matured with no renewal OR High discrepancy open > N days → notify Officer
 *     Level 3 — further N days with no Level 2 resolution → notify Approver
 */

const { getDb } = require('../db/db');
const { getTodayStr, daysBetween } = require('./status');
const { logAudit } = require('./audit');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSetting(db, key, defaultValue) {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
  return (row && row.value && row.value.trim() !== '') ? row.value.trim() : defaultValue;
}

function createNotification(db, userId, fdrId, type, message) {
  db.prepare(`
    INSERT INTO notifications (user_id, fdr_id, type, message, is_read, created_at)
    VALUES (?, ?, ?, ?, 0, datetime('now'))
  `).run(userId, fdrId, type, message);
}

function createOutboxEmail(db, toEmail, subject, body, fdrId = null) {
  db.prepare(`
    INSERT INTO email_outbox (to_email, subject, body, related_fdr_id, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(toEmail, subject, body, fdrId);
}

// ---------------------------------------------------------------------------
// Main job
// ---------------------------------------------------------------------------

/**
 * runReminderJob()
 * Returns a summary object with counts of actions taken.
 */
function runReminderJob() {
  const db = getDb();
  const todayStr = getTodayStr();

  const summary = {
    remindersCreated: 0,
    level2Escalations: 0,
    level3Escalations: 0,
    errors: [],
  };

  // Get configurable settings
  const reminderDaysStr = getSetting(db, 'reminder_days', '90,60,30,7');
  const thresholds = reminderDaysStr.split(',').map(Number).filter(Boolean).sort((a, b) => b - a);
  const escalationDays = parseInt(getSetting(db, 'escalation_after_days', '14'), 10);

  // Get all officer and approver user IDs
  const officers = db.prepare(`SELECT id, email FROM users WHERE role = 'officer'`).all();
  const approvers = db.prepare(`SELECT id, email FROM users WHERE role = 'approver'`).all();

  // Get all unsuperseded FDRs (superseded_by_id IS NULL)
  const fdrs = db.prepare(`
    SELECT f.*, i.contact_email AS inst_email, i.name AS inst_name,
           u.id AS college_user_id
    FROM fdrs f
    JOIN institutions i ON i.id = f.institution_id
    LEFT JOIN users u ON u.institution_id = f.institution_id AND u.role = 'college'
    WHERE f.superseded_by_id IS NULL
  `).all();

  for (const fdr of fdrs) {
    try {
      const daysToMaturity = daysBetween(todayStr, fdr.maturity_date);

      // -----------------------------------------------------------------------
      // Level 1: Threshold reminders to college
      // -----------------------------------------------------------------------
      for (const threshold of thresholds) {
        if (daysToMaturity >= 0 && daysToMaturity <= threshold) {
          // Try INSERT OR IGNORE — if already sent, skip
          const insertResult = db.prepare(`
            INSERT OR IGNORE INTO fdr_reminders (fdr_id, threshold_days, sent_at)
            VALUES (?, ?, datetime('now'))
          `).run(fdr.id, threshold);

          if (insertResult.changes > 0) {
            // New reminder — send notification + email
            const msg = `Reminder: FDR ${fdr.fdr_number} matures in ${daysToMaturity} day(s) (on ${fdr.maturity_date}). Please initiate renewal if required.`;

            if (fdr.college_user_id) {
              createNotification(db, fdr.college_user_id, fdr.id, `REMINDER_${threshold}`, msg);
            }
            createOutboxEmail(db, fdr.inst_email,
              `[AICTE FDR Portal] Reminder: FDR ${fdr.fdr_number} matures in ${daysToMaturity} days`,
              `Dear ${fdr.inst_name},\n\n${msg}\n\nPlease log in to the AICTE FDR Portal to take necessary action.\n\n[This is a simulated email — demo purposes only]`,
              fdr.id
            );

            summary.remindersCreated++;
          }
        }
      }

      // -----------------------------------------------------------------------
      // Level 2: Matured with no renewal OR High discrepancy open > N days → Officer
      // -----------------------------------------------------------------------
      const isMatured = fdr.maturity_date < todayStr;
      const hasHighDisc = db.prepare(`
        SELECT id, raised_at FROM discrepancies
        WHERE fdr_id = ? AND severity = 'High' AND status = 'Open'
        LIMIT 1
      `).get(fdr.id);

      let needsLevel2 = false;
      let level2Reason = '';

      if (isMatured && !fdr.superseded_by_id) {
        needsLevel2 = true;
        level2Reason = `FDR ${fdr.fdr_number} matured on ${fdr.maturity_date} with no renewal submitted.`;
      }

      if (hasHighDisc) {
        const daysOpen = daysBetween(hasHighDisc.raised_at.slice(0, 10), todayStr);
        if (daysOpen >= escalationDays) {
          needsLevel2 = true;
          level2Reason += ` High-severity discrepancy open for ${daysOpen} day(s).`;
        }
      }

      if (needsLevel2) {
        // Use REMINDER_ESC_L2 type — one per FDR per day (use date in type)
        const l2Type = `ESC_L2_${todayStr}`;
        const alreadySent = db.prepare(`
          SELECT id FROM notifications
          WHERE fdr_id = ? AND type = ?
          LIMIT 1
        `).get(fdr.id, l2Type);

        if (!alreadySent) {
          for (const officer of officers) {
            createNotification(db, officer.id, fdr.id, l2Type,
              `[Escalation L2] ${level2Reason.trim()} — Immediate attention required.`);
          }
          createOutboxEmail(db,
            officers.map(o => o.email).join(', ') || 'officer@aicte.in',
            `[AICTE FDR Portal] Escalation L2: FDR ${fdr.fdr_number} — ${fdr.inst_name}`,
            `Dear AICTE Officer,\n\nThis is a Level 2 escalation.\n\n${level2Reason.trim()}\n\nPlease log in and take action.\n\n[Simulated email]`,
            fdr.id
          );
          summary.level2Escalations++;
        }
      }

      // -----------------------------------------------------------------------
      // Level 3: Escalate to Approver if L2 was raised > escalationDays ago with no resolution
      // -----------------------------------------------------------------------
      const l2OldType = `ESC_L2_`; // prefix check
      const oldL2 = db.prepare(`
        SELECT created_at FROM notifications
        WHERE fdr_id = ? AND type LIKE 'ESC_L2_%'
        ORDER BY created_at ASC LIMIT 1
      `).get(fdr.id);

      if (oldL2) {
        const dayssinceL2 = daysBetween(oldL2.created_at.slice(0, 10), todayStr);
        if (dayssinceL2 >= escalationDays) {
          const l3Type = `ESC_L3_${todayStr}`;
          const alreadySentL3 = db.prepare(`
            SELECT id FROM notifications WHERE fdr_id = ? AND type = ? LIMIT 1
          `).get(fdr.id, l3Type);

          if (!alreadySentL3) {
            for (const approver of approvers) {
              createNotification(db, approver.id, fdr.id, l3Type,
                `[Escalation L3] FDR ${fdr.fdr_number} (${fdr.inst_name}) remains unresolved after Level 2 escalation ${dayssinceL2} day(s) ago. Approver attention required.`);
            }
            createOutboxEmail(db,
              approvers.map(a => a.email).join(', ') || 'approver@aicte.in',
              `[AICTE FDR Portal] Escalation L3: FDR ${fdr.fdr_number} — ${fdr.inst_name}`,
              `Dear AICTE Approver,\n\nThis is a Level 3 escalation.\n\nFDR ${fdr.fdr_number} for ${fdr.inst_name} remains unresolved after Level 2 escalation raised ${dayssinceL2} day(s) ago.\n\nPlease review and take competent authority action.\n\n[Simulated email]`,
              fdr.id
            );
            summary.level3Escalations++;
          }
        }
      }

    } catch (err) {
      summary.errors.push({ fdrId: fdr.id, error: err.message });
    }
  }

  // Log the job run in audit
  logAudit({
    actorUserId: null,
    actorRole: 'system',
    action: 'REMINDER_JOB_RUN',
    entityType: 'system',
    entityId: null,
    details: { todayStr, summary }
  });

  return summary;
}

module.exports = { runReminderJob };
