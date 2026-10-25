# AICTE Security Deposit / FDR Management Portal

> **Prototype — Demo purposes only. All data is illustrative and fictitious.**

---

## Setup

```bash
npm install
npm run seed      # creates DB, inserts demo data, generates sample PDFs
npm start         # production start  → http://localhost:3001
npm run dev       # dev with nodemon  → http://localhost:3001
npm test          # run smoke tests
```

---

## Demo Accounts

Password for all accounts: **`Demo@1234`**

| Email | Role | Institution |
|-------|------|-------------|
| college.abc@demo.in | College User | ABC Institute of Technology |
| college.xyz@demo.in | College User | XYZ Engineering College |
| college.pqr@demo.in | College User | PQR Polytechnic Institute |
| college.mno@demo.in | College User | MNO College of Engineering |
| college.def@demo.in | College User | DEF Technical Institute |
| officer@demo.in | AICTE Officer | — |
| approver@demo.in | AICTE Approver | — |

---

## 5-Minute Judge Walkthrough

**Step 1 — College submits FDR with discrepancy**
1. Login as `college.abc@demo.in`
2. Go to **My FDRs** → open **FDR-2024-002** (shows "Discrepancy Found" badge)
3. Observe the **Flagged Issues** panel showing R02 (maturity date mismatch, High severity)
4. Note: release request button is disabled — blocked by open High discrepancy

**Step 2 — Officer reviews and resolves**
1. Login as `officer@demo.in`
2. Go to **All FDRs** → open **FDR-2024-002**
3. See the side-by-side comparison: declared maturity vs document-extracted maturity (mismatch highlighted)
4. Click **Resolve Discrepancy** for R02 → enter resolution note → save
5. Click **Verify FDR** → status changes to **Verified** ✓
6. Click **Simulate Bank Response** → set to **Simulated - Confirmed** → trust tag updates

**Step 3 — College requests release**
1. Login as `college.abc@demo.in`
2. Open **FDR-2024-002** → release button now active (Verified, no open High discrepancies)
3. Click **Request Release** → fill reason + checklist → submit
4. Observe status changes to "Release Requested"

**Step 4 — Officer recommends**
1. Login as `officer@demo.in` → **Release Queue**
2. Open the request for FDR-2024-002 → enter recommendation remarks → **Recommend**

**Step 5 — Approver approves**
1. Login as `approver@demo.in` → **Release Queue**
2. Open request → enter approval remarks → **Approve**
3. FDR now shows badge: **Released** (Approved-Released)

**Step 6 — Demo date control & reminders**
1. Login as `officer@demo.in` → **Settings**
2. Set **Simulated Today** to a date 300 days from today
3. Click **Run Reminder Job Now**
4. Go to **Outbox** → see generated simulated emails
5. Check notification bell → escalation notifications visible

**Step 7 — Renewal chain**
1. Go to **All FDRs** → search for institution "JKL"
2. See the chain: FDR-2023-010 → FDR-2024-010B → FDR-2025-010C (v1→v2→v3)
3. v1 and v2 show "Superseded" badge; v3 is current Active

**Step 8 — Audit log integrity**
1. Go to **Audit Log** → click **Verify Log Integrity**
2. Result: "All N entries verified. Chain intact."

---

## Architecture Overview

```
Browser (EJS + Bootstrap 5)
        │
        ▼
Express app (app.js)
    ├── Helmet, rate-limit, CSRF, session
    ├── Routes (/src/routes/)
    │     ├── auth.js        — login/logout
    │     ├── fdrs.js        — FDR CRUD, upload, verify, bank-sim
    │     ├── documents.js   — secure file serving
    │     ├── officer.js     — extracted values, discrepancy resolution
    │     ├── release.js     — release request workflow
    │     ├── notifications  — bell + outbox
    │     ├── reports.js     — 5 reports + CSV export
    │     ├── audit.js       — audit log + integrity check
    │     └── settings.js    — demo date, reminder config, checklist
    ├── Middleware (/src/middleware/)
    │     ├── requireAuth.js
    │     └── requireRole.js  — college/officer/approver + institution isolation
    └── Services (/src/services/)
          ├── status.js       — getToday(), getTimingStatus(), enrichFdr()
          ├── audit.js        — logAudit(), verifyAuditChain()
          ├── discrepancy.js  — runDiscrepancyEngine() (12 rules)
          └── reminders.js    — runReminderJob() (3-level escalation)

SQLite (better-sqlite3)   → data/portal.db
Uploads                   → uploads/ (authenticated route, never public)
Scheduled job             → node-cron, 02:00 AM nightly
```

---

## Status Model

| Timing Status | Condition | Badge colour |
|---------------|-----------|-------------|
| Superseded | `superseded_by_id IS NOT NULL` | Grey |
| Matured | `maturity_date < today` | Red |
| Expiring Soon | `0 ≤ days_to_maturity ≤ 90` | Amber |
| Active | otherwise | Green |

**Never stored in DB — derived at read time by `getTimingStatus()` in `src/services/status.js`.**

Each FDR shows three separate badges: verification_status · timing status · release_state.

---

## Discrepancy Rules

| Code | Severity | Trigger |
|------|----------|---------|
| R01 | High | No accepted/uploaded document |
| R02 | High | Declared vs extracted maturity date mismatch |
| R03 | High | Declared vs extracted amount mismatch |
| R04 | High | Declared vs extracted FDR number mismatch |
| R05 | Medium | Bank name mismatch (normalized) |
| R06 | Medium | Issue date mismatch |
| R07 | High | maturity_date ≤ today at submission |
| R08 | High | Maturity date before issue date |
| R09 | High | Duplicate FDR number across system |
| R10 | High | Old FDR matured with no renewal submitted |
| R11 | Medium | Replacement amount lower than original |
| R12 | High | Document SHA-256 matches another FDR's document |

**Verify is blocked while any High-severity discrepancy is Open.**

---

## Future Work

- **Real bank API verification** — once formally authorized by RBI/AICTE
- **AICTE system integration** — connect to existing approval portal (SSO, shared institution data)
- **Real SMTP / SMS notifications** — replace simulated email outbox
- **OCR / AI document extraction** — auto-fill extracted values from uploaded PDFs
- **Production-grade hosting** — containerisation, HTTPS, secrets management, backups
- **Multi-language support** — Hindi and regional languages for college users
- **Advanced reporting** — scheduled report delivery, custom date ranges
- **Role expansion** — zonal officers, institution coordinators, read-only auditors

---

## Notes

- All financial data (amounts, FDR numbers, institutions) is **entirely fictitious**.
- "Bank confirmation" is always **simulated** — no real bank API is called.
- This prototype does not represent real AICTE rules, deposit amounts, or regulatory requirements.
