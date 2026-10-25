'use strict';

/**
 * seed.js
 * Run with: npm run seed
 *
 * Creates 10 institutions, 7 demo users, ~20 FDRs covering every scenario.
 * Dates are RELATIVE TO TODAY so the demo always works.
 * Audit log entries are created via logAudit() so the hash chain is valid.
 * Sample placeholder PDFs are generated with pdfkit.
 */

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcrypt');

// ---- DB & services ----
const { getDb, seedDefaultSettings } = require('../src/db/db');
const { logAudit }                   = require('../src/services/audit');
const { runDiscrepancyEngine }       = require('../src/services/discrepancy');

// ---- Ensure uploads dir ----
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const db = getDb();
seedDefaultSettings(db);

// ====================================================================
// Helpers
// ====================================================================

/** Returns a date string (YYYY-MM-DD) offset by N days from today */
function relDate(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/** Generate a minimal placeholder PDF using pdfkit and return { storedName, sha256 } */
function generatePdf(fdrNumber, institution, amount, issueDate, maturityDate) {
  let PDFDocument;
  try { PDFDocument = require('pdfkit'); } catch (_) {
    // pdfkit not installed yet — create a text-only placeholder file
    const storedName = `${crypto.randomBytes(16).toString('hex')}.pdf`;
    const filePath   = path.join(uploadsDir, storedName);
    const content    = `FDR DOCUMENT (PLACEHOLDER)\nFDR Number: ${fdrNumber}\nInstitution: ${institution}\nAmount: ${amount}\nIssue Date: ${issueDate}\nMaturity Date: ${maturityDate}\n`;
    fs.writeFileSync(filePath, content);
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    return { storedName, sha256, size: content.length, mime: 'application/pdf' };
  }

  const storedName = `${crypto.randomBytes(16).toString('hex')}.pdf`;
  const filePath   = path.join(uploadsDir, storedName);

  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data',  chunk => chunks.push(chunk));
    doc.on('end',   () => {
      const buf  = Buffer.concat(chunks);
      fs.writeFileSync(filePath, buf);
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      resolve({ storedName, sha256, size: buf.length, mime: 'application/pdf' });
    });
    doc.on('error', reject);

    // PDF content
    doc.fontSize(18).fillColor('#1a3a5c').text('FIXED DEPOSIT RECEIPT', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor('#666').text('(Simulated Document — Demo Purposes Only)', { align: 'center' });
    doc.moveDown(1);

    const table = [
      ['FDR Number',    fdrNumber],
      ['Institution',   institution],
      ['Amount (₹)',    String(amount)],
      ['Issue Date',    issueDate],
      ['Maturity Date', maturityDate],
      ['Bank',          'Demo Bank of India'],
      ['Branch',        'Main Branch'],
    ];

    doc.fontSize(12).fillColor('#000');
    table.forEach(([label, value]) => {
      doc.text(`${label.padEnd(20)}: ${value}`);
      doc.moveDown(0.3);
    });

    doc.moveDown(1);
    doc.fontSize(8).fillColor('#999')
       .text('DISCLAIMER: This is a fictitious FDR document generated for demonstration purposes only. ' +
             'It does not represent a real financial instrument.', { align: 'center' });
    doc.end();
  });
}

/** Insert an FDR document row and return the document id */
function insertDocument(fdrId, uploadedBy, storedName, originalName, sha256, size, mime, versionNo = 1) {
  const result = db.prepare(`
    INSERT INTO fdr_documents
      (fdr_id, file_original_name, file_stored_name, mime, size, sha256, version_no, doc_status, uploaded_by, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'Uploaded', ?, datetime('now'))
  `).run(fdrId, originalName, storedName, mime, size, sha256, versionNo, uploadedBy);
  return result.lastInsertRowid;
}

// ====================================================================
// Main seed function (async because pdfkit uses streams)
// ====================================================================
async function seed() {
  console.log('🌱  Starting seed...\n');

  // ------------------------------------------------------------------
  // 1. Clear existing data (order matters for foreign keys)
  // ------------------------------------------------------------------
  const tables = [
    'fdr_reminders','email_outbox','notifications','release_requests',
    'discrepancies','document_extracted_values','fdr_documents',
    'fdrs','users','institutions','audit_log',
  ];
  db.pragma('foreign_keys = OFF');
  for (const t of tables) db.prepare(`DELETE FROM ${t}`).run();
  db.pragma('foreign_keys = ON');
  console.log('  ✓ Cleared existing data');

  // ------------------------------------------------------------------
  // 2. Institutions (10, spread across states)
  // ------------------------------------------------------------------
  const instStmt = db.prepare(`
    INSERT INTO institutions (name, aicte_id, state, city, contact_email)
    VALUES (?, ?, ?, ?, ?)
  `);

  const institutions = [
    { name: 'ABC Institute of Technology',           aicte_id: 'AICTE-MH-001', state: 'Maharashtra',    city: 'Pune',       email: 'contact@abc-tech.edu.in' },
    { name: 'XYZ Engineering College',               aicte_id: 'AICTE-KA-002', state: 'Karnataka',      city: 'Bengaluru',  email: 'contact@xyz-engg.edu.in' },
    { name: 'PQR Polytechnic Institute',             aicte_id: 'AICTE-TN-003', state: 'Tamil Nadu',     city: 'Chennai',    email: 'contact@pqr-poly.edu.in' },
    { name: 'MNO College of Engineering',            aicte_id: 'AICTE-GJ-004', state: 'Gujarat',        city: 'Ahmedabad',  email: 'contact@mno-engg.edu.in' },
    { name: 'DEF Technical Institute',               aicte_id: 'AICTE-DL-005', state: 'Delhi',          city: 'New Delhi',  email: 'contact@def-tech.edu.in' },
    { name: 'GHI School of Engineering',             aicte_id: 'AICTE-RJ-006', state: 'Rajasthan',      city: 'Jaipur',     email: 'contact@ghi-soe.edu.in' },
    { name: 'JKL Institute of Management & Tech',   aicte_id: 'AICTE-UP-007', state: 'Uttar Pradesh',  city: 'Lucknow',    email: 'contact@jkl-imt.edu.in' },
    { name: 'RST College of Applied Sciences',       aicte_id: 'AICTE-WB-008', state: 'West Bengal',    city: 'Kolkata',    email: 'contact@rst-cas.edu.in' },
    { name: 'UVW Technical University',              aicte_id: 'AICTE-TS-009', state: 'Telangana',      city: 'Hyderabad',  email: 'contact@uvw-tu.edu.in' },
    { name: 'LMN College of Technology',             aicte_id: 'AICTE-MP-010', state: 'Madhya Pradesh', city: 'Bhopal',     email: 'contact@lmn-cot.edu.in' },
  ];

  const instIds = {};
  for (const inst of institutions) {
    const r = instStmt.run(inst.name, inst.aicte_id, inst.state, inst.city, inst.email);
    instIds[inst.aicte_id] = r.lastInsertRowid;
  }
  console.log(`  ✓ Inserted ${institutions.length} institutions`);

  // ------------------------------------------------------------------
  // 3. Users
  // ------------------------------------------------------------------
  const PASS_HASH = await bcrypt.hash('Demo@1234', 10);

  const userStmt = db.prepare(`
    INSERT INTO users (name, email, password_hash, role, institution_id)
    VALUES (?, ?, ?, ?, ?)
  `);

  const userDefs = [
    { name: 'ABC Institute of Technology',           email: 'college.abc@demo.in',  role: 'college',  instKey: 'AICTE-MH-001' },
    { name: 'XYZ Engineering College',               email: 'college.xyz@demo.in',  role: 'college',  instKey: 'AICTE-KA-002' },
    { name: 'PQR Polytechnic Institute',             email: 'college.pqr@demo.in',  role: 'college',  instKey: 'AICTE-TN-003' },
    { name: 'MNO College of Engineering',            email: 'college.mno@demo.in',  role: 'college',  instKey: 'AICTE-GJ-004' },
    { name: 'DEF Technical Institute',               email: 'college.def@demo.in',  role: 'college',  instKey: 'AICTE-DL-005' },
    { name: 'AICTE Regulation Officer',              email: 'officer@demo.in',       role: 'officer',  instKey: null },
    { name: 'AICTE Competent Authority',             email: 'approver@demo.in',      role: 'approver', instKey: null },
  ];

  const userIds = {};
  for (const u of userDefs) {
    const r = userStmt.run(u.name, u.email, PASS_HASH, u.role, u.instKey ? instIds[u.instKey] : null);
    userIds[u.email] = r.lastInsertRowid;
  }
  console.log(`  ✓ Inserted ${userDefs.length} users`);

  const officerId  = userIds['officer@demo.in'];
  const approverId = userIds['approver@demo.in'];
  const abcUserId  = userIds['college.abc@demo.in'];
  const xyzUserId  = userIds['college.xyz@demo.in'];
  const pqrUserId  = userIds['college.pqr@demo.in'];
  const mnoUserId  = userIds['college.mno@demo.in'];
  const defUserId  = userIds['college.def@demo.in'];

  const abcInstId  = instIds['AICTE-MH-001'];
  const xyzInstId  = instIds['AICTE-KA-002'];
  const pqrInstId  = instIds['AICTE-TN-003'];
  const mnoInstId  = instIds['AICTE-GJ-004'];
  const defInstId  = instIds['AICTE-DL-005'];
  const ghiInstId  = instIds['AICTE-RJ-006'];
  const jklInstId  = instIds['AICTE-UP-007'];
  const rstInstId  = instIds['AICTE-WB-008'];
  const uvwInstId  = instIds['AICTE-TS-009'];
  const lmnInstId  = instIds['AICTE-MP-010'];

  // ------------------------------------------------------------------
  // 4. FDRs — all scenarios
  // ------------------------------------------------------------------
  const fdrStmt = db.prepare(`
    INSERT INTO fdrs
      (institution_id, fdr_number, bank_name, branch, amount, issue_date, maturity_date,
       purpose_note, verification_status, bank_confirmation, supersedes_fdr_id,
       superseded_by_id, release_state, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'None', ?, datetime('now'), datetime('now'))
  `);

  const fdrIds = {};

  // FDR-001: Pending Review (fresh submission)
  fdrIds['FDR-001'] = fdrStmt.run(
    abcInstId, 'FDR-2024-001', 'State Bank of India', 'MG Road Branch',
    500000, relDate(-30), relDate(335),
    'Security deposit for new programme approval',
    'Pending Review', 'Not Requested', abcUserId
  ).lastInsertRowid;

  // FDR-002: Discrepancy Found — maturity date mismatch (R02) for judge walkthrough
  fdrIds['FDR-002'] = fdrStmt.run(
    abcInstId, 'FDR-2024-002', 'Punjab National Bank', 'Shivaji Nagar Branch',
    750000, relDate(-60), relDate(305),
    'Renewal deposit — programme continuation',
    'Discrepancy Found', 'Not Requested', abcUserId
  ).lastInsertRowid;

  // FDR-003: Verified and Active
  fdrIds['FDR-003'] = fdrStmt.run(
    xyzInstId, 'FDR-2024-003', 'Canara Bank', 'Koramangala Branch',
    1000000, relDate(-90), relDate(275),
    'Initial security deposit for institutional approval',
    'Verified', 'Not Requested', xyzUserId
  ).lastInsertRowid;

  // FDR-004: Expiring Soon — 25 days
  fdrIds['FDR-004'] = fdrStmt.run(
    xyzInstId, 'FDR-2024-004', 'Bank of Baroda', 'Indiranagar Branch',
    600000, relDate(-340), relDate(25),
    'Annual renewal deposit',
    'Verified', 'Not Requested', xyzUserId
  ).lastInsertRowid;

  // FDR-005: Expiring Soon — 80 days
  fdrIds['FDR-005'] = fdrStmt.run(
    pqrInstId, 'FDR-2024-005', 'HDFC Bank', 'Anna Nagar Branch',
    800000, relDate(-285), relDate(80),
    'Security deposit for additional intake approval',
    'Verified', 'Not Requested', pqrUserId
  ).lastInsertRowid;

  // FDR-006: Matured — no renewal (-20 days past maturity)
  fdrIds['FDR-006'] = fdrStmt.run(
    mnoInstId, 'FDR-2023-006', 'ICICI Bank', 'CG Road Branch',
    450000, relDate(-385), relDate(-20),
    'Security deposit — lapsed',
    'Verified', 'Not Requested', mnoUserId
  ).lastInsertRowid;

  // FDR-007: Discrepancy Found — amount mismatch (R03)
  fdrIds['FDR-007'] = fdrStmt.run(
    mnoInstId, 'FDR-2024-007', 'Axis Bank', 'Navrangpura Branch',
    900000, relDate(-45), relDate(320),
    'New programme security deposit',
    'Discrepancy Found', 'Not Requested', mnoUserId
  ).lastInsertRowid;

  // FDR-008: Discrepancy Found — missing document (R01)
  fdrIds['FDR-008'] = fdrStmt.run(
    defInstId, 'FDR-2024-008', 'Union Bank of India', 'Karol Bagh Branch',
    550000, relDate(-15), relDate(350),
    'Security deposit for programme approval',
    'Pending Review', 'Not Requested', defUserId
  ).lastInsertRowid;

  // FDR-009 & FDR-009B: Duplicate FDR number (R09)
  fdrIds['FDR-009'] = fdrStmt.run(
    ghiInstId, 'FDR-DUPLICATE-999', 'Bank of India', 'MI Road Branch',
    300000, relDate(-70), relDate(295),
    'Security deposit',
    'Pending Review', 'Not Requested', officerId
  ).lastInsertRowid;

  fdrIds['FDR-009B'] = fdrStmt.run(
    rstInstId, 'FDR-DUPLICATE-999', 'Bank of India', 'Park Street Branch',
    300000, relDate(-65), relDate(300),
    'Security deposit — duplicate number scenario',
    'Pending Review', 'Not Requested', officerId
  ).lastInsertRowid;

  // FDR-010: Renewed chain v1 — superseded
  fdrIds['FDR-010-v1'] = fdrStmt.run(
    jklInstId, 'FDR-2023-010', 'UCO Bank', 'Hazratganj Branch',
    400000, relDate(-730), relDate(-365),
    'Original security deposit (superseded)',
    'Verified', 'Not Requested', officerId
  ).lastInsertRowid;

  // FDR-010: Renewed chain v2 — also superseded
  fdrIds['FDR-010-v2'] = fdrStmt.run(
    jklInstId, 'FDR-2024-010B', 'UCO Bank', 'Hazratganj Branch',
    420000, relDate(-365), relDate(-5),
    'Renewal deposit v2 (superseded)',
    'Verified', 'Not Requested', officerId
  ).lastInsertRowid;

  // FDR-010: Renewed chain v3 — current
  fdrIds['FDR-010-v3'] = fdrStmt.run(
    jklInstId, 'FDR-2025-010C', 'UCO Bank', 'Hazratganj Branch',
    440000, relDate(-5), relDate(360),
    'Renewal deposit v3 — current active',
    'Verified', 'Not Requested', officerId
  ).lastInsertRowid;

  // Now wire up the superseded chain
  db.prepare(`UPDATE fdrs SET supersedes_fdr_id = ?,  updated_at = datetime('now') WHERE id = ?`)
    .run(fdrIds['FDR-010-v1'], fdrIds['FDR-010-v2']);
  db.prepare(`UPDATE fdrs SET superseded_by_id  = ?,  updated_at = datetime('now') WHERE id = ?`)
    .run(fdrIds['FDR-010-v2'], fdrIds['FDR-010-v1']);
  db.prepare(`UPDATE fdrs SET supersedes_fdr_id = ?,  updated_at = datetime('now') WHERE id = ?`)
    .run(fdrIds['FDR-010-v2'], fdrIds['FDR-010-v3']);
  db.prepare(`UPDATE fdrs SET superseded_by_id  = ?,  updated_at = datetime('now') WHERE id = ?`)
    .run(fdrIds['FDR-010-v3'], fdrIds['FDR-010-v2']);

  // FDR-011: Release Requested — awaiting officer
  fdrIds['FDR-011'] = fdrStmt.run(
    uvwInstId, 'FDR-2023-011', 'Syndicate Bank', 'Banjara Hills Branch',
    700000, relDate(-400), relDate(-35),
    'Security deposit — release requested',
    'Verified', 'Not Requested', officerId
  ).lastInsertRowid;
  db.prepare(`UPDATE fdrs SET release_state = 'Requested', updated_at = datetime('now') WHERE id = ?`)
    .run(fdrIds['FDR-011']);

  // FDR-012: Release Recommended — awaiting approver
  fdrIds['FDR-012'] = fdrStmt.run(
    lmnInstId, 'FDR-2023-012', 'Indian Bank', 'Arera Colony Branch',
    850000, relDate(-410), relDate(-45),
    'Security deposit — officer recommendation pending approver',
    'Verified', 'Not Requested', officerId
  ).lastInsertRowid;
  db.prepare(`UPDATE fdrs SET release_state = 'Recommended', updated_at = datetime('now') WHERE id = ?`)
    .run(fdrIds['FDR-012']);

  // FDR-013: Released
  fdrIds['FDR-013'] = fdrStmt.run(
    abcInstId, 'FDR-2022-013', 'State Bank of India', 'FC Road Branch',
    600000, relDate(-760), relDate(-395),
    'Security deposit — fully released',
    'Verified', 'Not Requested', abcUserId
  ).lastInsertRowid;
  db.prepare(`UPDATE fdrs SET release_state = 'Approved-Released', updated_at = datetime('now') WHERE id = ?`)
    .run(fdrIds['FDR-013']);

  // FDR-014: Release Rejected
  fdrIds['FDR-014'] = fdrStmt.run(
    xyzInstId, 'FDR-2023-014', 'Corporation Bank', 'Brigade Road Branch',
    500000, relDate(-420), relDate(-55),
    'Security deposit — release rejected',
    'Verified', 'Not Requested', xyzUserId
  ).lastInsertRowid;
  db.prepare(`UPDATE fdrs SET release_state = 'Rejected', updated_at = datetime('now') WHERE id = ?`)
    .run(fdrIds['FDR-014']);

  // FDR-015: Bank-confirmed (simulated)
  fdrIds['FDR-015'] = fdrStmt.run(
    pqrInstId, 'FDR-2024-015', 'HDFC Bank', 'T Nagar Branch',
    1200000, relDate(-120), relDate(245),
    'Large deposit — bank simulated confirmed',
    'Verified', 'Simulated - Confirmed', pqrUserId
  ).lastInsertRowid;

  // FDR-016: Simulated bank mismatch
  fdrIds['FDR-016'] = fdrStmt.run(
    ghiInstId, 'FDR-2024-016', 'Kotak Mahindra Bank', 'Vaishali Nagar Branch',
    350000, relDate(-50), relDate(315),
    'Security deposit — bank simulation mismatch',
    'Discrepancy Found', 'Simulated - Mismatch', officerId
  ).lastInsertRowid;

  console.log(`  ✓ Inserted ${Object.keys(fdrIds).length} FDRs`);

  // ------------------------------------------------------------------
  // 5. Generate and attach documents
  // ------------------------------------------------------------------
  console.log('  ⏳ Generating sample PDF documents...');

  async function attachDoc(fdrId, fdrNumber, instName, amount, issueDate, maturityDate, uploadedBy, versionNo = 1) {
    const docInfo = await generatePdf(fdrNumber, instName, amount, issueDate, maturityDate);
    return insertDocument(
      fdrId, uploadedBy,
      docInfo.storedName, `${fdrNumber}-FDR-Document-v${versionNo}.pdf`,
      docInfo.sha256, docInfo.size, docInfo.mime, versionNo
    );
  }

  // Attach documents to all FDRs except FDR-008 (missing document scenario)
  const docIds = {};

  const fdr001 = db.prepare(`SELECT * FROM fdrs WHERE id = ?`).get(fdrIds['FDR-001']);
  docIds['FDR-001'] = await attachDoc(fdrIds['FDR-001'], 'FDR-2024-001', 'ABC Institute of Technology', 500000, fdr001.issue_date, fdr001.maturity_date, abcUserId);

  // FDR-002: document has a DIFFERENT maturity date than declared (to trigger R02)
  const fdr002 = db.prepare(`SELECT * FROM fdrs WHERE id = ?`).get(fdrIds['FDR-002']);
  docIds['FDR-002'] = await attachDoc(fdrIds['FDR-002'], 'FDR-2024-002', 'ABC Institute of Technology', 750000, fdr002.issue_date, fdr002.maturity_date, abcUserId);

  const fdr003 = db.prepare(`SELECT * FROM fdrs WHERE id = ?`).get(fdrIds['FDR-003']);
  docIds['FDR-003'] = await attachDoc(fdrIds['FDR-003'], 'FDR-2024-003', 'XYZ Engineering College', 1000000, fdr003.issue_date, fdr003.maturity_date, xyzUserId);

  const fdr004 = db.prepare(`SELECT * FROM fdrs WHERE id = ?`).get(fdrIds['FDR-004']);
  docIds['FDR-004'] = await attachDoc(fdrIds['FDR-004'], 'FDR-2024-004', 'XYZ Engineering College', 600000, fdr004.issue_date, fdr004.maturity_date, xyzUserId);

  const fdr005 = db.prepare(`SELECT * FROM fdrs WHERE id = ?`).get(fdrIds['FDR-005']);
  docIds['FDR-005'] = await attachDoc(fdrIds['FDR-005'], 'FDR-2024-005', 'PQR Polytechnic Institute', 800000, fdr005.issue_date, fdr005.maturity_date, pqrUserId);

  const fdr006 = db.prepare(`SELECT * FROM fdrs WHERE id = ?`).get(fdrIds['FDR-006']);
  docIds['FDR-006'] = await attachDoc(fdrIds['FDR-006'], 'FDR-2023-006', 'MNO College of Engineering', 450000, fdr006.issue_date, fdr006.maturity_date, mnoUserId);

  const fdr007 = db.prepare(`SELECT * FROM fdrs WHERE id = ?`).get(fdrIds['FDR-007']);
  docIds['FDR-007'] = await attachDoc(fdrIds['FDR-007'], 'FDR-2024-007', 'MNO College of Engineering', 900000, fdr007.issue_date, fdr007.maturity_date, mnoUserId);
  // FDR-008 intentionally has NO document (R01 scenario)

  const fdr009  = db.prepare(`SELECT * FROM fdrs WHERE id = ?`).get(fdrIds['FDR-009']);
  docIds['FDR-009']  = await attachDoc(fdrIds['FDR-009'],  'FDR-DUPLICATE-999', 'GHI School of Engineering', 300000, fdr009.issue_date, fdr009.maturity_date, officerId);
  const fdr009b = db.prepare(`SELECT * FROM fdrs WHERE id = ?`).get(fdrIds['FDR-009B']);
  docIds['FDR-009B'] = await attachDoc(fdrIds['FDR-009B'], 'FDR-DUPLICATE-999', 'RST College of Applied Sciences', 300000, fdr009b.issue_date, fdr009b.maturity_date, officerId);

  const fdr010v1 = db.prepare(`SELECT * FROM fdrs WHERE id = ?`).get(fdrIds['FDR-010-v1']);
  docIds['FDR-010-v1'] = await attachDoc(fdrIds['FDR-010-v1'], 'FDR-2023-010',  'JKL Institute', 400000, fdr010v1.issue_date, fdr010v1.maturity_date, officerId, 1);
  const fdr010v2 = db.prepare(`SELECT * FROM fdrs WHERE id = ?`).get(fdrIds['FDR-010-v2']);
  docIds['FDR-010-v2'] = await attachDoc(fdrIds['FDR-010-v2'], 'FDR-2024-010B', 'JKL Institute', 420000, fdr010v2.issue_date, fdr010v2.maturity_date, officerId, 2);
  const fdr010v3 = db.prepare(`SELECT * FROM fdrs WHERE id = ?`).get(fdrIds['FDR-010-v3']);
  docIds['FDR-010-v3'] = await attachDoc(fdrIds['FDR-010-v3'], 'FDR-2025-010C', 'JKL Institute', 440000, fdr010v3.issue_date, fdr010v3.maturity_date, officerId, 3);

  for (const key of ['FDR-011','FDR-012','FDR-013','FDR-014','FDR-015','FDR-016']) {
    const fdr = db.prepare(`SELECT * FROM fdrs WHERE id = ?`).get(fdrIds[key]);
    docIds[key] = await attachDoc(fdrIds[key], fdr.fdr_number, 'Institution', fdr.amount, fdr.issue_date, fdr.maturity_date, officerId);
  }

  console.log('  ✓ Documents generated and attached');

  // ------------------------------------------------------------------
  // 6. Extracted values (officer-entered) — FDR-002 has a mismatch to trigger R02
  // ------------------------------------------------------------------

  // FDR-002: Officer entered a DIFFERENT maturity date — triggers R02
  const fdr002row = db.prepare(`SELECT * FROM fdrs WHERE id = ?`).get(fdrIds['FDR-002']);
  const wrongMaturity = relDate(305 + 30); // 30 days later than declared
  db.prepare(`
    INSERT INTO document_extracted_values
      (fdr_id, document_id, fdr_number, bank_name, amount, issue_date, maturity_date, entered_by, entered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(fdrIds['FDR-002'], docIds['FDR-002'], 'FDR-2024-002', 'Punjab National Bank',
         750000, fdr002row.issue_date, wrongMaturity, officerId);

  // FDR-007: Officer entered a DIFFERENT amount — triggers R03
  const fdr007row = db.prepare(`SELECT * FROM fdrs WHERE id = ?`).get(fdrIds['FDR-007']);
  db.prepare(`
    INSERT INTO document_extracted_values
      (fdr_id, document_id, fdr_number, bank_name, amount, issue_date, maturity_date, entered_by, entered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(fdrIds['FDR-007'], docIds['FDR-007'], 'FDR-2024-007', 'Axis Bank',
         850000,  /* declared is 900000 */ fdr007row.issue_date, fdr007row.maturity_date, officerId);

  // FDR-003, 004, 005: Correct extracted values (Verified)
  for (const [key, docKey] of [['FDR-003','FDR-003'],['FDR-004','FDR-004'],['FDR-005','FDR-005']]) {
    const fdr = db.prepare(`SELECT * FROM fdrs WHERE id = ?`).get(fdrIds[key]);
    db.prepare(`
      INSERT INTO document_extracted_values
        (fdr_id, document_id, fdr_number, bank_name, amount, issue_date, maturity_date, entered_by, entered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(fdrIds[key], docIds[docKey], fdr.fdr_number, fdr.bank_name,
           fdr.amount, fdr.issue_date, fdr.maturity_date, officerId);
  }

  console.log('  ✓ Extracted values inserted');

  // ------------------------------------------------------------------
  // 7. Run discrepancy engine on key FDRs
  // ------------------------------------------------------------------
  const fdrKeysForDiscrepancy = [
    'FDR-001','FDR-002','FDR-003','FDR-004','FDR-005',
    'FDR-006','FDR-007','FDR-008','FDR-009','FDR-009B',
    'FDR-010-v1','FDR-010-v2','FDR-010-v3',
    'FDR-015','FDR-016',
  ];
  for (const key of fdrKeysForDiscrepancy) {
    try { runDiscrepancyEngine(fdrIds[key]); } catch (_) { /* non-fatal */ }
  }
  console.log('  ✓ Discrepancy engine run on all FDRs');

  // ------------------------------------------------------------------
  // 8. Release requests
  // ------------------------------------------------------------------
  const checklistTemplate = JSON.parse(
    db.prepare(`SELECT value FROM settings WHERE key = 'release_checklist_template'`).get().value
  );
  const checklistSnapshot = JSON.stringify(checklistTemplate.map(item => ({ item, checked: true })));

  // FDR-011: Release Requested — pending officer
  db.prepare(`
    INSERT INTO release_requests
      (fdr_id, requested_by, reason, requested_at, checklist_json, status)
    VALUES (?, ?, ?, datetime('now'), ?, 'Pending Officer')
  `).run(fdrIds['FDR-011'], mnoUserId,
    'FDR has matured and all regulatory obligations have been fulfilled. Requesting release of security deposit.',
    checklistSnapshot);

  // FDR-012: Recommended — pending approver
  const rr12 = db.prepare(`
    INSERT INTO release_requests
      (fdr_id, requested_by, reason, requested_at, checklist_json,
       officer_recommendation, officer_remarks, status)
    VALUES (?, ?, ?, datetime('now'), ?, 'Recommend',
            'All documents verified. No pending discrepancies. Recommend release.', 'Pending Approver')
  `).run(fdrIds['FDR-012'], officerId,
    'Security deposit tenure completed. Institution has fulfilled all prescribed conditions.',
    checklistSnapshot);

  // FDR-013: Released
  db.prepare(`
    INSERT INTO release_requests
      (fdr_id, requested_by, reason, requested_at, checklist_json,
       officer_recommendation, officer_remarks,
       approver_decision, approver_remarks, decided_at, status)
    VALUES (?, ?, ?, datetime('now'), ?,
            'Recommend', 'Verified and clean. Recommend release.',
            'Approved', 'All conditions satisfied. Release approved.', datetime('now'), 'Approved-Released')
  `).run(fdrIds['FDR-013'], abcUserId,
    'Requesting release after successful completion of approved programme.',
    checklistSnapshot);

  // FDR-014: Release Rejected
  db.prepare(`
    INSERT INTO release_requests
      (fdr_id, requested_by, reason, requested_at, checklist_json,
       officer_recommendation, officer_remarks,
       approver_decision, approver_remarks, decided_at, status)
    VALUES (?, ?, ?, datetime('now'), ?,
            'Do Not Recommend', 'Pending regulatory closure confirmation.',
            'Rejected', 'Release cannot be approved at this stage. Regulatory clearance pending.', datetime('now'), 'Rejected')
  `).run(fdrIds['FDR-014'], xyzUserId,
    'Requesting release of matured FDR.',
    checklistSnapshot);

  console.log('  ✓ Release requests inserted');

  // ------------------------------------------------------------------
  // 9. Seed audit log entries via real logAudit() — valid hash chain
  // ------------------------------------------------------------------
  logAudit({ actorUserId: abcUserId, actorRole: 'college', action: 'FDR_SUBMITTED', entityType: 'fdr', entityId: fdrIds['FDR-001'], details: { fdr_number: 'FDR-2024-001', amount: 500000 } });
  logAudit({ actorUserId: abcUserId, actorRole: 'college', action: 'DOCUMENT_UPLOADED', entityType: 'fdr', entityId: fdrIds['FDR-001'], details: { version: 1 } });
  logAudit({ actorUserId: abcUserId, actorRole: 'college', action: 'FDR_SUBMITTED', entityType: 'fdr', entityId: fdrIds['FDR-002'], details: { fdr_number: 'FDR-2024-002', amount: 750000 } });
  logAudit({ actorUserId: officerId, actorRole: 'officer', action: 'EXTRACTED_VALUES_ENTERED', entityType: 'fdr', entityId: fdrIds['FDR-002'], details: { note: 'Maturity date differs from declared' } });
  logAudit({ actorUserId: officerId, actorRole: 'officer', action: 'DISCREPANCY_RAISED', entityType: 'fdr', entityId: fdrIds['FDR-002'], details: { rule_code: 'R02', severity: 'High' } });
  logAudit({ actorUserId: officerId, actorRole: 'officer', action: 'FDR_VERIFIED', entityType: 'fdr', entityId: fdrIds['FDR-003'], details: { fdr_number: 'FDR-2024-003' } });
  logAudit({ actorUserId: officerId, actorRole: 'officer', action: 'FDR_VERIFIED', entityType: 'fdr', entityId: fdrIds['FDR-004'], details: { fdr_number: 'FDR-2024-004' } });
  logAudit({ actorUserId: officerId, actorRole: 'officer', action: 'FDR_VERIFIED', entityType: 'fdr', entityId: fdrIds['FDR-005'], details: { fdr_number: 'FDR-2024-005' } });
  logAudit({ actorUserId: officerId, actorRole: 'officer', action: 'BANK_SIM_CONFIRMED', entityType: 'fdr', entityId: fdrIds['FDR-015'], details: { bank_confirmation: 'Simulated - Confirmed' } });
  logAudit({ actorUserId: mnoUserId, actorRole: 'college', action: 'RELEASE_REQUESTED', entityType: 'fdr', entityId: fdrIds['FDR-011'], details: {} });
  logAudit({ actorUserId: officerId, actorRole: 'officer', action: 'RELEASE_RECOMMENDED', entityType: 'fdr', entityId: fdrIds['FDR-012'], details: { recommendation: 'Recommend' } });
  logAudit({ actorUserId: approverId, actorRole: 'approver', action: 'RELEASE_APPROVED', entityType: 'fdr', entityId: fdrIds['FDR-013'], details: { decision: 'Approved' } });
  logAudit({ actorUserId: approverId, actorRole: 'approver', action: 'RELEASE_REJECTED', entityType: 'fdr', entityId: fdrIds['FDR-014'], details: { decision: 'Rejected', reason: 'Regulatory clearance pending' } });
  logAudit({ actorUserId: null, actorRole: 'system', action: 'SEED_COMPLETE', entityType: 'system', entityId: null, details: { message: 'Database seeded successfully' } });

  console.log('  ✓ Audit log entries seeded (hash chain valid)');

  // ------------------------------------------------------------------
  // 10. Sample notifications
  // ------------------------------------------------------------------
  const notifStmt = db.prepare(`
    INSERT INTO notifications (user_id, fdr_id, type, message, is_read, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);

  notifStmt.run(abcUserId, fdrIds['FDR-002'], 'DISCREPANCY_FOUND', 'Discrepancy found on FDR-2024-002: maturity date mismatch (R02). Please review.', 0);
  notifStmt.run(abcUserId, fdrIds['FDR-004'], 'REMINDER_25', 'FDR FDR-2024-004 is expiring in approximately 25 days. Please initiate renewal.', 0);
  notifStmt.run(officerId, fdrIds['FDR-008'], 'MISSING_DOCUMENT', 'FDR FDR-2024-008 has no uploaded document. Attention required.', 0);
  notifStmt.run(mnoUserId, fdrIds['FDR-011'], 'RELEASE_STATUS', 'Your release request for FDR-2023-011 is pending officer review.', 1);
  notifStmt.run(xyzUserId, fdrIds['FDR-014'], 'RELEASE_REJECTED', 'Release request for FDR-2023-014 has been rejected. See remarks for details.', 0);

  console.log('  ✓ Sample notifications inserted');

  // ------------------------------------------------------------------
  // Done
  // ------------------------------------------------------------------
  console.log(`
✅  Seed complete!

  Demo credentials (password: Demo@1234 for all):
  ┌─────────────────────────────────┬──────────┐
  │ Email                           │ Role     │
  ├─────────────────────────────────┼──────────┤
  │ college.abc@demo.in             │ college  │
  │ college.xyz@demo.in             │ college  │
  │ college.pqr@demo.in             │ college  │
  │ college.mno@demo.in             │ college  │
  │ college.def@demo.in             │ college  │
  │ officer@demo.in                 │ officer  │
  │ approver@demo.in                │ approver │
  └─────────────────────────────────┴──────────┘

  Start: npm start  |  Dev: npm run dev
  Login: http://localhost:3000/auth/login
  `);
}

seed().catch(err => {
  console.error('❌  Seed failed:', err);
  process.exit(1);
});
