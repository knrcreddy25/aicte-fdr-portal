# AICTE Security Deposit / FDR Management Portal
## Complete Implementation Plan

---

## 1. Purpose and Honesty Rules

Demonstrate the full administrative lifecycle of security deposits / Fixed Deposit Receipts submitted by technical institutions to AICTE: submission, document upload, verification, discrepancy detection, maturity tracking, reminders and escalation, renewal/replacement, release/refund workflow, dashboards, reports, audit trail.

- All data is illustrative. Show a small "Demo data - illustrative values only" banner on every page. Do not claim these are real AICTE deposit rules or amounts.

- NO real bank API. Show a field "Bank Confirmation" with values: Not Requested / Simulated - Confirmed / Simulated - Mismatch, always labeled "Simulated". Provide an admin button "Simulate bank response" for demo purposes only.

- Every FDR shows a trust tag: "Institution-submitted" until verified by an officer, then "Officer-verified", and "Bank-confirmed (simulated)" only when the simulated bank check passes.

---

## 2. Tech Stack (fixed, do not substitute)

- Node.js + Express, server-rendered with EJS templates, Bootstrap 5 (CDN), Chart.js (CDN), minimal vanilla JS

- SQLite via better-sqlite3 (single file, zero setup), parameterized queries only

- express-session + bcrypt, helmet, express-rate-limit on login, CSRF protection (csurf or equivalent)

- multer for uploads to ./uploads (outside the public static folder)

- node-cron for scheduled jobs, plus a manual trigger button for demos

- Email is simulated: write to an "outbox" table and show it in an in-app Outbox page. No SMTP.

- Scripts: `npm run seed`, `npm start`, `npm run dev` (nodemon, add as dev dependency), `npm test` (smoke tests)

---

## 3. Roles and Permissions

1. **College User**: sees and edits ONLY their own institution's records (enforce server-side on every route; test that changing an ID in the URL cannot expose another institution's data).

2. **AICTE Officer**: sees all FDRs, reviews documents, enters document-extracted values, marks Verified / Flags Discrepancy, resolves discrepancies, recommends release.

3. **AICTE Approver (competent authority)**: approves/rejects release requests recommended by an Officer, sees everything read-only otherwise.

Seed demo accounts and show them on the login page with a "Demo credentials" box:

`college.abc@demo.in`, `college.xyz@demo.in` (and a few more), `officer@demo.in`, `approver@demo.in`, all with password `Demo@1234`.

---

## 4. Data Model

Create exactly these tables. Add indexes on foreign keys and date columns.

### users
`id, name, email, password_hash, role, institution_id (nullable)`

### institutions
`id, name, aicte_id, state, city, contact_email`

### fdrs
`id, institution_id, fdr_number, bank_name, branch, amount, issue_date, maturity_date, purpose_note, verification_status, bank_confirmation, supersedes_fdr_id (nullable), superseded_by_id (nullable), release_state, created_by, created_at, updated_at`

- `verification_status`: `Pending Review | Under Review | Verified | Discrepancy Found | Rejected`
- `release_state`: `None | Requested | Recommended | Approved-Released | Rejected`

### fdr_documents
`id, fdr_id, file_original_name, file_stored_name, mime, size, sha256, version_no, doc_status [Uploaded | Accepted | Rejected], reject_reason, uploaded_by, uploaded_at`

Each new upload increments `version_no`. Previous document rows are retained unchanged (historical record). Officer review always operates on the latest document row with `doc_status = Uploaded`. A re-upload does not delete or overwrite prior rows.

### document_extracted_values
`id, fdr_id, document_id, fdr_number, bank_name, amount, issue_date, maturity_date, entered_by, entered_at`
← values the officer reads off the uploaded document

### discrepancies
`id, fdr_id, rule_code, severity [High|Medium|Low], message, status [Open|Resolved|Waived], resolution_note, raised_at, resolved_by, resolved_at`

### release_requests
`id, fdr_id, requested_by, reason, requested_at, checklist_json, officer_recommendation, officer_remarks, approver_decision, approver_remarks, decided_at, status`

### notifications
`id, user_id, fdr_id, type, message, is_read, created_at`

### email_outbox
`id, to_email, subject, body, related_fdr_id, created_at`
← simulated emails

### audit_log
`id, ts, actor_user_id, actor_role, action, entity_type, entity_id, details_json, prev_hash, entry_hash`
← append-only; never update or delete

### settings
`key, value`
← includes `demo_today` (optional override), `reminder_days` ("90,60,30,7"), `escalation_after_days`, `release_checklist_template` (JSON array of checklist item strings)

### fdr_reminders
`fdr_id, threshold_days, sent_at`
← unique constraint on `(fdr_id, threshold_days)`. The reminder job uses `INSERT OR IGNORE` against this table to ensure each threshold fires at most once per FDR.

---

## 5. Status Logic

Store `verification_status` and `release_state`. DERIVE the timing status at read time from "today" (`settings.demo_today` if set, else real date):

- **Superseded**: has `superseded_by_id` (shown as "Renewed - superseded", kept in history)
- **Matured**: `maturity_date < today`
- **Expiring Soon**: 0 to 90 days to maturity (configurable)
- **Active**: otherwise

Show `verification_status`, timing status, and `release_state` as three separate color-coded badges. Never store "Expiring Soon" in the database.

The seed script leaves `demo_today` unset. All status derivation and job logic calls a single `getToday()` helper in `src/services/status.js` that reads `settings.demo_today` first, falling back to the real date. No other part of the codebase calls `new Date()` directly for business logic.

---

## 6. Discrepancy Engine

Rule-based engine. Runs on: submit, document upload, officer entering extracted values, and nightly job.

| Code | Severity | Trigger | Message |
|------|----------|---------|---------|
| R01 | High | No accepted document on FDR | Missing document |
| R02 | High | Declared vs document-extracted maturity date mismatch | Maturity date mismatch |
| R03 | High | Declared vs extracted amount mismatch | Amount mismatch |
| R04 | High | Declared vs extracted FDR number mismatch | FDR number mismatch |
| R05 | Medium | Normalized bank name comparison fails | Bank name mismatch |
| R06 | Medium | Declared vs extracted issue date mismatch | Issue date mismatch |
| R07 | High | `maturity_date <= today` when submitted as new | Already matured at submission |
| R08 | High | Maturity date is before issue date | Invalid tenure / maturity before issue date |
| R09 | High | Same FDR number exists in another institution's record | Duplicate FDR number across system |
| R10 | High | Old FDR matured with no replacement submitted | Renewal lapse |
| R11 | Medium | Replacement FDR amount lower than the original | Replacement amount lower than original |
| R12 | High | Document file SHA-256 hash matches a document on a different FDR | Possible document reuse / duplicate file |

Show open discrepancies in a clear "Flagged Issues" panel on the FDR detail page. A `Verified` status is blocked while any High-severity discrepancy is Open (officer must resolve or waive with a note). Do not duplicate the same open discrepancy on re-runs.

Optional stretch (only after everything else works): extract text from PDF with `pdf-parse` and pre-fill the extracted-values form for the officer to confirm. Whether or not extraction succeeds, the form must always be manually editable. If auto-extraction is unavailable or fails, display: `"Auto-extraction not available for this file — please enter values manually."`

---

## 7. Reminders, Alerts, Escalation

- Nightly job + "Run reminder job now" admin button.

- For each unsuperseded FDR, when days-to-maturity crosses 90/60/30/7 (configurable), create an in-app notification and an outbox email to the college, once per threshold (tracked via the `fdr_reminders` table using `INSERT OR IGNORE`).

- Overdue / unresolved escalation matrix, shown as a documented table in the Settings page:

  | Level | Trigger | Action |
  |-------|---------|--------|
  | Level 1 | Threshold crossed | Reminder to college |
  | Level 2 | FDR matured with no renewal OR High discrepancy open longer than N days | Notify the Officer |
  | Level 3 | Further N days pass with no resolution | Notify the Approver |

- Notification bell with unread count visible for every role.

---

## 8. Renewal and Replacement

- On an Expiring Soon or Matured FDR, the college clicks "Submit renewal/replacement", which opens the same FDR form pre-filled and linked via `supersedes_fdr_id`.

- On officer verification of the new FDR, mark the old one superseded (`superseded_by_id` set) and show the full chain (v1 → v2 → v3) on the detail page.

- History is never deleted.

---

## 9. Release / Refund Workflow

Show a visible note on every release-related page: **"Maturity does not automatically mean release. Release depends on applicable rules and approval."**

- College can request release **only if** the FDR is `Verified` and has no open High-severity discrepancy. The request includes a reason and a checklist rendered from `settings.release_checklist_template`.

- Officer reviews and records `Recommend` / `Do not recommend` with mandatory remarks.

- Approver then `Approves` or `Rejects` with mandatory remarks. Only the Approver can set `release_state` to `Approved-Released`.

- Every step is audited and triggers a notification to the college.

The `settings` table stores `release_checklist_template` as a JSON array of checklist item strings. The release request form renders checkboxes from this template and snapshots the answered state into `release_requests.checklist_json` at submission time. The template is editable by an Officer/Approver on the Settings page.

---

## 10. Audit Trail

- Log every: submit, upload, view of a document (optional), extracted-value entry, verify, flag, resolve, renew, release request, recommendation, approval, rejection, login, settings change.

- Hash-chain entries: `entry_hash = SHA-256(prev_hash + ts + actor + action + entity + details_json)`. Provide an Admin page "Audit log" with filters (entity, user, date) and a "Verify log integrity" button that recomputes the chain and reports OK or the first broken entry.

- Per-FDR timeline view combining status changes, documents, discrepancies, and release steps in chronological order.

- No `UPDATE` or `DELETE` SQL exists anywhere in the codebase targeting `audit_log`. All writes go exclusively through a dedicated `logAudit()` function in `src/services/audit.js`. This must be enforced — no other code path writes to this table.

---

## 11. Screens

### College
- Dashboard (own FDR counts, items needing action)
- Submit FDR (with validation and file upload)
- My FDRs list
- FDR detail with timeline
- Renewal form
- Release request form
- Notifications

### Officer / Approver
- Dashboard
- All FDRs (filters: institution, state, verification status, timing status, bank, maturity range, discrepancy open; search by FDR number; sortable; CSV export)
- FDR detail (declared vs document-extracted values side by side with mismatches highlighted, document viewer/download, verify / flag / resolve / simulate bank response, notes)
- Release queue
- Reports
- Audit log
- Outbox
- Settings (with "Simulated today" date picker and "Run reminder job now" button)

### Dashboard (admin/officer) must show
- Total FDRs, Verified, Pending Review, Expiring Soon, Discrepancies, Pending Release Requests, Matured-without-renewal
- Chart.js doughnut of status distribution
- Bar chart of maturities per month for the next 12 months
- Prioritized "Action Required" table: High discrepancies first → matured without renewal → expiring within 30 days → pending review by age → release requests awaiting action

### Reports (each with CSV export)
- Pending verifications
- Upcoming maturities (30/60/90)
- Missing documents
- Open discrepancies
- Institution-wise summary

---

## 12. Security Requirements

- bcrypt password hashing, rate-limited login, session cookie `httpOnly` and `sameSite`, CSRF tokens on all forms

- Uploads: PDF/JPG/PNG only, max 5 MB, validate MIME and extension, random stored filename, store SHA-256; serve files only through an authenticated route that checks institution access

- Server-side validation of all inputs (dates, positive amounts, required fields); escape all output (EJS default); no raw SQL concatenation

- Role checks as middleware on every route; return 403 on violation

- The authenticated file-serving route sets `Content-Disposition: attachment; filename="<file_original_name>"` and must never expose `file_stored_name` to the client. For PDFs/images shown inline in the officer review, use `Content-Disposition: inline` only inside the authenticated route.

---

## 13. Seed Data (`npm run seed`)

Create 10 institutions across different states and ~20 FDRs. Use dates **relative to today** so demos always work. Cover each scenario at least once:

| Scenario | Details |
|----------|---------|
| Pending Review | Freshly submitted, no officer action |
| Verified and Active | Clean FDR, fully verified |
| Expiring Soon | +25 days and +80 days to maturity |
| Matured, no renewal | -20 days past maturity |
| Discrepancy Found - maturity mismatch | R02 open |
| Discrepancy Found - amount mismatch | R03 open |
| Missing document | R01 open |
| Duplicate FDR number flag | R09 open |
| Renewed chain | 2–3 FDR chain with v1 → v2 → v3 |
| Release Requested | Awaiting officer recommendation |
| Recommended | Awaiting approver decision |
| Released | Approved-Released |
| Release Rejected | Approver rejected |

Include sample PDFs generated programmatically (pdfkit or simple placeholder PDFs). Seed some audit log entries through the real `logAudit()` function so the hash chain is valid from the start.

---

## 14. Phases and Acceptance Checks

**Test framework**: use `jest` with `supertest` for all smoke tests. Add both as dev dependencies. Tests start the Express app on a test port, run assertions, and exit cleanly.

### Phase 1: Schema, seed, auth, roles, layout
- All tables created with correct indexes
- `npm run seed` completes without error
- All 4 role types can log in and see the correct menu
- Demo credentials box visible on login page

### Phase 2: FDR submission, upload, college dashboard and list
- College can submit an FDR with file upload
- College A cannot open college B's FDR by URL (test this explicitly)
- My FDRs list shows correct records

### Phase 3: Officer review, extracted-values entry, discrepancy engine, verify/flag/resolve
- Entering a maturity date that differs from the declared one raises R02
- Verify button is blocked while R02 (or any High discrepancy) is Open
- Officer can resolve or waive discrepancy with a note, then verify

### Phase 4: Derived timing status, reminders, notifications, outbox, escalation, demo-date control, audit log page with integrity check
- Moving the simulated date forward generates reminders and escalations correctly
- Reminder job does not duplicate notifications (fdr_reminders constraint works)
- Audit log integrity check passes on seeded data
- "Verify log integrity" button reports OK

### Phase 5: Renewal chain, release workflow with Officer → Approver, guardrails
- Renewal chain links correctly (v1 → v2)
- College cannot request release on an unverified FDR
- Officer recommendation step works; Approver approval/rejection works
- release_state transitions are correct and audited

### Phase 6: Dashboards, charts, reports, CSV export, polish
- Dashboard charts render correctly
- All 5 reports generate with CSV export
- Custom 403, 404, 500 error pages work
- Responsive layout, color-coded badges, breadcrumbs on all pages

### Smoke Tests (`npm test`)
Cover all of the following:
1. Login per role (college, officer, approver)
2. Access isolation (college A cannot access college B's FDR)
3. R02 detection (maturity date mismatch raises discrepancy)
4. Status derivation (timing status computed correctly from demo_today)
5. Release guardrail (release blocked on unverified FDR)
6. Audit chain verification (integrity check passes)

---

## 15. UI Guidelines

Professional government-portal look:
- Neutral palette: navy / white / grey
- Clear typography, consistent spacing
- Color-coded badges:
  - Green: Verified
  - Amber: Expiring Soon / Pending
  - Red: Discrepancy Found / Matured
  - Grey: Superseded
  - Blue: Release states
- Tables must be readable with clear column headers
- Forms must show validation errors inline (not just browser alerts)
- Each page must have a clear page title and breadcrumbs
- Responsive layout, keyboard-accessible, sufficient color contrast (WCAG AA minimum)
- "Demo data - illustrative values only" banner visible on every page
- Provide custom 403, 404, and 500 error pages consistent with the portal theme (navy/white/grey, clear message, a "Go to Dashboard" link)

---

## 16. Folder Structure

/ ├── src/ │ ├── routes/ │ ├── services/ │ │ ├── audit.js ← logAudit() only, no other writes to audit_log │ │ ├── discrepancy.js │ │ ├── reminders.js │ │ └── status.js ← getToday() helper lives here │ ├── views/ │ │ ├── partials/ │ │ └── *.ejs │ └── db/ │ ├── schema.js │ └── db.js ├── public/ ├── uploads/ ← outside public/, served via authenticated route only ├── scripts/ │ └── seed.js ├── tests/ ├── app.js ├── package.json └── README.md


---

## 17. Deliverables

Complete source code with the folder structure above, plus a `README.md` containing:

1. **Setup instructions**: `npm install`, `npm run seed`, `npm start`, `npm run dev`
2. **Demo accounts**: table of all seeded credentials
3. **5-minute judge walkthrough script**: references specific seed records by name and FDR number, e.g.:
   - *"Log in as `college.abc@demo.in` → open FDR-002 which has a maturity date mismatch → observe R02 discrepancy in the Flagged Issues panel → switch to `officer@demo.in` → enter extracted values with correct maturity date → observe R02 raised → attempt Verify → confirm it is blocked → resolve discrepancy with a note → verify successfully → log in as `college.abc@demo.in` → submit release request → officer recommends → approver approves → observe Approved-Released badge."*
4. **Architecture overview**: roles, data flow, service layer
5. **Status model**: timing status derivation table
6. **Discrepancy rule table**: all 12 rules with codes, severity, trigger
7. **Future work**:
   - Real bank API verification (once formally authorized)
   - AICTE system integration
   - Real SMTP / SMS notifications
   - OCR / AI-based document extraction
   - Production-grade compliance, audit, and hosting
   - Multi-language support

Do not leave TODO stubs in core flows. If something is deferred, list it under Future work only.
