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

function hasRequiredRole(userRoles, allowedRoles) {
  if (userRoles.includes('system_admin')) return true;
  return allowedRoles.some((role) => ROLE_ALIASES[role]?.some((alias) => userRoles.includes(alias)));
}

function isActiveDoctor(user) {
  return Boolean(user?.roles?.includes('doctor'));
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

async function getActiveUserById(userId, client = db) {
  const { rows } = await client.query(
    `SELECT u.id, u.name, u.email,
            array_agg(DISTINCT r.role_key) FILTER (WHERE r.role_key IS NOT NULL) AS roles
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id AND r.active = TRUE
     WHERE u.id = $1 AND u.active = TRUE
     GROUP BY u.id`,
    [userId]
  );
  if (!rows.length || !rows[0].roles?.length) return null;
  return { ...rows[0], roles: rows[0].roles };
}

function requireAuthentication(req, res, next) {
  if (!req.session.user) {
    const returnTo = encodeURIComponent(req.originalUrl);
    return res.redirect(`/login?returnTo=${returnTo}`);
  }
  if (req.session.user.is_2fa_verified !== true) {
    return req.session.destroy((error) => {
      if (error) return next(error);
      res.clearCookie('sigemed.sid');
      res.redirect('/login');
    });
  }
  res.locals.currentUser = req.session.user;
  next();
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    const userRoles = req.session.user?.roles || [];
    if (!hasRequiredRole(userRoles, allowedRoles)) {
      return res.status(403).send('No tienes permisos para realizar esta acción.');
    }
    next();
  };
}

async function requireActiveDoctor(req, res, next) {
  try {
    const user = await getActiveUserById(req.session.user.id);
    if (!isActiveDoctor(user)) {
      return res.status(403).send('Solo un médico activo puede realizar esta acción clínica.');
    }
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = {
  canAssignRole,
  getActiveUserById,
  hasRequiredRole,
  isActiveDoctor,
  requireAuthentication,
  requireActiveDoctor,
  requireRole,
  verifyCredentials,
};
