'use strict';

/**
 * All CREATE TABLE and CREATE INDEX statements.
 * Run once at startup via initSchema(db).
 */
function initSchema(db) {
  db.exec(`
    -- ----------------------------------------------------------------
    -- institutions
    -- ----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS institutions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT    NOT NULL,
      aicte_id      TEXT    NOT NULL UNIQUE,
      state         TEXT    NOT NULL,
      city          TEXT    NOT NULL,
      contact_email TEXT    NOT NULL
    );

    -- ----------------------------------------------------------------
    -- users
    -- ----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS users (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT    NOT NULL,
      email          TEXT    NOT NULL UNIQUE,
      password_hash  TEXT    NOT NULL,
      role           TEXT    NOT NULL CHECK(role IN ('college','officer','approver')),
      institution_id INTEGER REFERENCES institutions(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_users_institution ON users(institution_id);

    -- ----------------------------------------------------------------
    -- fdrs
    -- ----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS fdrs (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      institution_id     INTEGER NOT NULL REFERENCES institutions(id),
      fdr_number         TEXT    NOT NULL,
      bank_name          TEXT    NOT NULL,
      branch             TEXT    NOT NULL,
      amount             REAL    NOT NULL,
      issue_date         TEXT    NOT NULL,   -- ISO YYYY-MM-DD
      maturity_date      TEXT    NOT NULL,   -- ISO YYYY-MM-DD
      purpose_note       TEXT,
      verification_status TEXT NOT NULL DEFAULT 'Pending Review'
                          CHECK(verification_status IN (
                            'Pending Review','Under Review','Verified',
                            'Discrepancy Found','Rejected')),
      bank_confirmation  TEXT NOT NULL DEFAULT 'Not Requested'
                          CHECK(bank_confirmation IN (
                            'Not Requested','Simulated - Confirmed','Simulated - Mismatch')),
      supersedes_fdr_id  INTEGER REFERENCES fdrs(id),
      superseded_by_id   INTEGER REFERENCES fdrs(id),
      release_state      TEXT NOT NULL DEFAULT 'None'
                          CHECK(release_state IN (
                            'None','Requested','Recommended',
                            'Approved-Released','Rejected')),
      created_by         INTEGER NOT NULL REFERENCES users(id),
      created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_fdrs_institution    ON fdrs(institution_id);
    CREATE INDEX IF NOT EXISTS idx_fdrs_maturity_date  ON fdrs(maturity_date);
    CREATE INDEX IF NOT EXISTS idx_fdrs_issue_date     ON fdrs(issue_date);
    CREATE INDEX IF NOT EXISTS idx_fdrs_supersedes     ON fdrs(supersedes_fdr_id);
    CREATE INDEX IF NOT EXISTS idx_fdrs_superseded_by  ON fdrs(superseded_by_id);

    -- ----------------------------------------------------------------
    -- fdr_documents
    -- ----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS fdr_documents (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      fdr_id             INTEGER NOT NULL REFERENCES fdrs(id),
      file_original_name TEXT    NOT NULL,
      file_stored_name   TEXT    NOT NULL UNIQUE,  -- random, never exposed
      mime               TEXT    NOT NULL,
      size               INTEGER NOT NULL,
      sha256             TEXT    NOT NULL,
      version_no         INTEGER NOT NULL DEFAULT 1,
      doc_status         TEXT    NOT NULL DEFAULT 'Uploaded'
                          CHECK(doc_status IN ('Uploaded','Accepted','Rejected')),
      reject_reason      TEXT,
      uploaded_by        INTEGER NOT NULL REFERENCES users(id),
      uploaded_at        TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_fdr_docs_fdr_id ON fdr_documents(fdr_id);
    CREATE INDEX IF NOT EXISTS idx_fdr_docs_sha256  ON fdr_documents(sha256);

    -- ----------------------------------------------------------------
    -- document_extracted_values  (officer enters values read from doc)
    -- ----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS document_extracted_values (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      fdr_id        INTEGER NOT NULL REFERENCES fdrs(id),
      document_id   INTEGER NOT NULL REFERENCES fdr_documents(id),
      fdr_number    TEXT,
      bank_name     TEXT,
      amount        REAL,
      issue_date    TEXT,
      maturity_date TEXT,
      entered_by    INTEGER NOT NULL REFERENCES users(id),
      entered_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_dev_fdr_id ON document_extracted_values(fdr_id);

    -- ----------------------------------------------------------------
    -- discrepancies
    -- ----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS discrepancies (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      fdr_id          INTEGER NOT NULL REFERENCES fdrs(id),
      rule_code       TEXT    NOT NULL,
      severity        TEXT    NOT NULL CHECK(severity IN ('High','Medium','Low')),
      message         TEXT    NOT NULL,
      status          TEXT    NOT NULL DEFAULT 'Open'
                       CHECK(status IN ('Open','Resolved','Waived')),
      resolution_note TEXT,
      raised_at       TEXT    NOT NULL DEFAULT (datetime('now')),
      resolved_by     INTEGER REFERENCES users(id),
      resolved_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_disc_fdr_id    ON discrepancies(fdr_id);
    CREATE INDEX IF NOT EXISTS idx_disc_rule_code ON discrepancies(rule_code);
    CREATE INDEX IF NOT EXISTS idx_disc_status    ON discrepancies(status);

    -- ----------------------------------------------------------------
    -- release_requests
    -- ----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS release_requests (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      fdr_id                INTEGER NOT NULL REFERENCES fdrs(id),
      requested_by          INTEGER NOT NULL REFERENCES users(id),
      reason                TEXT    NOT NULL,
      requested_at          TEXT    NOT NULL DEFAULT (datetime('now')),
      checklist_json        TEXT    NOT NULL DEFAULT '[]',
      officer_recommendation TEXT,  -- 'Recommend' | 'Do Not Recommend'
      officer_remarks       TEXT,
      approver_decision     TEXT,   -- 'Approved' | 'Rejected'
      approver_remarks      TEXT,
      decided_at            TEXT,
      status                TEXT    NOT NULL DEFAULT 'Pending Officer'
                             CHECK(status IN (
                               'Pending Officer','Pending Approver',
                               'Approved-Released','Rejected'))
    );
    CREATE INDEX IF NOT EXISTS idx_rr_fdr_id ON release_requests(fdr_id);
    CREATE INDEX IF NOT EXISTS idx_rr_status  ON release_requests(status);

    -- ----------------------------------------------------------------
    -- notifications
    -- ----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS notifications (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      fdr_id     INTEGER REFERENCES fdrs(id),
      type       TEXT    NOT NULL,
      message    TEXT    NOT NULL,
      is_read    INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_notif_user_id ON notifications(user_id);
    CREATE INDEX IF NOT EXISTS idx_notif_is_read ON notifications(is_read);

    -- ----------------------------------------------------------------
    -- email_outbox  (simulated emails — no SMTP)
    -- ----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS email_outbox (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      to_email        TEXT    NOT NULL,
      subject         TEXT    NOT NULL,
      body            TEXT    NOT NULL,
      related_fdr_id  INTEGER REFERENCES fdrs(id),
      created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_fdr_id ON email_outbox(related_fdr_id);

    -- ----------------------------------------------------------------
    -- audit_log  (append-only; NEVER UPDATE OR DELETE)
    -- All writes via logAudit() in src/services/audit.js ONLY.
    -- ----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS audit_log (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      ts             TEXT    NOT NULL DEFAULT (datetime('now')),
      actor_user_id  INTEGER REFERENCES users(id),
      actor_role     TEXT,
      action         TEXT    NOT NULL,
      entity_type    TEXT    NOT NULL,
      entity_id      TEXT,
      details_json   TEXT    NOT NULL DEFAULT '{}',
      prev_hash      TEXT    NOT NULL DEFAULT '',
      entry_hash     TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts          ON audit_log(ts);
    CREATE INDEX IF NOT EXISTS idx_audit_entity      ON audit_log(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_audit_actor       ON audit_log(actor_user_id);

    -- ----------------------------------------------------------------
    -- settings  (key-value store)
    -- ----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- ----------------------------------------------------------------
    -- fdr_reminders  (deduplication — one reminder per threshold per FDR)
    -- ----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS fdr_reminders (
      fdr_id        INTEGER NOT NULL REFERENCES fdrs(id),
      threshold_days INTEGER NOT NULL,
      sent_at       TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (fdr_id, threshold_days)
    );
    CREATE INDEX IF NOT EXISTS idx_fdr_reminders_fdr ON fdr_reminders(fdr_id);
  `);
}

module.exports = { initSchema };
