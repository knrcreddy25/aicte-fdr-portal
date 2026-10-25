'use strict';

const path    = require('path');
const fs      = require('fs');
const express = require('express');
const helmet  = require('helmet');
const session = require('express-session');
const bcrypt  = require('bcrypt');  // needed indirectly via routes
const rateLimit = require('express-rate-limit');
const cron    = require('node-cron');
const Tokens  = require('csrf');

// ---- DB ----
const { getDb, seedDefaultSettings } = require('./src/db/db');

// ---- Services ----
const { runReminderJob } = require('./src/services/reminders');
const { getDb: _getDb }  = require('./src/db/db'); // alias

// ---- Routes ----
const authRouter          = require('./src/routes/auth');
const notificationsRouter = require('./src/routes/notifications');

// ---- Middleware ----
const requireAuth               = require('./src/middleware/requireAuth');
const { requireRole }           = require('./src/middleware/requireRole');

// ---- Ensure uploads folder exists ----
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// ---- Initialise DB + default settings ----
const db = getDb();
seedDefaultSettings(db);

// ====================================================================
// Express app
// ====================================================================
const app = express();

// ---- Security headers ----
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "cdn.jsdelivr.net", "'unsafe-inline'"],
      styleSrc:    ["'self'", "cdn.jsdelivr.net", "'unsafe-inline'"],
      imgSrc:      ["'self'", "data:"],
      fontSrc:     ["'self'", "cdn.jsdelivr.net"],
      connectSrc:  ["'self'"],
    }
  }
}));

// ---- View engine ----
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src', 'views'));

// ---- Body parsers ----
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));

// ---- Static files ----
app.use(express.static(path.join(__dirname, 'public')));

// ---- Session ----
const SQLiteStore = require('connect-sqlite3')(session);
app.use(session({
  store: new SQLiteStore({
    db: 'sessions.db',
    dir: path.join(__dirname, 'data'),
  }),
  secret: process.env.SESSION_SECRET || 'aicte-fdr-demo-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
  },
  name: 'fdrportal.sid',
}));

// ---- CSRF Protection ----
// Using the 'csrf' package (synchronizer token pattern)
const tokens = new Tokens();

// Middleware to set up CSRF token on every request
app.use((req, res, next) => {
  // Skip CSRF for GET/HEAD/OPTIONS
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    // Provide token for forms
    if (!req.session.csrfSecret) {
      req.session.csrfSecret = tokens.secretSync();
    }
    req.csrfToken = () => tokens.create(req.session.csrfSecret);
    res.locals.csrfToken = req.csrfToken();
    return next();
  }

  // Verify token for mutating methods
  const secret = req.session.csrfSecret;
  const token  = req.body._csrf || req.headers['x-csrf-token'];

  if (!secret || !token || !tokens.verify(secret, token)) {
    return res.status(403).render('errors/403', {
      title: 'CSRF Validation Failed',
      user: req.session.user || null,
    });
  }

  req.csrfToken = () => tokens.create(secret);
  res.locals.csrfToken = req.csrfToken();
  next();
});

// ---- Rate limiter on login ----
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: 'Too many login attempts. Please try again in 15 minutes.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/auth/login', loginLimiter);

// ---- Global template locals ----
app.use((req, res, next) => {
  // Make session user available in all views
  res.locals.user         = req.session.user || null;
  res.locals.userRole     = req.session.userRole || null;
  res.locals.csrfToken    = req.csrfToken ? req.csrfToken() : '';

  // Unread notification count
  if (req.session.userId) {
    try {
      const unread = db.prepare(
        `SELECT COUNT(*) AS cnt FROM notifications WHERE user_id = ? AND is_read = 0`
      ).get(req.session.userId);
      res.locals.unreadCount = unread ? unread.cnt : 0;
    } catch (_) {
      res.locals.unreadCount = 0;
    }
  } else {
    res.locals.unreadCount = 0;
  }

  next();
});

// ====================================================================
// Routes
// ====================================================================

app.get('/', (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard');
  res.redirect('/auth/login');
});

app.use('/auth',          authRouter);
app.use('/notifications', notificationsRouter);

// ---- Dashboard (stub — to be implemented by higher model) ----
app.get('/dashboard', requireAuth, (req, res) => {
  res.render('shared/dashboard-stub', {
    title: 'Dashboard — AICTE FDR Portal',
    breadcrumbs: [],
    user: req.session.user,
  });
});

// ---- FDR routes (stub placeholder) ----
app.get('/fdrs', requireAuth, (req, res) => {
  res.render('shared/coming-soon', {
    title: 'FDR List',
    breadcrumbs: [{ label: 'FDRs' }],
    pageName: 'FDR List',
    user: req.session.user,
  });
});

// ---- Release requests (stub) ----
app.get('/release-requests', requireAuth, requireRole('officer', 'approver'), (req, res) => {
  res.render('shared/coming-soon', {
    title: 'Release Queue',
    breadcrumbs: [{ label: 'Release Queue' }],
    pageName: 'Release Queue',
    user: req.session.user,
  });
});

// ---- Reports (stub) ----
app.get('/reports/:reportName', requireAuth, requireRole('officer', 'approver'), (req, res) => {
  res.render('shared/coming-soon', {
    title: 'Reports',
    breadcrumbs: [{ label: 'Reports' }, { label: req.params.reportName }],
    pageName: `Report: ${req.params.reportName}`,
    user: req.session.user,
  });
});

// ---- Audit log (stub) ----
app.get('/audit-log', requireAuth, requireRole('officer', 'approver'), (req, res) => {
  res.render('shared/coming-soon', {
    title: 'Audit Log',
    breadcrumbs: [{ label: 'Audit Log' }],
    pageName: 'Audit Log',
    user: req.session.user,
  });
});

// ---- Outbox (stub) ----
app.get('/outbox', requireAuth, requireRole('officer', 'approver'), (req, res) => {
  res.render('shared/coming-soon', {
    title: 'Email Outbox',
    breadcrumbs: [{ label: 'Outbox' }],
    pageName: 'Simulated Email Outbox',
    user: req.session.user,
  });
});

// ---- Settings (stub) ----
app.get('/settings', requireAuth, requireRole('officer', 'approver'), (req, res) => {
  res.render('shared/coming-soon', {
    title: 'Settings',
    breadcrumbs: [{ label: 'Settings' }],
    pageName: 'Settings',
    user: req.session.user,
  });
});

// ---- Admin: Run reminder job manually ----
app.post('/admin/run-reminder-job', requireAuth, requireRole('officer', 'approver'), (req, res) => {
  try {
    const summary = runReminderJob();
    res.json({ ok: true, summary });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ====================================================================
// Error handlers
// ====================================================================

// 404
app.use((req, res) => {
  res.status(404).render('errors/404', {
    title: '404 — Not Found',
    user: req.session.user || null,
  });
});

// 500
app.use((err, req, res, next) => {  // eslint-disable-line no-unused-vars
  console.error('[ERROR]', err);
  res.status(500).render('errors/500', {
    title: '500 — Server Error',
    user: req.session.user || null,
    err,
  });
});

// ====================================================================
// Scheduled jobs
// ====================================================================

// Nightly at 02:00 AM
cron.schedule('0 2 * * *', () => {
  console.log('[CRON] Running nightly reminder job...');
  try {
    const summary = runReminderJob();
    console.log('[CRON] Reminder job complete:', summary);
  } catch (err) {
    console.error('[CRON] Reminder job failed:', err);
  }
});

// ====================================================================
// Start server
// ====================================================================

const PORT = process.env.PORT || 3000;

// Only start listening if this file is run directly (not required by tests)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n✅  AICTE FDR Portal running at http://localhost:${PORT}`);
    console.log(`    Environment : ${process.env.NODE_ENV || 'development'}`);
    console.log(`    DB          : ${path.join(__dirname, 'data', 'portal.db')}`);
    console.log(`    Demo login  : http://localhost:${PORT}/auth/login\n`);
  });
}

module.exports = app; // export for tests
