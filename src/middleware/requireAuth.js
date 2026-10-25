'use strict';

/**
 * requireAuth middleware
 * Ensures the user is logged in. Redirects to /auth/login if not.
 */
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  req.session.returnTo = req.originalUrl;
  res.redirect('/auth/login');
}

module.exports = requireAuth;
