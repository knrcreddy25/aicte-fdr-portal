'use strict';

const express = require('express');
const bcrypt = require('bcrypt');
const { getDb } = require('../db/db');
const { logAudit } = require('../services/audit');

const router = express.Router();

// Demo credentials shown on login page
const DEMO_ACCOUNTS = [
  { email: 'college.abc@demo.in',  role: 'college',  name: 'ABC Institute of Technology' },
  { email: 'college.xyz@demo.in',  role: 'college',  name: 'XYZ Engineering College' },
  { email: 'college.pqr@demo.in',  role: 'college',  name: 'PQR Polytechnic' },
  { email: 'college.mno@demo.in',  role: 'college',  name: 'MNO College of Engineering' },
  { email: 'college.def@demo.in',  role: 'college',  name: 'DEF Technical Institute' },
  { email: 'officer@demo.in',      role: 'officer',  name: 'AICTE Regulation Officer' },
  { email: 'approver@demo.in',     role: 'approver', name: 'AICTE Competent Authority' },
];

// GET /auth/login
router.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard');
  res.render('auth/login', {
    title: 'Login — AICTE FDR Portal',
    demoAccounts: DEMO_ACCOUNTS,
    error: req.session.loginError || null,
    csrfToken: req.csrfToken(),
  });
  delete req.session.loginError;
});

// POST /auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    req.session.loginError = 'Email and password are required.';
    return res.redirect('/auth/login');
  }

  const db = getDb();
  const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email.trim().toLowerCase());

  if (!user) {
    req.session.loginError = 'Invalid email or password.';
    return res.redirect('/auth/login');
  }

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    req.session.loginError = 'Invalid email or password.';
    logAudit({
      actorUserId: user.id,
      actorRole: user.role,
      action: 'LOGIN_FAILED',
      entityType: 'user',
      entityId: user.id,
      details: { email, reason: 'wrong_password' }
    });
    return res.redirect('/auth/login');
  }

  // Regenerate session to prevent session fixation
  req.session.regenerate((err) => {
    if (err) return res.redirect('/auth/login');

    req.session.userId        = user.id;
    req.session.userRole      = user.role;
    req.session.userName      = user.name;
    req.session.institutionId = user.institution_id;
    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      institution_id: user.institution_id,
    };

    logAudit({
      actorUserId: user.id,
      actorRole: user.role,
      action: 'LOGIN_SUCCESS',
      entityType: 'user',
      entityId: user.id,
      details: { email }
    });

    const returnTo = req.session.returnTo || '/dashboard';
    delete req.session.returnTo;
    res.redirect(returnTo);
  });
});

// POST /auth/logout
router.post('/logout', (req, res) => {
  const userId   = req.session.userId;
  const userRole = req.session.userRole;

  logAudit({
    actorUserId: userId,
    actorRole: userRole,
    action: 'LOGOUT',
    entityType: 'user',
    entityId: userId,
    details: {}
  });

  req.session.destroy(() => {
    res.redirect('/auth/login');
  });
});

module.exports = router;
