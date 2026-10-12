const bcrypt = require('bcryptjs');
const db = require('./db');

const ROLE_ALIASES = {
  system_admin: ['system_admin'],
  doctor: ['doctor'],
  admissions: ['admissions'],
  audit_security: ['audit_security'],
  nurse: ['nurse'],
  patient: ['patient'],
};

const AUDIT_ASSIGNABLE_ROLES = new Set(['doctor', 'admissions', 'nurse', 'patient']);

function canAssignRole(actorRoles, targetRole) {
  if (actorRoles.includes('system_admin')) return true;
  return actorRoles.includes('audit_security') && AUDIT_ASSIGNABLE_ROLES.has(targetRole);
}

async function verifyCredentials(email, password) {
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.email, u.password_hash, u.active,
            array_agg(DISTINCT r.role_key) FILTER (WHERE r.role_key IS NOT NULL) AS roles
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id AND r.active = TRUE
     WHERE lower(u.email) = lower($1)
     GROUP BY u.id`,
    [email]
  );
  const user = rows[0];
  if (!user || !user.active || typeof user.password_hash !== 'string'
      || !user.password_hash.startsWith('$2')) return null;
  if (!(await bcrypt.compare(password, user.password_hash))) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    roles: user.roles || [],
  };
}

function requireAuthentication(req, res, next) {
  if (!req.session.user) {
    const returnTo = encodeURIComponent(req.originalUrl);
    return res.redirect(`/login?returnTo=${returnTo}`);
  }
  res.locals.currentUser = req.session.user;
  next();
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    const userRoles = req.session.user?.roles || [];
    if (!allowedRoles.some((role) => ROLE_ALIASES[role]?.some((alias) => userRoles.includes(alias)))) {
      return res.status(403).send('No tienes permisos para realizar esta acción.');
    }
    next();
  };
}

module.exports = {
  canAssignRole,
  requireAuthentication,
  requireRole,
  verifyCredentials,
};
