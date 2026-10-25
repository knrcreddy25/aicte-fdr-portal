'use strict';

/**
 * requireRole(...roles)
 * Returns middleware that checks the logged-in user's role.
 * Returns 403 if the role is not in the allowed list.
 *
 * Usage:
 *   router.get('/officer-only', requireAuth, requireRole('officer', 'approver'), handler)
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.userId) {
      return res.redirect('/auth/login');
    }
    if (!roles.includes(req.session.userRole)) {
      return res.status(403).render('errors/403', {
        title: 'Access Denied',
        user: req.session.user || null,
      });
    }
    next();
  };
}

/**
 * requireInstitutionAccess
 * Checks that a college user only accesses their own institution's FDRs.
 * Officers and approvers bypass this check.
 *
 * Usage:
 *   const fdr = db.prepare('SELECT * FROM fdrs WHERE id = ?').get(req.params.id);
 *   requireInstitutionAccess(req, res, fdr.institution_id, next);
 */
function requireInstitutionAccess(req, res, resourceInstitutionId, next) {
  if (req.session.userRole !== 'college') return next();

  if (Number(req.session.institutionId) !== Number(resourceInstitutionId)) {
    return res.status(403).render('errors/403', {
      title: 'Access Denied',
      user: req.session.user || null,
    });
  }
  next();
}

module.exports = { requireRole, requireInstitutionAccess };
