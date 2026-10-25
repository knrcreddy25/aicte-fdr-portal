'use strict';

const express = require('express');
const { getDb } = require('../db/db');
const requireAuth = require('../middleware/requireAuth');

const router = express.Router();

// GET /notifications — list all notifications for logged-in user
router.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const notifications = db.prepare(`
    SELECT n.*, f.fdr_number
    FROM notifications n
    LEFT JOIN fdrs f ON f.id = n.fdr_id
    WHERE n.user_id = ?
    ORDER BY n.created_at DESC
    LIMIT 100
  `).all(req.session.userId);

  res.render('shared/notifications', {
    title: 'Notifications',
    notifications,
    user: req.session.user,
    breadcrumbs: [{ label: 'Notifications' }],
  });
});

// POST /notifications/mark-read — mark all as read
router.post('/mark-read', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare(`UPDATE notifications SET is_read = 1 WHERE user_id = ?`).run(req.session.userId);
  res.redirect('/notifications');
});

// POST /notifications/:id/read — mark one as read
router.post('/:id/read', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare(`UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?`)
    .run(req.params.id, req.session.userId);
  res.redirect('back');
});

module.exports = router;
