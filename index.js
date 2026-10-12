require('dotenv').config();
const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const connectPgSimple = require('connect-pg-simple');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const db = require('./db');
const PDFDocument = require('pdfkit'); 
const { canAssignRole, requireAuthentication, requireRole, verifyCredentials } = require('./auth');
const booking = require('./services/booking');
const { mapAppointmentsToCalendarEvents } = require('./services/appointment-calendar');
const doctorSchedules = require('./services/doctor-schedules');
const { normalizeDiagnosisCodes } = require('./services/clinical-note');
const { normalizeStudyOrderInput } = require('./services/study-orders');
const { normalizeMedication, normalizePrescriptionItems } = require('./services/prescription');
const billing = require('./services/billing');
const reports = require('./services/reports');
const { recordAccessEvent } = require('./services/audit');
const app = express();

const isProduction = process.env.NODE_ENV === 'production';
const configuredSessionSecret = process.env.SESSION_SECRET;
const sessionSecretPlaceholder = /^(replace[-_ ]with|change[-_ ]me|your[-_ ]|secret$|password$)/i;
if (isProduction
    && (typeof configuredSessionSecret !== 'string'
      || configuredSessionSecret.trim().length < 32
      || sessionSecretPlaceholder.test(configuredSessionSecret.trim()))) {
  throw new Error('En producción, SESSION_SECRET debe ser aleatorio y tener al menos 32 caracteres.');
}

const sessionSecret = configuredSessionSecret || crypto.randomBytes(48).toString('hex');
const PgSessionStore = connectPgSimple(session);

app.disable('x-powered-by');
if (process.env.TRUST_PROXY !== undefined) {
  if (!/^(0|[1-9]\d*)$/.test(process.env.TRUST_PROXY) || Number(process.env.TRUST_PROXY) > 10) {
    throw new Error('TRUST_PROXY debe ser un número de saltos entre 0 y 10.');
  }
  app.set('trust proxy', Number(process.env.TRUST_PROXY));
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'self'"],
    },
  },
  hsts: isProduction
    ? { maxAge: 31_536_000, includeSubDomains: false, preload: false }
    : false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));
app.use('/assets/bootstrap', express.static(path.join(__dirname, 'node_modules', 'bootstrap', 'dist')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.use(session({
  store: new PgSessionStore({ pool: db.pool, createTableIfMissing: true }),
  secret: sessionSecret,
  name: 'sigemed.sid',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    maxAge: 8 * 60 * 60 * 1000,
  },
}));

app.use((req, res, next) => {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;
  next();
});

app.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  const token = req.body?._csrf || req.get('x-csrf-token');
  const submittedToken = Buffer.from(String(token || ''));
  const sessionToken = Buffer.from(req.session.csrfToken);
  if (submittedToken.length !== sessionToken.length
      || !crypto.timingSafeEqual(submittedToken, sessionToken)) {
    return res.status(403).send('La solicitud expiró o no es válida. Actualiza la página e inténtalo de nuevo.');
  }
  next();
});

const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: 'Demasiados intentos de acceso. Espera 15 minutos e inténtalo de nuevo.',
});

app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (error) {
    console.error('Health check de base de datos fallido:', error.message);
    res.status(503).json({ status: 'unavailable' });
  }
});

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { error: null });
});

app.post('/login', loginRateLimit, async (req, res, next) => {
  const email = String(req.body.email || '').trim();
  const password = String(req.body.password || '');
  try {
    const user = await verifyCredentials(email, password);
    if (!user) {
      await recordAccessEvent(db, req, {
        eventType: 'auth_login_failure',
        resourceType: 'authentication',
        details: { reason: 'invalid_credentials' },
      });
      return res.status(401).render('login', { error: 'Correo o contraseña no válidos.' });
    }
    if (user.roles.length === 0) {
      await recordAccessEvent(db, req, {
        eventType: 'auth_login_failure',
        resourceType: 'authentication',
        userId: user.id,
        details: { reason: 'no_active_role' },
      });
      return res.status(403).render('login', { error: 'La cuenta no tiene un perfil activo. Contacta al administrador.' });
    }
    await recordAccessEvent(db, req, {
      eventType: 'auth_login_success',
      resourceType: 'authentication',
      userId: user.id,
    });
    req.session.regenerate((error) => {
      if (error) return next(error);
      req.session.user = user;
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');
      const returnTo = typeof req.query.returnTo === 'string'
          && req.query.returnTo.startsWith('/')
          && !req.query.returnTo.startsWith('//')
        ? req.query.returnTo
        : '/dashboard';
      req.session.save((saveError) => {
        if (saveError) return next(saveError);
        res.redirect(returnTo);
      });
    });
  } catch (error) {
    next(error);
  }
});

app.post('/logout', async (req, res, next) => {
  try {
    await recordAccessEvent(db, req, {
      eventType: 'auth_logout',
      resourceType: 'authentication',
    });
    req.session.destroy((error) => {
      if (error) return next(error);
      res.clearCookie('sigemed.sid');
      res.redirect('/login');
    });
  } catch (error) {
    next(error);
  }
});

app.use(requireAuthentication);
app.use((req, res, next) => {
  res.locals.currentUser = req.session.user;
  next();
});

app.get('/dashboard', (req, res) => {
  const roles = req.session.user.roles || [];
  const isSystemAdmin = roles.includes('system_admin');
  const modules = [
    {
      id: 'admissions',
      title: 'Admisión y Agenda',
      description: 'Gestión de citas, disponibilidad y flujo de pacientes.',
      href: '/agenda',
      roles: ['admissions', 'system_admin'],
    },
    {
      id: 'medical',
      title: 'Consulta Médica / SOAP y Recetas',
      description: 'Acceso al directorio de pacientes, evolución clínica y prescripciones.',
      href: '/pacientes',
      roles: ['doctor', 'nurse', 'system_admin'],
    },
    {
      id: 'billing',
      title: 'Facturación y Caja',
      description: 'Emisión de comprobantes y procesamiento de cobros.',
      href: '/billing',
      roles: ['admissions', 'system_admin'],
    },
    {
      id: 'reports',
      title: 'Reportes y Estadísticas',
      description: 'Indicadores agregados y exportaciones según permisos.',
      href: '/reports',
      roles: ['audit_security', 'system_admin'],
    },
    {
      id: 'administration',
      title: 'Gestión de Usuarios y Configuración',
      description: 'Administración de cuentas, roles, médicos y parámetros del sistema.',
      href: '/admin/users',
      roles: ['system_admin'],
    },
  ].filter((module) => isSystemAdmin || module.roles.some((role) => roles.includes(role)));

  res.render('dashboard', { modules });
});

app.use('/agenda', requireRole('system_admin', 'admissions', 'audit_security', 'doctor', 'nurse'));
app.use('/appointments', requireRole('system_admin', 'admissions', 'audit_security'));
app.use('/api/doctor-availability', requireRole('system_admin', 'admissions', 'audit_security', 'doctor', 'nurse'));
app.use('/pacientes', requireRole('system_admin', 'admissions', 'audit_security', 'doctor', 'nurse'));
app.use('/api/patients', requireRole('system_admin', 'admissions', 'audit_security'));
app.use('/patients', (req, res, next) => {
  const isPatientAdministration = req.method === 'POST'
    && (/^\/create\/?$/.test(req.path) || /^\/update\/\d+\/?$/.test(req.path));
  return isPatientAdministration
    ? requireRole('system_admin', 'admissions', 'audit_security')(req, res, next)
    : requireRole('system_admin', 'doctor', 'nurse', 'audit_security')(req, res, next);
});

app.get('/admin/users', requireRole('system_admin', 'audit_security'), async (req, res) => {
  try {
    const isSystemAdmin = req.session.user.roles.includes('system_admin');
    const [rolesResult, doctorsResult, accountsResult] = await Promise.all([
      db.query(
        `SELECT role_key, name
         FROM roles
         WHERE active = TRUE
           AND ($1::boolean OR role_key = ANY($2::text[]))
         ORDER BY name`,
        [isSystemAdmin, ['doctor', 'admissions', 'nurse', 'patient']]
      ),
      db.query(`
        SELECT d.id, d.name, d.main_specialty
        FROM doctors d
        LEFT JOIN doctor_user_accounts dua ON dua.doctor_id = d.id
        WHERE dua.doctor_id IS NULL
        ORDER BY d.name
      `),
      db.query(`
        SELECT u.id, u.name, u.email, u.active,
               string_agg(r.name, ', ' ORDER BY r.name) AS roles
        FROM users u
        LEFT JOIN user_roles ur ON ur.user_id = u.id
        LEFT JOIN roles r ON r.id = ur.role_id
        GROUP BY u.id
        ORDER BY u.name
      `),
    ]);
    res.render('admin_users', {
      roles: rolesResult.rows,
      doctors: doctorsResult.rows,
      accounts: accountsResult.rows,
      message: req.query.created ? 'La cuenta fue creada correctamente.' : null,
      error: req.query.error ? 'No se pudo crear la cuenta. Verifica que el correo no esté registrado.' : null,
    });
  } catch (error) {
    console.error('Error al cargar administración de usuarios:', error.message);
    res.status(500).send('Error al cargar las cuentas de usuario.');
  }
});

app.post('/admin/users', requireRole('system_admin', 'audit_security'), async (req, res) => {
  const bcrypt = require('bcryptjs');
  const { name, role_key: roleKey, doctor_id: doctorId } = req.body;
  const fullName = typeof name === 'string' ? name.trim() : '';
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!fullName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12) {
    return res.status(400).send('Nombre, correo válido y contraseña de al menos 12 caracteres son obligatorios.');
  }
  if (typeof roleKey !== 'string' || !canAssignRole(req.session.user.roles, roleKey)) {
    return res.status(403).send('No tienes permisos para asignar ese perfil.');
  }
  if (doctorId && (!/^\d+$/.test(String(doctorId)) || roleKey !== 'doctor')) {
    return res.status(400).send('El vínculo médico requiere un identificador válido y el perfil médico.');
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const roleResult = await client.query(
      'SELECT id FROM roles WHERE role_key = $1 AND active = TRUE',
      [roleKey]
    );
    if (roleResult.rows.length === 0) throw new Error('Perfil no válido.');
    const passwordHash = await bcrypt.hash(password, 12);
    const userResult = await client.query(
      `INSERT INTO users (name, email, password_hash, role, active)
       VALUES ($1, $2, $3, $4, TRUE)
       RETURNING id`,
      [fullName, email, passwordHash, roleKey]
    );
    const userId = userResult.rows[0].id;
    await client.query(
      'INSERT INTO user_roles (user_id, role_id, assigned_by_user_id) VALUES ($1, $2, $3)',
      [userId, roleResult.rows[0].id, req.session.user.id]
    );
    if (doctorId) {
      await client.query(
        `INSERT INTO doctor_user_accounts (doctor_id, user_id, linked_by_user_id)
         VALUES ($1, $2, $3)`,
        [doctorId, userId, req.session.user.id]
      );
    }
    await client.query('COMMIT');
    res.redirect('/admin/users?created=1');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al crear cuenta de usuario:', error.message);
    res.redirect('/admin/users?error=1');
  } finally {
    client.release();
  }
});

// RUTA VISUAL: Directorio de Pacientes
app.get('/pacientes', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM patients ORDER BY created_at DESC');
    res.render('patients', { pacientes: rows });
  } catch (err) {
    console.error('Error al cargar la vista de pacientes:', err.message);
    res.status(500).send('Error al cargar la interfaz de pacientes');
  }
});

// ENDPOINT API: Registrar paciente (POST)
app.post('/api/patients', async (req, res) => {
  const { dni_document, first_name, last_name, birth_date, gender, phone, email } = req.body;
  try {
    const query = `INSERT INTO patients (dni_document, first_name, last_name, birth_date, gender, phone, email) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *;`;
    const values = [dni_document, first_name, last_name, birth_date, gender, phone, email];
    const result = await db.query(query, values);
    res.status(201).json(result.rows[0]); 
  } catch (err) {
    res.status(500).json({ error: 'Error guardando en base de datos', detalles: err.message });
  }
});

// ENDPOINT API: Obtener pacientes (GET)
app.get('/api/patients', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM patients ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al consultar la base de datos', detalles: err.message });
  }
});

app.post('/api/patients/search', async (req, res) => {
  const term = String(req.body.query || '').trim();
  if (term.length < 2 || term.length > 80) {
    return res.status(400).json({ error: 'Escribe al menos 2 caracteres para buscar.' });
  }
  try {
    const pattern = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
    const { rows } = await db.query(
      `SELECT id, first_name, last_name, dni_document, document_type, medical_record_number
       FROM patients
       WHERE first_name ILIKE $1 ESCAPE '\\'
          OR last_name ILIKE $1 ESCAPE '\\'
          OR dni_document ILIKE $1 ESCAPE '\\'
       ORDER BY last_name, first_name
       LIMIT 10`,
      [pattern]
    );
    res.json(rows);
  } catch (error) {
    console.error('Error al buscar pacientes para admisión:', error.message);
    res.status(500).json({ error: 'No se pudo completar la búsqueda.' });
  }
});

// RUTA POST: Guardar paciente web
app.post('/patients/create', async (req, res) => {
  const { dni_document, first_name, last_name, birth_date, gender, phone, email } = req.body;
  try {
    const query = `INSERT INTO patients (dni_document, first_name, last_name, birth_date, gender, phone, email) VALUES ($1, $2, $3, $4, $5, $6, $7);`;
    const values = [dni_document, first_name, last_name, birth_date, gender, phone, email || null];
    await db.query(query, values);
    res.redirect('/pacientes');
  } catch (err) {
    res.status(500).send('Error interno al guardar el paciente.');
  }
});

// RUTA POST: Actualizar paciente
app.post('/patients/update/:id', async (req, res) => {
  const { id } = req.params;
  const { dni_document, first_name, last_name, birth_date, gender, phone, email } = req.body;
  try {
    const query = `UPDATE patients SET dni_document = $1, first_name = $2, last_name = $3, birth_date = $4, gender = $5, phone = $6, email = $7 WHERE id = $8;`;
    const values = [dni_document, first_name, last_name, birth_date, gender, phone, email || null, id];
    await db.query(query, values);
    res.redirect('/pacientes');
  } catch (err) {
    res.status(500).send('Error interno al actualizar el paciente.');
  }
});

app.get('/api/cie10/search', requireRole('system_admin', 'doctor', 'nurse', 'audit_security'), async (req, res) => {
  const term = String(req.query.q || '').trim();
  if (term.length < 2 || term.length > 80) {
    return res.status(400).json({ error: 'Escribe al menos 2 caracteres para buscar un código CIE-10.' });
  }
  try {
    const pattern = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
    const { rows } = await db.query(
      `SELECT code, description
       FROM cie_catalog
       WHERE code ILIKE $1 ESCAPE '\\' OR description ILIKE $1 ESCAPE '\\'
       ORDER BY CASE WHEN code ILIKE $2 THEN 0 ELSE 1 END, code
       LIMIT 12`,
      [pattern, `${term}%`]
    );
    res.json(rows);
  } catch (error) {
    console.error('Error al buscar códigos CIE-10:', error.message);
    res.status(500).json({ error: 'No se pudo consultar el catálogo CIE-10.' });
  }
});

// ==========================================
// MÓDULO DE HISTORIA CLÍNICA Y SOAP ESCALADO
// ==========================================

app.get('/patients/:id/history', async (req, res) => {
  const patientId = req.params.id;
  try {
    const patientResult = await db.query('SELECT * FROM patients WHERE id = $1', [patientId]);
    if (patientResult.rows.length === 0) return res.status(404).send('Paciente no encontrado');
    const paciente = patientResult.rows[0];

    const queryHistorial = `
      SELECT 
        mc.id, mc.created_at AS consultation_date,
        ss.subjective_text AS subjective,
        ss.chief_complaint, ss.current_illness, ss.relevant_background,
        so.blood_pressure, so.heart_rate, so.temperature, so.weight, so.height, so.bmi, so.bmi_status,
        so.respiratory_rate, so.oxygen_saturation,
        COALESCE(so.physical_examination, so.objective_text) AS objective,
        so.lab_results_summary,
        sa.assessment_text AS assessment,
        c1.code AS primary_cie_code, c1.description AS primary_cie_description,
        c2.code AS secondary_cie_code, c2.description AS secondary_cie_description,
        c3.code AS tertiary_cie_code, c3.description AS tertiary_cie_description,
        sp.plan_text AS plan, sp.diagnostic_plan, sp.therapeutic_plan,
        sp.education_recommendations, sp.follow_up_date
      FROM medical_consultations mc
      LEFT JOIN soap_subjective ss ON mc.id = ss.medical_consultations_id
      LEFT JOIN soap_objective so ON mc.id = so.medical_consultations_id
      LEFT JOIN soap_assessment sa ON mc.id = sa.medical_consultations_id
      LEFT JOIN soap_plan sp ON mc.id = sp.medical_consultations_id
      LEFT JOIN cie_catalog c1 ON c1.id = sa.primary_cie_id
      LEFT JOIN cie_catalog c2 ON c2.id = sa.secondary_cie_1_id
      LEFT JOIN cie_catalog c3 ON c3.id = sa.secondary_cie_2_id
      WHERE mc.patient_id = $1
      ORDER BY mc.created_at DESC
    `;
    const notesResult = await db.query(queryHistorial, [patientId]);
    const studyCatalogResult = await db.query(
      'SELECT id, code, name, category FROM study_catalog WHERE active = TRUE ORDER BY category, name'
    );
    const medicationCatalogResult = await db.query(
      `SELECT id, code, name, active_ingredient, strength, dosage_form, route
       FROM medications WHERE active = TRUE ORDER BY name, strength NULLS LAST`
    );

    const notas = notesResult.rows.map(row => {
      let legacyCode = '';
      let legacyDescription = '';
      if (row.assessment && row.assessment.includes('| Ref. CIE-10:')) {
        const parts = row.assessment.split('| Ref. CIE-10:');
        row.assessment = parts[0].trim();
        const cieParts = parts[1].split('-');
        legacyCode = cieParts[0] ? cieParts[0].trim() : '';
        legacyDescription = cieParts[1] ? cieParts.slice(1).join('-').trim() : '';
      }
      const diagnoses = [
        { type: 'Principal', code: row.primary_cie_code || (legacyCode === 'S/D' ? '' : legacyCode), description: row.primary_cie_description || legacyDescription },
        { type: 'Secundario', code: row.secondary_cie_code, description: row.secondary_cie_description },
        { type: 'Tercero', code: row.tertiary_cie_code, description: row.tertiary_cie_description },
      ].filter(diagnosis => diagnosis.code);
      return {
        ...row,
        diagnoses,
        cie10_code: diagnoses[0]?.code || 'N/A',
        cie10_description: diagnoses[0]?.description || '',
        studyOrders: [],
        prescriptions: [],
      };
    });

    if (notas.length) {
      const studyOrdersResult = await db.query(
        `SELECT so.consultation_id, so.study_id, sc.code, sc.name, sc.category,
                so.priority, so.status, so.ordered_at, so.instructions
         FROM study_orders so
         JOIN study_catalog sc ON sc.id = so.study_id
         WHERE so.consultation_id = ANY($1::int[])
         ORDER BY so.ordered_at, so.id`,
        [notas.map(note => note.id)]
      );
      const ordersByConsultation = new Map();
      for (const order of studyOrdersResult.rows) {
        if (!ordersByConsultation.has(order.consultation_id)) {
          ordersByConsultation.set(order.consultation_id, []);
        }
        ordersByConsultation.get(order.consultation_id).push(order);
      }
      for (const note of notas) {
        note.studyOrders = ordersByConsultation.get(note.id) || [];
      }
      const prescriptionsResult = await db.query(
        `SELECT p.id, p.consultation_id, p.prescribed_by_user_id, p.status,
                p.instructions, p.signed_at, p.created_at, u.name AS prescribed_by_name,
                pi.id AS item_id, pi.medication_id, pi.medication_name, pi.strength,
                pi.dose, pi.route, pi.frequency, pi.duration, pi.quantity, pi.instructions AS item_instructions
         FROM prescriptions p
         JOIN users u ON u.id = p.prescribed_by_user_id
         LEFT JOIN prescription_items pi ON pi.prescription_id = p.id
         WHERE p.consultation_id = ANY($1::int[])
         ORDER BY p.created_at DESC, p.id DESC, pi.id`,
        [notas.map(note => note.id)]
      );
      const prescriptionsByConsultation = new Map();
      const prescriptionsById = new Map();
      for (const row of prescriptionsResult.rows) {
        let prescription = prescriptionsById.get(row.id);
        if (!prescription) {
          prescription = {
            id: row.id,
            consultation_id: row.consultation_id,
            prescribed_by_user_id: row.prescribed_by_user_id,
            prescribed_by_name: row.prescribed_by_name,
            status: row.status,
            instructions: row.instructions,
            signed_at: row.signed_at,
            created_at: row.created_at,
            items: [],
          };
          prescriptionsById.set(row.id, prescription);
          if (!prescriptionsByConsultation.has(row.consultation_id)) {
            prescriptionsByConsultation.set(row.consultation_id, []);
          }
          prescriptionsByConsultation.get(row.consultation_id).push(prescription);
        }
        if (row.item_id) {
          prescription.items.push({
            medication_name: row.medication_name,
            strength: row.strength,
            dose: row.dose,
            route: row.route,
            frequency: row.frequency,
            duration: row.duration,
            quantity: row.quantity,
            instructions: row.item_instructions,
          });
        }
      }
      for (const note of notas) {
        note.prescriptions = prescriptionsByConsultation.get(note.id) || [];
      }
    }

    await recordAccessEvent(db, req, {
      eventType: 'clinical_history_view',
      resourceType: 'patient_history',
      resourceId: patientId,
      patientId,
      details: { consultations: notas.length },
    });
    res.render('history', {
      paciente,
      notas,
      studyCatalog: studyCatalogResult.rows,
      medicationCatalog: medicationCatalogResult.rows,
    });
  } catch (err) {
    console.error('Error al cargar órdenes de estudios en la historia clínica:', err.message);
    res.status(500).send('Error interno al cargar la historia clínica.');
  }
});

app.post('/patients/:id/soap', requireRole('doctor'), async (req, res) => {
  const patientId = req.params.id;
  const {
    consultation_id,
    chief_complaint, current_illness, relevant_background, subjective,
    objective, assessment, plan, diagnostic_plan, therapeutic_plan,
    education_recommendations, follow_up_date, lab_results_summary,
    blood_pressure, heart_rate, temperature, weight, height,
    respiratory_rate, oxygen_saturation, cie10_code,
  } = req.body;
  let studyOrderInput;
  try {
    studyOrderInput = normalizeStudyOrderInput(req.body);
  } catch (error) {
    return res.status(400).send(error.message);
  }

  if (!/^\d+$/.test(patientId) || (consultation_id && !/^\d+$/.test(consultation_id))) {
    return res.status(400).send('Identificador de paciente o consulta no válido.');
  }
  let diagnosisCodes;
  try {
    diagnosisCodes = normalizeDiagnosisCodes(req.body);
  } catch (error) {
    return res.status(400).send(error.message);
  }
  if (follow_up_date) {
    try {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(follow_up_date)) throw new Error('invalid date');
      booking.getWeekday(follow_up_date);
    } catch {
      return res.status(400).send('La fecha de seguimiento no es válida.');
    }
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    let consultId = consultation_id;

    if (!consultId) {
      const consultRes = await client.query(
        'INSERT INTO medical_consultations (patient_id) VALUES ($1) RETURNING id',
        [patientId]
      );
      consultId = consultRes.rows[0].id;
    } else {
      const existingConsultation = await client.query(
        'SELECT id FROM medical_consultations WHERE id = $1 AND patient_id = $2 FOR UPDATE',
        [consultId, patientId]
      );
      if (existingConsultation.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).send('Consulta no encontrada para este paciente.');
      }
    }

    const subjectiveFields = [
      ['Motivo de consulta', chief_complaint],
      ['Enfermedad actual', current_illness],
      ['Antecedentes relevantes', relevant_background],
    ].filter(([, value]) => String(value || '').trim());
    const subjectiveText = subjectiveFields.length
      ? subjectiveFields.map(([label, value]) => `${label}: ${String(value).trim()}`).join('\n')
      : String(subjective || 'Sin registro');
    const normalizedChiefComplaint = String(chief_complaint || '').trim() || null;
    const normalizedCurrentIllness = String(current_illness || '').trim() || null;
    const normalizedRelevantBackground = String(relevant_background || '').trim() || null;
    await client.query(
      `INSERT INTO soap_subjective
       (medical_consultations_id, subjective_text, chief_complaint, current_illness, relevant_background)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (medical_consultations_id)
       DO UPDATE SET subjective_text = EXCLUDED.subjective_text,
         chief_complaint = EXCLUDED.chief_complaint,
         current_illness = EXCLUDED.current_illness,
         relevant_background = EXCLUDED.relevant_background,
         updated_at = CURRENT_TIMESTAMP`,
      [consultId, subjectiveText, normalizedChiefComplaint, normalizedCurrentIllness, normalizedRelevantBackground]
    );

    let bmi = null; let bmi_status = 'No evaluado';
    if (weight && height) {
      const w = parseFloat(weight); const h = parseFloat(height);
      if (h > 0) {
        bmi = (w / (h * h)).toFixed(2);
        if (bmi < 18.5) bmi_status = 'Bajo peso';
        else if (bmi >= 18.5 && bmi < 25) bmi_status = 'Normal';
        else if (bmi >= 25 && bmi < 30) bmi_status = 'Sobrepeso';
        else bmi_status = 'Obesidad';
      }
    }
    
    await client.query(
      `INSERT INTO soap_objective 
      (medical_consultations_id, blood_pressure, heart_rate, temperature, weight, height, bmi, bmi_status,
       objective_text, physical_examination, respiratory_rate, oxygen_saturation, lab_results_summary)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (medical_consultations_id) 
      DO UPDATE SET 
        blood_pressure = EXCLUDED.blood_pressure, heart_rate = EXCLUDED.heart_rate, 
        temperature = EXCLUDED.temperature, weight = EXCLUDED.weight, height = EXCLUDED.height, 
        bmi = EXCLUDED.bmi, bmi_status = EXCLUDED.bmi_status, objective_text = EXCLUDED.objective_text, 
        physical_examination = EXCLUDED.physical_examination,
        respiratory_rate = EXCLUDED.respiratory_rate, oxygen_saturation = EXCLUDED.oxygen_saturation,
        lab_results_summary = EXCLUDED.lab_results_summary,
        updated_at = CURRENT_TIMESTAMP`,
      [
        consultId, blood_pressure || null, heart_rate || null, temperature || null,
        weight || null, height || null, bmi, bmi_status, objective || '',
        objective || '', respiratory_rate || null, oxygen_saturation || null, lab_results_summary || null,
      ]
    );

    const diagnosisLookup = await client.query(
      'SELECT id, code, description FROM cie_catalog WHERE upper(code) = ANY($1::text[])',
      [diagnosisCodes.filter(Boolean)]
    );
    const diagnosisByCode = new Map(diagnosisLookup.rows.map(row => [row.code.toUpperCase(), row]));
    const unknownCodes = diagnosisCodes.filter(code => code && !diagnosisByCode.has(code));
    if (unknownCodes.length) {
      await client.query('ROLLBACK');
      return res.status(400).send(`Código(s) CIE-10 no encontrado(s): ${unknownCodes.join(', ')}.`);
    }
    if (studyOrderInput.studyIds.length) {
      const activeStudies = await client.query(
        'SELECT id FROM study_catalog WHERE id = ANY($1::int[]) AND active = TRUE FOR SHARE',
        [studyOrderInput.studyIds]
      );
      const activeStudyIds = new Set(activeStudies.rows.map(study => study.id));
      const unavailableStudyIds = studyOrderInput.studyIds.filter(id => !activeStudyIds.has(id));
      if (unavailableStudyIds.length) {
        await client.query('ROLLBACK');
        return res.status(400).send('Uno o más estudios seleccionados no existen o están inactivos. Actualiza el catálogo e inténtalo nuevamente.');
      }
      await client.query(
        `INSERT INTO study_orders
           (consultation_id, study_id, ordered_by_user_id, priority, status, instructions)
         SELECT $1, study.id, $3, $4, 'ordered', $5
         FROM study_catalog study
         WHERE study.id = ANY($2::int[]) AND study.active = TRUE
         ON CONFLICT (consultation_id, study_id)
           WHERE status IN ('ordered', 'scheduled', 'in_progress')
         DO NOTHING`,
        [
          consultId, studyOrderInput.studyIds, req.session.user.id,
          studyOrderInput.priority, studyOrderInput.instructions,
        ]
      );
    }
    const assessmentFull = String(assessment || 'Sin análisis');
    await client.query(
      `INSERT INTO soap_assessment
       (medical_consultations_id, assessment_text, primary_cie_id, secondary_cie_1_id, secondary_cie_2_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (medical_consultations_id) 
       DO UPDATE SET assessment_text = EXCLUDED.assessment_text,
         primary_cie_id = EXCLUDED.primary_cie_id,
         secondary_cie_1_id = EXCLUDED.secondary_cie_1_id,
         secondary_cie_2_id = EXCLUDED.secondary_cie_2_id,
         updated_at = CURRENT_TIMESTAMP`,
      [
        consultId, assessmentFull,
        diagnosisCodes[0] ? diagnosisByCode.get(diagnosisCodes[0]).id : null,
        diagnosisCodes[1] ? diagnosisByCode.get(diagnosisCodes[1]).id : null,
        diagnosisCodes[2] ? diagnosisByCode.get(diagnosisCodes[2]).id : null,
      ]
    );

    await client.query(
      `INSERT INTO soap_plan
       (medical_consultations_id, plan_text, diagnostic_plan, therapeutic_plan, education_recommendations, follow_up_date)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (medical_consultations_id) 
       DO UPDATE SET plan_text = EXCLUDED.plan_text,
         diagnostic_plan = EXCLUDED.diagnostic_plan,
         therapeutic_plan = EXCLUDED.therapeutic_plan,
         education_recommendations = EXCLUDED.education_recommendations,
         follow_up_date = EXCLUDED.follow_up_date,
         updated_at = CURRENT_TIMESTAMP`,
      [
        consultId, plan || therapeutic_plan || 'Sin indicaciones',
        diagnostic_plan || null, therapeutic_plan || null,
        education_recommendations || null, follow_up_date || null,
      ]
    );

    await recordAccessEvent(client, req, {
      eventType: 'clinical_soap_saved',
      resourceType: 'consultation',
      resourceId: consultId,
      patientId,
      details: { study_order_count: studyOrderInput.studyIds.length },
    });
    await client.query('COMMIT');
    res.redirect(`/patients/${patientId}/history`);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error en UPSERT de notas SOAP:', err.message);
    res.status(500).send('Error interno al guardar o actualizar la evolución.');
  } finally {
    client.release();
  }
});

app.post('/patients/:patientId/consultations/:consultId/prescriptions', requireRole('doctor'), async (req, res) => {
  const { patientId, consultId } = req.params;
  if (!/^[1-9]\d*$/.test(patientId) || !/^[1-9]\d*$/.test(consultId)) {
    return res.status(400).send('Identificador de paciente o consulta no válido.');
  }

  let items;
  try {
    items = normalizePrescriptionItems(req.body);
  } catch (error) {
    return res.status(400).send(error.message);
  }
  const prescriptionInstructions = String(req.body.prescription_instructions || '').trim();
  if (prescriptionInstructions.length > 2000) {
    return res.status(400).send('Las indicaciones generales de la receta no pueden superar 2000 caracteres.');
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const consultation = await client.query(
      'SELECT id FROM medical_consultations WHERE id = $1 AND patient_id = $2 FOR UPDATE',
      [consultId, patientId]
    );
    if (!consultation.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).send('Consulta no encontrada para este paciente.');
    }

    const catalogIds = items.filter(item => item.medicationId).map(item => item.medicationId);
    const catalogRows = catalogIds.length
      ? await client.query(
        `SELECT id, name, strength, route
         FROM medications WHERE id = ANY($1::int[]) AND active = TRUE FOR SHARE`,
        [catalogIds]
      )
      : { rows: [] };
    const catalogById = new Map(catalogRows.rows.map(medication => [medication.id, medication]));
    if (catalogById.size !== catalogIds.length) {
      await client.query('ROLLBACK');
      return res.status(400).send('Uno o más medicamentos seleccionados no existen o están inactivos. Actualiza el catálogo e inténtalo nuevamente.');
    }

    const prescription = await client.query(
      `INSERT INTO prescriptions (consultation_id, prescribed_by_user_id, status, instructions)
       VALUES ($1, $2, 'draft', $3) RETURNING id`,
      [consultId, req.session.user.id, prescriptionInstructions || null]
    );
    for (const item of items) {
      const catalogMedication = item.medicationId ? catalogById.get(item.medicationId) : null;
      await client.query(
        `INSERT INTO prescription_items
           (prescription_id, medication_id, medication_name, strength, dose, route,
            frequency, duration, quantity, instructions)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          prescription.rows[0].id,
          item.medicationId,
          catalogMedication ? catalogMedication.name : item.medicationName,
          item.medicationId ? (catalogMedication.strength || item.strength) : item.strength,
          item.dose,
          item.medicationId ? (item.route || catalogMedication.route) : item.route,
          item.frequency,
          item.duration,
          item.quantity,
          item.instructions,
        ]
      );
    }
    await recordAccessEvent(client, req, {
      eventType: 'prescription_created',
      resourceType: 'prescription',
      resourceId: prescription.rows[0].id,
      patientId,
      details: { item_count: items.length },
    });
    await client.query('COMMIT');
    res.redirect(`/patients/${patientId}/history`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al crear el borrador de receta:', error.message);
    res.status(500).send('No se pudo guardar el borrador de receta.');
  } finally {
    client.release();
  }
});

app.post('/patients/:patientId/prescriptions/:prescriptionId/sign', requireRole('doctor'), async (req, res) => {
  const { patientId, prescriptionId } = req.params;
  if (!/^[1-9]\d*$/.test(patientId) || !/^[1-9]\d*$/.test(prescriptionId)) {
    return res.status(400).send('Identificador de paciente o receta no válido.');
  }
  if (req.body.confirm_prescription !== 'on') {
    return res.status(400).send('Confirma que revisaste y autorizas el contenido antes de activar la receta.');
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const prescription = await client.query(
      `SELECT p.id, p.status
       FROM prescriptions p
       JOIN medical_consultations mc ON mc.id = p.consultation_id
       WHERE p.id = $1 AND mc.patient_id = $2
         AND p.prescribed_by_user_id = $3
       FOR UPDATE OF p`,
      [prescriptionId, patientId, req.session.user.id]
    );
    if (!prescription.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).send('Borrador de receta no encontrado para este paciente y médico.');
    }
    if (prescription.rows[0].status !== 'draft') {
      await client.query('ROLLBACK');
      return res.status(409).send('Solo se pueden activar borradores; las recetas firmadas no se modifican desde este flujo.');
    }
    const items = await client.query(
      'SELECT 1 FROM prescription_items WHERE prescription_id = $1 LIMIT 1',
      [prescriptionId]
    );
    if (!items.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).send('No se puede activar una receta vacía.');
    }
    await client.query(
      `UPDATE prescriptions
       SET status = 'active', signed_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'draft'`,
      [prescriptionId]
    );
    await recordAccessEvent(client, req, {
      eventType: 'prescription_signed',
      resourceType: 'prescription',
      resourceId: prescriptionId,
      patientId,
    });
    await client.query('COMMIT');
    res.redirect(`/patients/${patientId}/history`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al activar receta:', error.message);
    res.status(500).send('No se pudo activar la receta.');
  } finally {
    client.release();
  }
});

app.post('/patients/:patientId/prescriptions/:prescriptionId/cancel', requireRole('doctor'), async (req, res) => {
  const { patientId, prescriptionId } = req.params;
  if (!/^[1-9]\d*$/.test(patientId) || !/^[1-9]\d*$/.test(prescriptionId)) {
    return res.status(400).send('Identificador de paciente o receta no válido.');
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE prescriptions p
       SET status = 'cancelled'
       FROM medical_consultations mc
       WHERE p.consultation_id = mc.id
         AND p.id = $1 AND mc.patient_id = $2
         AND p.prescribed_by_user_id = $3 AND p.status = 'draft'
       RETURNING p.id`,
      [prescriptionId, patientId, req.session.user.id]
    );
    if (!result.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).send('Solo puedes cancelar tus propios borradores no activados.');
    }
    await recordAccessEvent(client, req, {
      eventType: 'prescription_cancelled',
      resourceType: 'prescription',
      resourceId: result.rows[0].id,
      patientId,
    });
    await client.query('COMMIT');
    res.redirect(`/patients/${patientId}/history`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al cancelar borrador de receta:', error.message);
    res.status(500).send('No se pudo cancelar el borrador de receta.');
  } finally {
    client.release();
  }
});

app.get('/admin/medications', requireRole('system_admin'), async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, code, name, active_ingredient, strength, dosage_form, route, active
       FROM medications ORDER BY active DESC, name, strength NULLS LAST`
    );
    res.render('admin_medications', { medications: rows, error: req.query.error || null });
  } catch (error) {
    console.error('Error al cargar catálogo de medicamentos:', error.message);
    res.status(500).send('No se pudo cargar el catálogo de medicamentos.');
  }
});

app.post('/admin/medications', requireRole('system_admin'), async (req, res) => {
  let medication;
  try {
    medication = normalizeMedication(req.body);
  } catch (error) {
    return res.status(400).send(error.message);
  }
  try {
    await db.query(
      `INSERT INTO medications (code, name, active_ingredient, strength, dosage_form, route)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        medication.code, medication.name, medication.activeIngredient,
        medication.strength, medication.dosageForm, medication.route,
      ]
    );
    res.redirect('/admin/medications');
  } catch (error) {
    if (error.code === '23505') return res.redirect('/admin/medications?error=duplicate');
    console.error('Error al registrar medicamento en catálogo:', error.message);
    res.status(500).send('No se pudo guardar el medicamento.');
  }
});

app.post('/admin/medications/:id', requireRole('system_admin'), async (req, res) => {
  if (!/^[1-9]\d*$/.test(req.params.id)) return res.status(400).send('Identificador de medicamento no válido.');
  if (req.body.active !== 'true' && req.body.active !== 'false') {
    return res.status(400).send('El estado del medicamento no es válido.');
  }
  let medication;
  try {
    medication = normalizeMedication(req.body);
  } catch (error) {
    return res.status(400).send(error.message);
  }
  try {
    const result = await db.query(
      `UPDATE medications
       SET code = $1, name = $2, active_ingredient = $3, strength = $4,
           dosage_form = $5, route = $6, active = $7
       WHERE id = $8`,
      [
        medication.code, medication.name, medication.activeIngredient,
        medication.strength, medication.dosageForm, medication.route,
        req.body.active === 'true', req.params.id,
      ]
    );
    if (!result.rowCount) return res.status(404).send('Medicamento no encontrado.');
    res.redirect('/admin/medications');
  } catch (error) {
    if (error.code === '23505') return res.redirect('/admin/medications?error=duplicate');
    console.error('Error al actualizar medicamento en catálogo:', error.message);
    res.status(500).send('No se pudo actualizar el medicamento.');
  }
});

// ==========================================
// 2. MÓDULO: PRESCRIPCIÓN MÉDICA (PDF)
// ==========================================

app.get('/patients/:patientId/prescriptions/:prescriptionId/pdf', requireRole('doctor', 'system_admin', 'audit_security'), async (req, res) => {
  const { patientId, prescriptionId } = req.params;
  if (!/^[1-9]\d*$/.test(patientId) || !/^[1-9]\d*$/.test(prescriptionId)) {
    return res.status(400).send('Identificador de paciente o receta no válido.');
  }
  try {
    const prescriptionResult = await db.query(
      `SELECT p.id, p.status, p.instructions, p.signed_at, u.name AS prescriber_name,
              mc.created_at AS consultation_date, pt.first_name, pt.last_name,
              pt.dni_document
       FROM prescriptions p
       JOIN medical_consultations mc ON mc.id = p.consultation_id
       JOIN patients pt ON pt.id = mc.patient_id
       JOIN users u ON u.id = p.prescribed_by_user_id
       WHERE p.id = $1 AND pt.id = $2 AND p.status = 'active' AND p.signed_at IS NOT NULL`,
      [prescriptionId, patientId]
    );
    if (!prescriptionResult.rows.length) {
      return res.status(404).send('No se encontró una receta activa para este paciente.');
    }
    await recordAccessEvent(db, req, {
      eventType: 'clinical_prescription_pdf_view',
      resourceType: 'prescription',
      resourceId: prescriptionId,
      patientId,
    });
    const itemResult = await db.query(
      `SELECT medication_name, strength, dose, route, frequency, duration,
              quantity, instructions
       FROM prescription_items WHERE prescription_id = $1 ORDER BY id`,
      [prescriptionId]
    );
    const data = prescriptionResult.rows[0];
    const doc = new PDFDocument({ margin: 50 });
    res.setHeader('Content-disposition', `inline; filename="Receta_${data.dni_document}_${prescriptionId}.pdf"`);
    res.setHeader('Content-type', 'application/pdf');
    doc.pipe(res);
    doc.rect(0, 0, doc.page.width, 85).fill('#004b87');
    doc.fillColor('#FFFFFF').fontSize(22).font('Helvetica-Bold').text('SIGEMED C.A.', 50, 25, { align: 'center' });
    doc.fontSize(11).font('Helvetica').text('Receta médica', { align: 'center' });
    doc.moveDown(3);
    doc.fillColor('#333333').fontSize(12).font('Helvetica-Bold').text('DATOS DEL PACIENTE');
    doc.moveDown(0.5).font('Helvetica').fontSize(10).fillColor('#000000');
    doc.text(`Nombre: ${data.first_name} ${data.last_name}`);
    doc.text(`Documento: ${data.dni_document || 'No registrado'}`);
    doc.text(`Consulta: ${new Date(data.consultation_date).toLocaleString('es-VE')}`);
    doc.moveDown().font('Helvetica-Bold').fontSize(12).text('MEDICAMENTOS');
    doc.moveDown(0.5).font('Helvetica').fontSize(10);
    itemResult.rows.forEach((item, index) => {
      doc.font('Helvetica-Bold').text(`${index + 1}. ${item.medication_name}${item.strength ? ` — ${item.strength}` : ''}`);
      doc.font('Helvetica').text(`Dosis: ${item.dose}`);
      if (item.route) doc.text(`Vía: ${item.route}`);
      doc.text(`Frecuencia: ${item.frequency}`);
      if (item.duration) doc.text(`Duración: ${item.duration}`);
      if (item.quantity) doc.text(`Cantidad: ${item.quantity}`);
      if (item.instructions) doc.text(`Indicaciones: ${item.instructions}`);
      doc.moveDown(0.75);
    });
    if (data.instructions) doc.text(`Indicaciones generales: ${data.instructions}`, { align: 'justify' });
    doc.moveDown(2);
    doc.font('Helvetica-Bold').text(`Médico: ${data.prescriber_name}`);
    doc.font('Helvetica').text(`Confirmada el: ${new Date(data.signed_at).toLocaleString('es-VE')}`);
    doc.moveDown(0.5).fontSize(8).text('Registro de confirmación del médico en SIGEMED. Este documento no declara contar con firma digital certificada.', { align: 'justify' });
    doc.end();
  } catch (error) {
    console.error('Error al generar PDF de receta:', error.message);
    res.status(500).send('No se pudo generar el PDF de la receta.');
  }
});

app.get('/patients/:patientId/prescription/:consultId', async (req, res) => {
  const { patientId, consultId } = req.params;
  if (!/^[1-9]\d*$/.test(patientId) || !/^[1-9]\d*$/.test(consultId)) {
    return res.status(400).send('Identificador de paciente o consulta no válido.');
  }
  try {
    const result = await db.query(
      `SELECT p.id
       FROM prescriptions p
       JOIN medical_consultations mc ON mc.id = p.consultation_id
       WHERE mc.id = $1 AND mc.patient_id = $2
         AND p.status = 'active' AND p.signed_at IS NOT NULL
       ORDER BY p.signed_at DESC, p.id DESC LIMIT 1`,
      [consultId, patientId]
    );
    if (!result.rows.length) {
      return res.status(404).send('No existe una receta activa confirmada para esta consulta.');
    }
    res.redirect(`/patients/${patientId}/prescriptions/${result.rows[0].id}/pdf`);
  } catch (error) {
    console.error('Error al buscar receta activa:', error.message);
    res.status(500).send('No se pudo consultar la receta de esta consulta.');
  }
});

// ==========================================
// 3. NUEVO MÓDULO: REPORTE COMPLETO DE HISTORIA MÉDICA (SOAP PDF)
// ==========================================

app.get('/patients/:patientId/full-history/:consultId', async (req, res) => {
  const { patientId, consultId } = req.params;

  try {
    const query = `
      SELECT p.first_name, p.last_name, p.dni_document, p.gender, p.phone,
             mc.created_at,
             ss.subjective_text, ss.chief_complaint, ss.current_illness, ss.relevant_background,
             so.blood_pressure, so.heart_rate, so.temperature, so.weight, so.height, so.bmi, so.bmi_status,
             so.respiratory_rate, so.oxygen_saturation,
             COALESCE(so.physical_examination, so.objective_text) AS physical_examination,
             so.lab_results_summary,
             sa.assessment_text,
             c1.code AS primary_cie_code, c1.description AS primary_cie_description,
             c2.code AS secondary_cie_code, c2.description AS secondary_cie_description,
             c3.code AS tertiary_cie_code, c3.description AS tertiary_cie_description,
             sp.plan_text, sp.diagnostic_plan, sp.therapeutic_plan,
             sp.education_recommendations, sp.follow_up_date
      FROM medical_consultations mc
      JOIN patients p ON mc.patient_id = p.id
      LEFT JOIN soap_subjective ss ON mc.id = ss.medical_consultations_id
      LEFT JOIN soap_objective so ON mc.id = so.medical_consultations_id
      LEFT JOIN soap_assessment sa ON mc.id = sa.medical_consultations_id
      LEFT JOIN soap_plan sp ON mc.id = sp.medical_consultations_id
      LEFT JOIN cie_catalog c1 ON c1.id = sa.primary_cie_id
      LEFT JOIN cie_catalog c2 ON c2.id = sa.secondary_cie_1_id
      LEFT JOIN cie_catalog c3 ON c3.id = sa.secondary_cie_2_id
      WHERE mc.id = $1 AND mc.patient_id = $2
    `;
    const { rows } = await db.query(query, [consultId, patientId]);

    if (rows.length === 0) {
      return res.status(404).send('Consulta no encontrada.');
    }
    await recordAccessEvent(db, req, {
      eventType: 'clinical_history_pdf_view',
      resourceType: 'consultation',
      resourceId: consultId,
      patientId,
    });

    const data = rows[0];
    const { rows: studyOrders } = await db.query(
      `SELECT sc.name, sc.category, so.priority, so.status, so.instructions
       FROM study_orders so
       JOIN study_catalog sc ON sc.id = so.study_id
       WHERE so.consultation_id = $1
       ORDER BY so.ordered_at, so.id`,
      [consultId]
    );
    const doc = new PDFDocument({ margin: 50 });

    res.setHeader('Content-disposition', `inline; filename="Historia_${data.dni_document}_${consultId}.pdf"`);
    res.setHeader('Content-type', 'application/pdf');
    doc.pipe(res);

    doc.rect(0, 0, doc.page.width, 85).fill('#004b87'); 
    doc.fillColor('#FFFFFF').fontSize(22).font('Helvetica-Bold').text('SIGEMED C.A.', 50, 25, { align: 'center' });
    doc.fontSize(11).font('Helvetica').text('Unidad Médica - Sucursal Valencia', { align: 'center' });
    
    doc.moveDown(3);
    doc.fillColor('#004b87').fontSize(16).font('Helvetica-Bold').text('HISTORIA MÉDICA CLÍNICA', { align: 'center' });
    doc.moveDown(1.5);

    doc.fillColor('#333333').fontSize(12).font('Helvetica-Bold').text('1. DATOS DEL PACIENTE');
    doc.moveTo(50, doc.y).lineTo(550, doc.y).strokeColor('#cccccc').stroke();
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(10).fillColor('#000000');
    doc.text(`Nombre: ${data.first_name} ${data.last_name}    |    DNI: ${data.dni_document}`);
    doc.text(`Género: ${data.gender || 'N/D'}    |    Teléfono: ${data.phone || 'N/A'}`);
    doc.text(`Fecha de Consulta: ${new Date(data.created_at).toLocaleString('es-ES')}`);
    
    doc.moveDown(1.5);
    doc.fillColor('#333333').fontSize(12).font('Helvetica-Bold').text('2. (S) SUBJETIVO - MOTIVO DE CONSULTA');
    doc.moveTo(50, doc.y).lineTo(550, doc.y).strokeColor('#cccccc').stroke();
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(10).fillColor('#000000');
    doc.text(`Motivo de consulta: ${data.chief_complaint || data.subjective_text || 'Sin registro'}`, { align: 'justify' });
    if (data.current_illness) doc.text(`Enfermedad actual: ${data.current_illness}`, { align: 'justify' });
    if (data.relevant_background) doc.text(`Antecedentes relevantes: ${data.relevant_background}`, { align: 'justify' });

    doc.moveDown(1.5);
    doc.fillColor('#333333').fontSize(12).font('Helvetica-Bold').text('3. (O) OBJETIVO - EXAMEN FÍSICO Y SIGNOS VITALES');
    doc.moveTo(50, doc.y).lineTo(550, doc.y).strokeColor('#cccccc').stroke();
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(10).fillColor('#000000');
    doc.text(`PA: ${data.blood_pressure || '-'} | FC: ${data.heart_rate || '-'} lpm | FR: ${data.respiratory_rate || '-'} rpm | SpO₂: ${data.oxygen_saturation || '-'}% | Temp: ${data.temperature || '-'} °C | Peso: ${data.weight || '-'} kg | Talla: ${data.height || '-'} m | IMC: ${data.bmi || '-'} (${data.bmi_status || '-'})`);
    doc.moveDown(0.5);
    doc.text(data.physical_examination || 'Sin hallazgos descritos', { align: 'justify' });
    if (data.lab_results_summary) doc.text(`Resumen paraclínico disponible: ${data.lab_results_summary}`, { align: 'justify' });

    doc.moveDown(1.5);
    doc.fillColor('#333333').fontSize(12).font('Helvetica-Bold').text('4. (A) ANÁLISIS - IMPRESIÓN DIAGNÓSTICA');
    doc.moveTo(50, doc.y).lineTo(550, doc.y).strokeColor('#cccccc').stroke();
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(10).fillColor('#000000');
    doc.text(data.assessment_text || 'Sin registro', { align: 'justify' });
    [
      ['Principal', data.primary_cie_code, data.primary_cie_description],
      ['Secundario', data.secondary_cie_code, data.secondary_cie_description],
      ['Tercero', data.tertiary_cie_code, data.tertiary_cie_description],
    ].filter(([, code]) => code).forEach(([type, code, description]) => {
      doc.text(`Diagnóstico ${type}: ${code} — ${description || ''}`);
    });

    doc.moveDown(1.5);
    doc.fillColor('#333333').fontSize(12).font('Helvetica-Bold').text('5. (P) PLAN - TRATAMIENTO E INDICACIONES');
    doc.moveTo(50, doc.y).lineTo(550, doc.y).strokeColor('#cccccc').stroke();
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(10).fillColor('#000000');
    if (data.diagnostic_plan) doc.text(`Exámenes y paraclínicos: ${data.diagnostic_plan}`, { align: 'justify' });
    if (studyOrders.length) {
      doc.text('Órdenes estructuradas de estudios:');
      studyOrders.forEach((order) => {
        const priority = { routine: 'Rutina', urgent: 'Urgente', stat: 'Inmediata (STAT)' }[order.priority] || order.priority;
        const status = { ordered: 'Solicitada', scheduled: 'Programada', in_progress: 'En proceso', completed: 'Completada', cancelled: 'Cancelada' }[order.status] || order.status;
        doc.list([`${order.name} (${order.category}) - ${priority} - ${status}${order.instructions ? ` - ${order.instructions}` : ''}`]);
      });
    }
    doc.text(`Tratamiento e indicaciones: ${data.therapeutic_plan || data.plan_text || 'Sin registro'}`, { align: 'justify' });
    if (data.education_recommendations) doc.text(`Educación al paciente: ${data.education_recommendations}`, { align: 'justify' });
    if (data.follow_up_date) doc.text(`Seguimiento sugerido: ${new Date(data.follow_up_date).toLocaleDateString('es-VE', { timeZone: 'UTC' })}`);

    doc.moveDown(5);
    doc.moveTo(175, doc.y).lineTo(425, doc.y).strokeColor('#000000').stroke();
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(10).text('Firma del Médico Tratante', { align: 'center' });

    doc.end();

  } catch (err) {
    console.error('Error al generar Historia Médica PDF:', err.message);
    res.status(500).send('Error interno al compilar la historia médica en PDF.');
  }
});

// ==========================================
// 4. MÓDULO: AGENDA Y SALA DE ESPERA
// ==========================================

function isDoctorCalendarScoped(roles) {
  const broadAccessRoles = ['system_admin', 'admissions', 'audit_security'];
  return roles.includes('doctor') && !roles.some((role) => broadAccessRoles.includes(role));
}

// RUTA GET: Renderizar la Sala de Espera y el Formulario de Citas
app.get('/agenda', async (req, res) => {
  const requestedQueueDate = req.query.date ? String(req.query.date) : null;
  if (requestedQueueDate) {
    try {
      booking.getWeekday(requestedQueueDate);
    } catch {
      return res.status(400).send('La fecha de agenda no es válida.');
    }
  }

  try {
    const roles = req.session.user.roles || [];
    const doctorScoped = isDoctorCalendarScoped(roles);
    const doctorProfileResult = doctorScoped
      ? await db.query('SELECT doctor_id FROM doctor_user_accounts WHERE user_id = $1', [req.session.user.id])
      : null;
    if (doctorScoped && !doctorProfileResult.rows.length) {
      return res.status(403).send('Tu cuenta médica no tiene un perfil profesional vinculado.');
    }
    const doctorProfileId = doctorScoped ? doctorProfileResult.rows[0].doctor_id : null;
    const queryCitas = `
      SELECT a.id, a.appointment_date, a.status, a.reason_for_visit, a.time_scheduled,
             a.duration_minutes, a.care_mode,
             p.first_name, p.last_name, p.dni_document, u.name AS doctor_name
      FROM appointments a
      JOIN patients p ON a.patient_id = p.id
      LEFT JOIN users u ON a.doctor_id = u.id
      WHERE a.appointment_date >= (COALESCE($1::date, CURRENT_DATE) - INTERVAL '3 days')::date
        AND a.appointment_date < (COALESCE($1::date, CURRENT_DATE) + INTERVAL '31 days')::date
        AND ($2::integer IS NULL OR a.doctor_id = $2)
      ORDER BY a.appointment_date ASC, a.time_scheduled ASC
    `;
    const { rows: citas } = await db.query(queryCitas, [
      requestedQueueDate,
      doctorScoped ? req.session.user.id : null,
    ]);

    const doctorQuery = `
       SELECT d.id, d.name, d.main_specialty
       FROM doctors d
       JOIN doctor_user_accounts dua ON dua.doctor_id = d.id
       WHERE d.is_annulled IS DISTINCT FROM TRUE
         AND ($1::integer IS NULL OR d.id = $1)
       ORDER BY d.name ASC`;
    const { rows: doctores } = await db.query(doctorQuery, [doctorProfileId]);
    const { rows: sucursales } = await db.query('SELECT id, name FROM branches ORDER BY name ASC');

    res.render('agenda', {
      citas,
      doctores,
      sucursales,
      calendarDoctorId: doctorProfileId,
      calendarQueueDate: requestedQueueDate,
    });
  } catch (err) {
    console.error('Error al cargar la agenda:', err.message);
    res.status(500).send('Error al cargar la Sala de Espera.');
  }
});

// ENDPOINT API: Entrega los eventos del calendario dentro de un rango acotado.
app.get('/api/calendar/appointments', requireRole('system_admin', 'admissions', 'audit_security', 'doctor', 'nurse'), async (req, res) => {
  const { start, end } = req.query;
  const roles = req.session.user.roles || [];
  const doctorScoped = isDoctorCalendarScoped(roles);
  const requestedDoctorId = req.query.doctor_id ? String(req.query.doctor_id) : '';
  const branchId = req.query.branch_id ? String(req.query.branch_id) : '';

  if ((requestedDoctorId && !/^[1-9]\d*$/.test(requestedDoctorId))
      || (branchId && !/^[1-9]\d*$/.test(branchId))) {
    return res.status(400).json({ error: 'El filtro de médico o sede no es válido.' });
  }

  let dateRange;
  try {
    dateRange = booking.normalizeCalendarRange(start, end);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  try {
    let effectiveDoctorId = requestedDoctorId || null;
    if (doctorScoped) {
      const profileResult = await db.query(
        'SELECT doctor_id FROM doctor_user_accounts WHERE user_id = $1',
        [req.session.user.id]
      );
      if (!profileResult.rows.length) {
        return res.status(403).json({ error: 'Tu cuenta médica no tiene un perfil profesional vinculado.' });
      }
      const ownDoctorId = Number(profileResult.rows[0].doctor_id);
      if (effectiveDoctorId && Number(effectiveDoctorId) !== ownDoctorId) {
        return res.status(403).json({ error: 'Solo puedes consultar tu propio calendario médico.' });
      }
      effectiveDoctorId = String(ownDoctorId);
    }

    const { rows } = await db.query(
      `SELECT a.id, a.appointment_date::text AS appointment_date,
              to_char(a.time_scheduled, 'HH24:MI') AS appointment_time,
              a.duration_minutes, a.status, a.reason_for_visit,
              p.first_name, p.last_name, p.dni_document, p.document_type,
              d.name AS doctor_name, b.name AS branch_name
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       JOIN users u ON u.id = a.doctor_id
       LEFT JOIN doctor_user_accounts dua ON dua.user_id = u.id
       LEFT JOIN doctors d ON d.id = dua.doctor_id
       JOIN branches b ON b.id = a.branch_id
       WHERE a.appointment_date >= $1::date
         AND a.appointment_date < $2::date
         AND ($3::integer IS NULL OR dua.doctor_id = $3)
         AND ($4::integer IS NULL OR a.branch_id = $4)
       ORDER BY a.appointment_date, a.time_scheduled`,
      [
        dateRange.startDate,
        dateRange.endDate,
        effectiveDoctorId ? Number(effectiveDoctorId) : null,
        branchId ? Number(branchId) : null,
      ]
    );

    res.json(mapAppointmentsToCalendarEvents(rows));
  } catch (error) {
    console.error('Error al consultar las citas del calendario:', error.message);
    res.status(500).json({ error: 'No se pudo cargar el calendario de citas.' });
  }
});

// ENDPOINT API: Consultar disponibilidad horaria del médico por sede y fecha
app.get('/api/doctor-availability', async (req, res) => {
  const { doctor_id, branch_id, date, patient_id, appointment_type } = req.query;

  try {
    if (!/^\d+$/.test(String(doctor_id || ''))
        || !/^\d+$/.test(String(branch_id || ''))
        || !date || !['consultation', 'follow_up', 'minor_procedure'].includes(appointment_type)
        || (patient_id && !/^\d+$/.test(String(patient_id)))) {
      return res.status(400).json({ error: 'Faltan parámetros requeridos.' });
    }
    const dayOfWeek = booking.getWeekday(date);

    const query = `
      SELECT ds.*, dua.user_id,
             COALESCE(dat.duration_minutes, d.default_appointment_duration_minutes) AS duration_minutes
      FROM doctor_schedules ds
      JOIN doctor_user_accounts dua ON dua.doctor_id = ds.doctor_id
      JOIN doctors d ON d.id = ds.doctor_id
      LEFT JOIN doctor_appointment_types dat
        ON dat.doctor_id = ds.doctor_id AND dat.appointment_type = $4
      WHERE ds.doctor_id = $1 AND ds.branch_id = $2 AND ds.day_of_week = $3
    `;
    const { rows } = await db.query(query, [doctor_id, branch_id, dayOfWeek, appointment_type]);

    if (rows.length === 0) {
      return res.json({ available: false, slots: [], message: 'El médico no está vinculado a una cuenta o no labora en esta sucursal ese día.' });
    }

    const schedule = rows[0];
    const duration = Number(schedule.duration_minutes);
    const occupiedResult = await db.query(
      `SELECT time_scheduled::time AS start, duration_minutes AS duration
       FROM appointments
       WHERE appointment_date = $1
         AND status <> 'Cancelled'
         AND (doctor_id = $2 OR ($3::integer IS NOT NULL AND patient_id = $3))`,
      [date, schedule.user_id, patient_id ? Number(patient_id) : null]
    );
    const slots = booking.generateAvailableSlots([
      schedule.morning_enabled ? { start: schedule.morning_start_time, end: schedule.morning_end_time } : null,
      schedule.afternoon_enabled ? { start: schedule.afternoon_start_time, end: schedule.afternoon_end_time } : null,
    ], duration, occupiedResult.rows);

    res.json({
      available: true,
      duration_minutes: duration,
      slots,
    });

  } catch (err) {
    console.error('Error al consultar disponibilidad:', err.message);
    res.status(500).json({ error: 'No se pudo verificar disponibilidad.' });
  }
});

// ENDPOINT POST: Actualizar estado de la cita y capturar métricas de tiempo
app.post('/appointments/:id/status', async (req, res) => {
  const appointmentId = req.params.id;
  const { status } = req.body;
  const allowedStatuses = ['Waiting Room', 'In Consultation', 'Attended', 'Cancelled'];
  if (!/^\d+$/.test(appointmentId) || !allowedStatuses.includes(status)) {
    return res.status(400).send('Identificador o estado de cita no válido.');
  }
  let timeColumnUpdate = '';
  if (status === 'Waiting Room') {
    timeColumnUpdate = ', time_arrival = CURRENT_TIMESTAMP';
  } else if (status === 'In Consultation') {
    timeColumnUpdate = ', time_called_to_consultation = CURRENT_TIMESTAMP';
  } else if (status === 'Attended') {
    timeColumnUpdate = ', time_attended = CURRENT_TIMESTAMP';
  }

  try {
    const query = `UPDATE appointments SET status = $1${timeColumnUpdate} WHERE id = $2`;
    await db.query(query, [status, appointmentId]);
    res.redirect('/agenda');
  } catch (err) {
    console.error('Error al actualizar estado de la cita:', err.message);
    res.status(500).send('Error interno al actualizar la cita.');
  }
});

// ENDPOINT POST: Crear una cita y, si es necesario, registrar al paciente en la misma transacción.
app.post('/appointments/create', async (req, res) => {
  const {
    patient_id: patientIdInput, doctor_id: doctorIdInput, branch_id: branchIdInput,
    appointment_date: appointmentDate, appointment_time: appointmentTime,
    appointment_type: appointmentType, care_mode: careMode, telehealth_url: telehealthUrl,
    reason_for_visit: reasonForVisit,
  } = req.body;
  const newPatient = patientIdInput === 'new';
  const allowedTypes = ['consultation', 'follow_up', 'minor_procedure'];
  if (!/^\d+$/.test(String(doctorIdInput || ''))
      || !/^\d+$/.test(String(branchIdInput || ''))
      || !allowedTypes.includes(appointmentType)
      || !['in_person', 'teleconsultation'].includes(careMode)) {
    return res.status(400).send('Médico, sucursal, tipo de atención o modalidad no válidos.');
  }
  if (careMode === 'teleconsultation') {
    try {
      const parsedUrl = new URL(telehealthUrl);
      if (parsedUrl.protocol !== 'https:') throw new Error('invalid url');
    } catch {
      return res.status(400).send('Para teleconsulta se requiere un enlace HTTPS válido.');
    }
  }
  if (careMode === 'in_person' && telehealthUrl) {
    return res.status(400).send('No se debe asociar un enlace de teleconsulta a una cita presencial.');
  }
  if (!newPatient && !/^\d+$/.test(String(patientIdInput || ''))) {
    return res.status(400).send('Selecciona un paciente registrado o completa el alta rápida.');
  }
  if (newPatient) {
    const documentType = req.body.document_type;
    const documentNumber = String(req.body.dni_document || '').trim();
    const guardianName = String(req.body.guardian_name || '').trim();
    const guardianDocumentNumber = String(req.body.guardian_document_number || '').trim();
    const birthDate = String(req.body.birth_date || '');
    if (!String(req.body.first_name || '').trim() || !String(req.body.last_name || '').trim()
        || !['cedula', 'passport', 'none'].includes(documentType)
        || (documentType !== 'none' && !documentNumber)
        || (documentType === 'none' && (!guardianName || !guardianDocumentNumber
            || !['cedula', 'passport'].includes(req.body.guardian_document_type)
            || !String(req.body.guardian_relationship || '').trim()))) {
      return res.status(400).send('Completa los datos obligatorios del paciente y, si no tiene documento, los de su representante.');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) {
      return res.status(400).send('Indica una fecha de nacimiento válida.');
    }
    try {
      booking.getWeekday(birthDate);
    } catch {
      return res.status(400).send('La fecha de nacimiento no existe.');
    }
    const today = new Date().toISOString().slice(0, 10);
    if (birthDate > today) {
      return res.status(400).send('La fecha de nacimiento no puede estar en el futuro.');
    }
    if (documentType === 'none') {
      const eighteenthBirthday = new Date(`${birthDate}T00:00:00Z`);
      eighteenthBirthday.setUTCFullYear(eighteenthBirthday.getUTCFullYear() + 18);
      if (eighteenthBirthday.toISOString().slice(0, 10) <= today) {
        return res.status(400).send('El tipo “sin documento propio” solo se permite para menores de edad.');
      }
    }
  }
  const client = await db.connect();
  try {
    const dayOfWeek = booking.getWeekday(appointmentDate);
    const startMinute = booking.timeToMinutes(appointmentTime);
    const timeValue = `${String(Math.floor(startMinute / 60)).padStart(2, '0')}:${String(startMinute % 60).padStart(2, '0')}:00`;
    await client.query('BEGIN');

    let patientId = patientIdInput;
    if (newPatient) {
      const patientResult = await client.query(
        `INSERT INTO patients (
           document_type, dni_document, first_name, last_name, birth_date, gender, phone, email,
           guardian_name, guardian_document_type, guardian_document_number, guardian_relationship
         )
         VALUES ($1, $2, $3, $4, NULLIF($5, '')::date, NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''),
                 NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''), NULLIF($12, ''))
         RETURNING id`,
        [
          req.body.document_type,
          req.body.document_type === 'none' ? null : String(req.body.dni_document).trim(),
          String(req.body.first_name).trim(),
          String(req.body.last_name).trim(),
          String(req.body.birth_date || ''),
          String(req.body.gender || ''),
          String(req.body.phone || ''),
          String(req.body.email || ''),
          String(req.body.guardian_name || ''),
          String(req.body.guardian_document_type || ''),
          String(req.body.guardian_document_number || ''),
          String(req.body.guardian_relationship || ''),
        ]
      );
      patientId = patientResult.rows[0].id;
    }

    const doctorResult = await client.query(
      `SELECT dua.user_id, d.default_appointment_duration_minutes,
              COALESCE(dat.duration_minutes, d.default_appointment_duration_minutes) AS duration_minutes
       FROM doctors d
       JOIN doctor_user_accounts dua ON dua.doctor_id = d.id
       LEFT JOIN doctor_appointment_types dat
         ON dat.doctor_id = d.id AND dat.appointment_type = $2
       WHERE d.id = $1 AND d.is_annulled IS DISTINCT FROM TRUE`,
      [doctorIdInput, appointmentType]
    );
    if (doctorResult.rows.length === 0) throw new Error('El médico no tiene una cuenta de usuario vinculada.');
    const doctor = doctorResult.rows[0];
    const durationMinutes = Number(doctor.duration_minutes);
    const patientIdNumber = Number(patientId);

    await client.query("SELECT pg_advisory_xact_lock(hashtext('sigemed-appointment-doctor'), $1)", [Number(doctorIdInput)]);
    await client.query("SELECT pg_advisory_xact_lock(hashtext('sigemed-appointment-patient'), $1)", [patientIdNumber]);

    const scheduleResult = await client.query(
      `SELECT * FROM doctor_schedules
       WHERE doctor_id = $1 AND branch_id = $2 AND day_of_week = $3`,
      [doctorIdInput, branchIdInput, dayOfWeek]
    );
    if (scheduleResult.rows.length === 0) throw new Error('El médico no tiene horario configurado en esta sucursal para ese día.');
    const schedule = scheduleResult.rows[0];
    const startText = timeValue.slice(0, 5);
    const fitsShift = [
      schedule.morning_enabled && { start: schedule.morning_start_time, end: schedule.morning_end_time },
      schedule.afternoon_enabled && { start: schedule.afternoon_start_time, end: schedule.afternoon_end_time },
    ].some((shift) => {
      if (!shift) return false;
      return startMinute >= booking.timeToMinutes(String(shift.start).slice(0, 5))
        && startMinute + durationMinutes <= booking.timeToMinutes(String(shift.end).slice(0, 5));
    });
    if (!fitsShift) throw new Error('La hora seleccionada está fuera del horario o no admite la duración de esta atención.');

    const startAt = `${appointmentDate} ${timeValue}`;
    const conflicts = await client.query(
      `SELECT 1 FROM appointments
       WHERE appointment_date = $1 AND status <> 'Cancelled'
         AND (doctor_id = $2 OR patient_id = $3)
         AND time_scheduled < $4::timestamp + duration_minutes * INTERVAL '1 minute'
         AND time_scheduled + duration_minutes * INTERVAL '1 minute' > $4::timestamp
       LIMIT 1`,
      [appointmentDate, doctor.user_id, patientIdNumber, startAt]
    );
    if (conflicts.rows.length) throw new Error('El paciente o el médico ya tiene una cita en ese intervalo. Actualiza disponibilidad y selecciona otra hora.');

    await client.query(
      `INSERT INTO appointments (
         patient_id, doctor_id, branch_id, appointment_date, time_scheduled, status,
         reason_for_visit, duration_minutes, appointment_type, care_mode, telehealth_url
       )
       VALUES ($1, $2, $3, $4, $5, 'Scheduled', $6, $7, $8, $9, NULLIF($10, ''))`,
      [
        patientIdNumber, doctor.user_id, branchIdInput, appointmentDate, startAt,
        String(reasonForVisit || '').trim() || 'No especificado', durationMinutes,
        appointmentType, careMode, careMode === 'teleconsultation' ? telehealthUrl : '',
      ]
    );

    await client.query('COMMIT');
    if (req.accepts('json')) return res.status(201).json({ success: true });
    res.redirect('/agenda');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error al validar y registrar la cita:', err.message);
    const duplicatePatient = err.code === '23505';
    const clientError = duplicatePatient
      || err.message.includes('ya tiene una cita')
      || err.message.includes('horario configurado')
      || err.message.includes('fuera del horario')
      || err.message.includes('cuenta de usuario vinculada')
      || err.message.includes('La fecha')
      || err.message.includes('La hora')
      || err.message.includes('Indica una fecha')
      || err.message.includes('no puede estar en el futuro')
      || err.message.includes('solo se permite');
    const message = duplicatePatient
      ? 'Ya existe un paciente con ese documento. Búscalo y selecciónalo antes de agendar.'
      : clientError ? err.message : 'Error interno del servidor al procesar el agendamiento.';
    if (req.accepts('json')) return res.status(clientError ? 409 : 500).json({ error: message });
    res.status(clientError ? 409 : 500).send(message);
  } finally {
    client.release();
  }
});

// ==========================================
// 5. MÓDULO: GESTIÓN DE MÉDICOS Y HORARIOS
// ==========================================

app.get('/admin/doctors', requireRole('system_admin', 'admissions'), async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM doctors ORDER BY name ASC');
    res.render('doctors', { doctors: rows });
  } catch (err) {
    console.error('Error al cargar la lista de médicos:', err.message);
    res.status(500).send('Error interno al cargar el directorio de médicos.');
  }
});

app.get('/admin/doctors/:id/schedules', requireRole('system_admin', 'admissions'), async (req, res) => {
  const doctorId = req.params.id;

  try {
    const docResult = await db.query('SELECT * FROM doctors WHERE id = $1', [doctorId]);
    if (docResult.rows.length === 0) return res.status(404).send('Médico no encontrado');
    const doctor = docResult.rows[0];

    const branchesRes = await db.query('SELECT * FROM branches ORDER BY name ASC');
    const schedulesRes = await db.query(
      'SELECT * FROM doctor_schedules WHERE doctor_id = $1',
      [doctorId]
    );
    const appointmentTypesRes = await db.query(
      'SELECT appointment_type, duration_minutes FROM doctor_appointment_types WHERE doctor_id = $1 ORDER BY appointment_type',
      [doctorId]
    );

    res.render('doctor_schedule', { 
      doctor, 
      branches: branchesRes.rows, 
      schedules: schedulesRes.rows,
      appointmentTypes: appointmentTypesRes.rows,
    });
  } catch (err) {
    console.error('Error al cargar la vista de horarios:', err.message);
    res.status(500).send('Error interno al cargar la agenda del médico.');
  }
});

app.post('/admin/doctors/save', requireRole('system_admin', 'admissions'), async (req, res) => {
  const { 
    id, code, name, personal_type, main_specialty, office_room, title, 
    dni_document, college_number, msas_number, address, phone, email, 
    consultation_convenant_pct, surgery_convenant_pct,
    default_appointment_duration_minutes: durationInput,
  } = req.body;

  try {
    const duration = Number(durationInput);
    if (!Number.isInteger(duration) || duration < 5 || duration > 240) {
      return res.status(400).send('La duración predeterminada debe ser un número entre 5 y 240 minutos.');
    }
    if (id) {
      const queryUpdate = `
        UPDATE doctors SET 
          code = $1, name = $2, personal_type = $3, main_specialty = $4, 
          office_room = $5, title = $6, dni_document = $7, college_number = $8, 
          msas_number = $9, address = $10, phone = $11, email = $12, 
          consultation_convenant_pct = $13, surgery_convenant_pct = $14, 
          default_appointment_duration_minutes = $15, updated_at = CURRENT_TIMESTAMP
        WHERE id = $16
      `;
      await db.query(queryUpdate, [
        code, name, personal_type, main_specialty, office_room, title, 
        dni_document, college_number, msas_number, address, phone, email, 
        consultation_convenant_pct || 0, surgery_convenant_pct || 0, duration, id
      ]);
    } else {
      const queryInsert = `
        INSERT INTO doctors (
          code, name, personal_type, main_specialty, office_room, title, 
          dni_document, college_number, msas_number, address, phone, email, 
          consultation_convenant_pct, surgery_convenant_pct, default_appointment_duration_minutes
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      `;
      await db.query(queryInsert, [
        code, name, personal_type, main_specialty, office_room, title, 
        dni_document, college_number, msas_number, address, phone, email, 
        consultation_convenant_pct || 0, surgery_convenant_pct || 0, duration
      ]);
    }
    res.redirect('/admin/doctors');
  } catch (err) {
    console.error('Error al guardar el perfil del médico:', err.message);
    res.status(500).send('Error interno al procesar el perfil médico.');
  }
});

app.post('/admin/doctors/:doctorId/appointment-types', requireRole('system_admin', 'admissions'), async (req, res) => {
  const { doctorId } = req.params;
  if (!/^\d+$/.test(doctorId)) return res.status(400).send('Identificador de médico no válido.');
  const durations = req.body.durations || {};
  const allowedTypes = ['consultation', 'follow_up', 'minor_procedure'];
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const type of allowedTypes) {
      const rawValue = String(durations[type] || '').trim();
      if (!rawValue) {
        await client.query(
          'DELETE FROM doctor_appointment_types WHERE doctor_id = $1 AND appointment_type = $2',
          [doctorId, type]
        );
        continue;
      }
      const duration = Number(rawValue);
      if (!Number.isInteger(duration) || duration < 5 || duration > 240) {
        throw new Error('Cada duración debe ser un entero entre 5 y 240 minutos.');
      }
      await client.query(
        `INSERT INTO doctor_appointment_types (doctor_id, appointment_type, duration_minutes)
         VALUES ($1, $2, $3)
         ON CONFLICT (doctor_id, appointment_type)
         DO UPDATE SET duration_minutes = EXCLUDED.duration_minutes`,
        [doctorId, type, duration]
      );
    }
    await client.query('COMMIT');
    res.redirect(`/admin/doctors/${doctorId}/schedules`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al guardar duraciones por atención:', error.message);
    res.status(400).send('No se pudieron guardar las duraciones configuradas.');
  } finally {
    client.release();
  }
});

app.post('/admin/doctors/:doctorId/schedules', requireRole('system_admin', 'admissions'), async (req, res) => {
  const doctorId = req.params.doctorId;
  if (!isPositiveInteger(doctorId)) return res.status(400).send('Identificador de médico no válido.');
  let schedules;
  try {
    schedules = doctorSchedules.normalizeDoctorScheduleSlots(req.body.schedules);
  } catch (error) {
    return res.status(400).send(error.message);
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const doctorResult = await client.query('SELECT id FROM doctors WHERE id = $1', [doctorId]);
    if (!doctorResult.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).send('Médico no encontrado.');
    }
    const branchIds = [...new Set(schedules.map((slot) => slot.branchId))];
    const branchesResult = await client.query(
      'SELECT id FROM branches WHERE id = ANY($1::int[])',
      [branchIds]
    );
    if (branchesResult.rowCount !== branchIds.length) {
      await client.query('ROLLBACK');
      return res.status(400).send('Una o más sedes seleccionadas no existen.');
    }

    for (const slot of schedules) {
      const columnsByPeriod = {
        morning: {
          enabled: 'morning_enabled',
          start: 'morning_start_time',
          end: 'morning_end_time',
          limit: 'morning_limit',
        },
        afternoon: {
          enabled: 'afternoon_enabled',
          start: 'afternoon_start_time',
          end: 'afternoon_end_time',
          limit: 'afternoon_limit',
        },
      };
      const columns = columnsByPeriod[slot.period];

      if (slot.enabled) {
        const morning = slot.period === 'morning'
          ? [true, slot.start, slot.end, slot.limit]
          : [false, '08:00', '12:00', 10];
        const afternoon = slot.period === 'afternoon'
          ? [true, slot.start, slot.end, slot.limit]
          : [false, '13:00', '17:00', 10];
        await client.query(
          `INSERT INTO doctor_schedules
             (doctor_id, branch_id, day_of_week,
              morning_enabled, morning_start_time, morning_end_time, morning_limit,
              afternoon_enabled, afternoon_start_time, afternoon_end_time, afternoon_limit)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (doctor_id, branch_id, day_of_week)
           DO UPDATE SET ${columns.enabled} = TRUE,
                         ${columns.start} = EXCLUDED.${columns.start},
                         ${columns.end} = EXCLUDED.${columns.end},
                         ${columns.limit} = EXCLUDED.${columns.limit},
                         updated_at = CURRENT_TIMESTAMP`,
          [
            doctorId,
            slot.branchId,
            slot.dayOfWeek,
            ...morning,
            ...afternoon,
          ]
        );
      } else {
        await client.query(
          `UPDATE doctor_schedules
           SET ${columns.enabled} = FALSE,
               ${columns.start} = $1,
               ${columns.end} = $2,
               ${columns.limit} = $3,
               updated_at = CURRENT_TIMESTAMP
           WHERE doctor_id = $4 AND branch_id = $5 AND day_of_week = $6`,
          [slot.start, slot.end, slot.limit, doctorId, slot.branchId, slot.dayOfWeek]
        );
      }
    }
    await client.query('COMMIT');
    res.redirect(`/admin/doctors/${doctorId}/schedules`);
  } catch (err) {
    await client.query('ROLLBACK').catch((rollbackError) => {
      console.error('Error al revertir el guardado de horarios:', rollbackError.message);
    });
    console.error('Error al guardar la matriz de horarios:', err.message);
    res.status(500).send('No se pudo guardar la matriz de horarios. Revisa las horas, cupos y sedes.');
  } finally {
    client.release();
  }
});

function isPositiveInteger(value) {
  const candidate = String(value ?? '');
  return /^[1-9]\d*$/.test(candidate) && Number(candidate) <= 2147483647;
}

async function withBillingTransaction(callback) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function setBillingAction(client, action) {
  await client.query('SELECT set_config($1, $2, TRUE)', ['sigemed.billing_action', action]);
}

async function addBillingAuditEvent(client, invoiceId, eventType, userId, details = {}) {
  await client.query(
    `INSERT INTO billing_audit_events (invoice_id, event_type, actor_user_id, details)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [invoiceId, eventType, userId, JSON.stringify(details)]
  );
}

app.get('/admin/billing', requireRole('system_admin'), async (req, res) => {
  try {
    const [currenciesResult, ratesResult, servicesResult, settingsResult] = await Promise.all([
      db.query('SELECT code, name, active FROM billing_currencies ORDER BY code'),
      db.query(`
        SELECT DISTINCT ON (currency_code) currency_code, units_per_usd, effective_at, source
        FROM billing_exchange_rates
        WHERE effective_at <= CURRENT_TIMESTAMP
        ORDER BY currency_code, effective_at DESC, id DESC
      `),
      db.query(`
        SELECT s.id, s.code, s.name, s.service_type, s.active AS service_active,
               b.id AS branch_id, b.name AS branch_name,
               p.price_usd, p.active AS price_active
        FROM billing_services s
        CROSS JOIN branches b
        LEFT JOIN billing_service_prices p
          ON p.service_id = s.id AND p.branch_id = b.id
        ORDER BY s.name, b.name
      `),
      db.query('SELECT base_currency FROM billing_settings WHERE id = 1'),
    ]);
    res.render('admin_billing', {
      currencies: currenciesResult.rows,
      rates: ratesResult.rows,
      services: servicesResult.rows,
      baseCurrency: settingsResult.rows[0]?.base_currency || 'VES',
      error: req.query.error || null,
    });
  } catch (error) {
    console.error('Error al cargar configuración de facturación:', error.message);
    res.status(500).send('No se pudo cargar la configuración de facturación.');
  }
});

app.post('/admin/billing/currencies', requireRole('system_admin'), async (req, res) => {
  let code;
  const name = String(req.body.name || '').trim();
  try {
    code = billing.normalizeCurrency(req.body.code);
  } catch (error) {
    return res.status(400).send(error.message);
  }
  const settingsResult = await db.query('SELECT base_currency FROM billing_settings WHERE id = 1');
  const baseCurrency = settingsResult.rows[0]?.base_currency;
  if (code === baseCurrency || !name || name.length > 80) {
    return res.status(400).send('Indica una moneda distinta de la moneda base y un nombre válido.');
  }
  try {
    await db.query(
      `INSERT INTO billing_currencies (code, name, created_by_user_id)
       VALUES ($1, $2, $3)`,
      [code, name, req.session.user.id]
    );
    res.redirect('/admin/billing');
  } catch (error) {
    if (error.code === '23505') return res.redirect('/admin/billing?error=duplicate_currency');
    console.error('Error al registrar moneda:', error.message);
    res.status(500).send('No se pudo registrar la moneda.');
  }
});

app.post('/admin/billing/exchange-rates', requireRole('system_admin'), async (req, res) => {
  let currencyCode;
  let rate;
  try {
    currencyCode = billing.normalizeCurrency(req.body.currency_code);
    rate = billing.normalizeExchangeRate(req.body.units_per_usd);
  } catch (error) {
    return res.status(400).send(error.message);
  }
  const source = String(req.body.source || '').trim();
  const effectiveAt = String(req.body.effective_at || '').trim();
  const effectiveDate = new Date(effectiveAt);
  if (currencyCode === 'USD' || !source || source.length > 160
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(effectiveAt)
      || Number.isNaN(effectiveDate.getTime())) {
    return res.status(400).send('Moneda, fecha efectiva u origen de tasa no válido.');
  }
  try {
    const result = await db.query(
      `INSERT INTO billing_exchange_rates
         (currency_code, rate_to_usd, units_per_usd, effective_at, source, created_by_user_id)
       SELECT $1, greatest(round(1::NUMERIC / $2::NUMERIC, 8), 0.00000001), $2, $3, $4, $5
       WHERE EXISTS (
         SELECT 1 FROM billing_currencies WHERE code = $1 AND active = TRUE
       )
       RETURNING id`,
      [currencyCode, rate, effectiveDate, source, req.session.user.id]
    );
    if (!result.rowCount) return res.status(400).send('La moneda no está habilitada.');
    res.redirect('/admin/billing');
  } catch (error) {
    if (error.code === '23505') return res.redirect('/admin/billing?error=duplicate_rate');
    console.error('Error al registrar tasa de cambio:', error.message);
    res.status(500).send('No se pudo registrar la tasa de cambio.');
  }
});

app.post('/admin/billing/services', requireRole('system_admin'), async (req, res) => {
  let service;
  try {
    service = billing.normalizeService(req.body);
  } catch (error) {
    return res.status(400).send(error.message);
  }
  try {
    await db.query(
      `INSERT INTO billing_services (code, name, service_type, description, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [service.code, service.name, service.serviceType, service.description, req.session.user.id]
    );
    res.redirect('/admin/billing');
  } catch (error) {
    if (error.code === '23505') return res.redirect('/admin/billing?error=duplicate_service');
    console.error('Error al registrar servicio facturable:', error.message);
    res.status(500).send('No se pudo guardar el servicio facturable.');
  }
});

app.post('/admin/billing/services/:serviceId/prices/:branchId', requireRole('system_admin'), async (req, res) => {
  const { serviceId, branchId } = req.params;
  if (!isPositiveInteger(serviceId) || !isPositiveInteger(branchId)) {
    return res.status(400).send('Identificador de servicio o sede no válido.');
  }
  let price;
  try {
    price = billing.normalizeMoney(req.body.price_usd, 'El precio');
  } catch (error) {
    return res.status(400).send(error.message);
  }
  try {
    const result = await db.query(
      `INSERT INTO billing_service_prices
         (service_id, branch_id, price_usd, active, updated_by_user_id, updated_at)
       SELECT $1, $2, $3, $4, $5, CURRENT_TIMESTAMP
       WHERE EXISTS (SELECT 1 FROM billing_services WHERE id = $1)
         AND EXISTS (SELECT 1 FROM branches WHERE id = $2)
       ON CONFLICT (service_id, branch_id) DO UPDATE
         SET price_usd = EXCLUDED.price_usd, active = EXCLUDED.active,
             updated_by_user_id = EXCLUDED.updated_by_user_id,
             updated_at = CURRENT_TIMESTAMP
       RETURNING id`,
      [serviceId, branchId, price, req.body.active === 'true', req.session.user.id]
    );
    if (!result.rowCount) return res.status(404).send('No se encontró el servicio o la sede.');
    res.redirect('/admin/billing');
  } catch (error) {
    console.error('Error al guardar precio de servicio por sede:', error.message);
    res.status(500).send('No se pudo guardar el precio del servicio.');
  }
});

app.post('/admin/billing/services/:serviceId', requireRole('system_admin'), async (req, res) => {
  if (!isPositiveInteger(req.params.serviceId)
      || !['true', 'false'].includes(req.body.active)) {
    return res.status(400).send('Servicio o estado no válido.');
  }
  try {
    const result = await db.query(
      'UPDATE billing_services SET active = $1 WHERE id = $2 RETURNING id',
      [req.body.active === 'true', req.params.serviceId]
    );
    if (!result.rowCount) return res.status(404).send('Servicio no encontrado.');
    res.redirect('/admin/billing');
  } catch (error) {
    console.error('Error al actualizar servicio facturable:', error.message);
    res.status(500).send('No se pudo actualizar el servicio.');
  }
});

app.get('/billing', requireRole('admissions', 'system_admin'), async (req, res) => {
  try {
    const [branchesResult, currenciesResult, patientsResult, invoicesResult, settingsResult] = await Promise.all([
      db.query('SELECT id, name FROM branches WHERE active IS DISTINCT FROM FALSE ORDER BY name'),
      db.query(`
        SELECT c.code, c.name,
               CASE WHEN c.code = 'USD' THEN 1::NUMERIC
                    ELSE (SELECT r.units_per_usd
                          FROM billing_exchange_rates r
                          WHERE r.currency_code = c.code AND r.effective_at <= CURRENT_TIMESTAMP
                          ORDER BY r.effective_at DESC, r.id DESC LIMIT 1)
               END AS units_per_usd
        FROM billing_currencies c
        WHERE c.active = TRUE
          AND (c.code = 'USD' OR EXISTS (
            SELECT 1 FROM billing_exchange_rates r
            WHERE r.currency_code = c.code AND r.effective_at <= CURRENT_TIMESTAMP
          ))
        ORDER BY c.code
      `),
      db.query(`
        SELECT id, first_name, last_name, dni_document
        FROM patients ORDER BY id DESC LIMIT 500
      `),
      db.query(`
        SELECT i.id, i.invoice_number, i.currency, i.total, i.status, i.created_at,
               p.first_name, p.last_name, b.name AS branch_name
        FROM invoices i
        JOIN patients p ON p.id = i.patient_id
        JOIN branches b ON b.id = i.branch_id
        ORDER BY i.created_at DESC, i.id DESC
        LIMIT 100
      `),
      db.query('SELECT base_currency FROM billing_settings WHERE id = 1'),
    ]);
    res.render('billing', {
      branches: branchesResult.rows,
      currencies: currenciesResult.rows,
      patients: patientsResult.rows,
      invoices: invoicesResult.rows,
      baseCurrency: settingsResult.rows[0]?.base_currency || 'VES',
      canProcessBilling: req.session.user.roles.includes('admissions'),
    });
  } catch (error) {
    console.error('Error al cargar caja:', error.message);
    res.status(500).send('No se pudo cargar el módulo de caja.');
  }
});

app.post('/billing/invoices', requireRole('admissions'), async (req, res) => {
  const { patient_id: patientId, branch_id: branchId } = req.body;
  if (!isPositiveInteger(patientId) || !isPositiveInteger(branchId)) {
    return res.status(400).send('Paciente o sede no válido.');
  }
  let currency;
  try {
    currency = billing.normalizeCurrency(req.body.currency);
  } catch (error) {
    return res.status(400).send(error.message);
  }
  const notes = String(req.body.notes || '').trim();
  if (notes.length > 500) return res.status(400).send('Las notas admiten hasta 500 caracteres.');
  try {
    const invoiceId = await withBillingTransaction(async (client) => {
      const [patientResult, branchResult, currencyResult, settingsResult] = await Promise.all([
        client.query('SELECT id FROM patients WHERE id = $1', [patientId]),
        client.query('SELECT id FROM branches WHERE id = $1 AND active IS DISTINCT FROM FALSE', [branchId]),
        client.query(
          `SELECT c.code,
                  CASE WHEN c.code = 'USD' THEN 1::NUMERIC
                       ELSE (SELECT r.units_per_usd FROM billing_exchange_rates r
                             WHERE r.currency_code = c.code AND r.effective_at <= CURRENT_TIMESTAMP
                             ORDER BY r.effective_at DESC, r.id DESC LIMIT 1)
                  END AS units_per_usd
           FROM billing_currencies c WHERE c.code = $1 AND c.active = TRUE`,
          [currency]
        ),
        client.query('SELECT base_currency FROM billing_settings WHERE id = 1'),
      ]);
      if (!patientResult.rowCount || !branchResult.rowCount) {
        const error = new Error('Paciente o sede no encontrado.');
        error.statusCode = 404;
        throw error;
      }
      if (!settingsResult.rowCount || currency !== settingsResult.rows[0].base_currency) {
        const error = new Error('Las facturas nuevas deben emitirse en la moneda base configurada.');
        error.statusCode = 400;
        throw error;
      }
      if (!currencyResult.rowCount || !currencyResult.rows[0].units_per_usd) {
        const error = new Error('No existe una tasa vigente para la moneda seleccionada.');
        error.statusCode = 409;
        throw error;
      }
      const unitsPerUsd = String(currencyResult.rows[0].units_per_usd);
      const result = await client.query(
        `INSERT INTO invoices
           (patient_id, branch_id, currency, exchange_rate_to_usd,
            exchange_rate_units_per_usd, total_usd,
            created_by_user_id, notes, status)
         VALUES ($1, $2, $3, greatest(round(1::NUMERIC / $4::NUMERIC, 8), 0.00000001), $4, 0, $5, $6, 'draft')
         RETURNING id`,
        [patientId, branchId, currency, unitsPerUsd, req.session.user.id, notes || null]
      );
      const id = result.rows[0].id;
      await addBillingAuditEvent(client, id, 'draft_created', req.session.user.id, { currency, branchId: Number(branchId) });
      return id;
    });
    res.redirect(`/billing/invoices/${invoiceId}`);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).send(error.message);
    console.error('Error al crear borrador de factura:', error.message);
    res.status(500).send('No se pudo crear el borrador de factura.');
  }
});

app.get('/billing/invoices/:invoiceId', requireRole('admissions', 'system_admin'), async (req, res) => {
  if (!isPositiveInteger(req.params.invoiceId)) return res.status(400).send('Identificador de factura no válido.');
  try {
    const invoiceResult = await db.query(
      `SELECT i.*, p.first_name, p.last_name, b.name AS branch_name
       FROM invoices i
       JOIN patients p ON p.id = i.patient_id
       JOIN branches b ON b.id = i.branch_id
       WHERE i.id = $1`,
      [req.params.invoiceId]
    );
    if (!invoiceResult.rowCount) return res.status(404).send('Factura no encontrada.');
    const invoice = invoiceResult.rows[0];
    const [itemsResult, transactionsResult, servicesResult, currenciesResult, consultationsResult,
      proceduresResult, studiesResult] = await Promise.all([
      db.query(
        `SELECT ii.*, CASE
           WHEN ii.consultation_id IS NOT NULL THEN 'Consulta #' || ii.consultation_id
           WHEN ii.procedure_id IS NOT NULL THEN 'Procedimiento #' || ii.procedure_id
           WHEN ii.study_order_id IS NOT NULL THEN 'Estudio #' || ii.study_order_id
           ELSE NULL END AS source_label
         FROM invoice_items ii WHERE ii.invoice_id = $1 ORDER BY ii.id`,
        [invoice.id]
      ),
      db.query(
        `SELECT t.*, u.name AS operator_name,
                EXISTS (SELECT 1 FROM billing_transactions r WHERE r.reversal_of_transaction_id = t.id) AS reversed
         FROM billing_transactions t JOIN users u ON u.id = t.received_by_user_id
         WHERE t.invoice_id = $1 ORDER BY t.created_at, t.id`,
        [invoice.id]
      ),
      db.query(
        `SELECT s.id, s.name, s.service_type, p.price_usd
         FROM billing_services s
         JOIN billing_service_prices p ON p.service_id = s.id AND p.branch_id = $1
         WHERE s.active = TRUE AND p.active = TRUE
         ORDER BY s.service_type, s.name`,
        [invoice.branch_id]
      ),
      db.query(`
        SELECT c.code, c.name,
               CASE WHEN c.code = 'USD' THEN 1::NUMERIC
                    ELSE (SELECT r.units_per_usd FROM billing_exchange_rates r
                          WHERE r.currency_code = c.code AND r.effective_at <= CURRENT_TIMESTAMP
                          ORDER BY r.effective_at DESC, r.id DESC LIMIT 1)
               END AS units_per_usd
        FROM billing_currencies c
        WHERE c.active = TRUE
          AND (c.code = 'USD' OR EXISTS (
            SELECT 1 FROM billing_exchange_rates r
            WHERE r.currency_code = c.code AND r.effective_at <= CURRENT_TIMESTAMP
          ))
        ORDER BY c.code
      `),
      db.query(
        `SELECT mc.id, mc.created_at
         FROM medical_consultations mc
         LEFT JOIN appointments a ON a.id = mc.appointment_id
         WHERE mc.patient_id = $1 AND (a.branch_id IS NULL OR a.branch_id = $2)
         ORDER BY mc.created_at DESC`,
        [invoice.patient_id, invoice.branch_id]
      ),
      db.query(
        `SELECT mp.id, mp.name
         FROM minor_procedures mp
         JOIN medical_consultations mc ON mc.id = mp.consultation_id
         LEFT JOIN appointments a ON a.id = mc.appointment_id
         WHERE mc.patient_id = $1 AND mp.status = 'completed'
           AND (a.branch_id IS NULL OR a.branch_id = $2)
         ORDER BY mp.performed_at DESC`,
        [invoice.patient_id, invoice.branch_id]
      ),
      db.query(
        `SELECT so.id, sc.name
         FROM study_orders so
         JOIN study_catalog sc ON sc.id = so.study_id
         JOIN medical_consultations mc ON mc.id = so.consultation_id
         LEFT JOIN appointments a ON a.id = mc.appointment_id
         WHERE mc.patient_id = $1 AND so.status <> 'cancelled'
           AND (a.branch_id IS NULL OR a.branch_id = $2)
         ORDER BY so.ordered_at DESC`,
        [invoice.patient_id, invoice.branch_id]
      ),
    ]);
    const totalsResult = await db.query(
      `SELECT COALESCE(SUM(CASE WHEN transaction_type = 'payment' THEN amount_usd ELSE -amount_usd END), 0)::numeric(12,2)::text AS paid_usd
       FROM billing_transactions WHERE invoice_id = $1`,
      [invoice.id]
    );
    const paidCents = billing.moneyToCents(totalsResult.rows[0].paid_usd);
    const totalUsdCents = billing.moneyToCents(invoice.total_usd || '0');
    const balanceUsd = billing.centsToMoney(totalUsdCents > paidCents ? totalUsdCents - paidCents : 0n);
    const balance = billing.convertUsdToCurrency(balanceUsd, invoice.exchange_rate_units_per_usd || '1');
    const payments = transactionsResult.rows.filter((entry) => entry.transaction_type === 'payment');
    const canVoid = payments.every((entry) => entry.reversed);
    res.render('billing_invoice', {
      invoice,
      items: itemsResult.rows,
      transactions: transactionsResult.rows,
      services: servicesResult.rows,
      currencies: currenciesResult.rows,
      consultations: consultationsResult.rows,
      procedures: proceduresResult.rows,
      studies: studiesResult.rows,
      balance,
      canVoid,
      canProcessBilling: req.session.user.roles.includes('admissions'),
    });
  } catch (error) {
    console.error('Error al consultar factura:', error.message);
    res.status(500).send('No se pudo consultar la factura.');
  }
});

app.post('/billing/invoices/:invoiceId/items', requireRole('admissions'), async (req, res) => {
  const { invoiceId } = req.params;
  if (!isPositiveInteger(invoiceId) || !isPositiveInteger(req.body.service_id)) {
    return res.status(400).send('Factura o servicio no válido.');
  }
  let quantity;
  try {
    quantity = billing.normalizeQuantity(req.body.quantity);
  } catch (error) {
    return res.status(400).send(error.message);
  }
  const sourceMatch = /^(consultation|procedure|study):([1-9]\d*)$/.exec(String(req.body.source_ref || ''));
  if (!sourceMatch || !isPositiveInteger(sourceMatch[2])) {
    return res.status(400).send('Selecciona el origen clínico asociado al servicio.');
  }
  const [, sourceType, sourceId] = sourceMatch;
  const expectedCategory = { consultation: 'consultation', procedure: 'procedure', study: 'study' }[sourceType];
  try {
    await withBillingTransaction(async (client) => {
      const invoiceResult = await client.query('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [invoiceId]);
      if (!invoiceResult.rowCount) {
        const error = new Error('Factura no encontrada.');
        error.statusCode = 404;
        throw error;
      }
      const invoice = invoiceResult.rows[0];
      if (invoice.status !== 'draft') {
        const error = new Error('Solo se pueden agregar servicios a un borrador.');
        error.statusCode = 409;
        throw error;
      }
      const serviceResult = await client.query(
        `SELECT s.id, s.name, s.service_type, p.price_usd
         FROM billing_services s
         JOIN billing_service_prices p ON p.service_id = s.id AND p.branch_id = $2
         WHERE s.id = $1 AND s.active = TRUE AND p.active = TRUE
         FOR SHARE OF p`,
        [req.body.service_id, invoice.branch_id]
      );
      if (!serviceResult.rowCount || serviceResult.rows[0].service_type !== expectedCategory) {
        const error = new Error('El servicio no está activo en esta sede o no corresponde al origen clínico.');
        error.statusCode = 400;
        throw error;
      }
      let sourceResult;
      if (sourceType === 'consultation') {
        sourceResult = await client.query(
          `SELECT mc.id, mc.patient_id, a.branch_id
           FROM medical_consultations mc LEFT JOIN appointments a ON a.id = mc.appointment_id
           WHERE mc.id = $1`,
          [sourceId]
        );
      } else if (sourceType === 'procedure') {
        sourceResult = await client.query(
          `SELECT mp.id, mc.patient_id, a.branch_id
           FROM minor_procedures mp
           JOIN medical_consultations mc ON mc.id = mp.consultation_id
           LEFT JOIN appointments a ON a.id = mc.appointment_id
           WHERE mp.id = $1 AND mp.status = 'completed'`,
          [sourceId]
        );
      } else {
        sourceResult = await client.query(
          `SELECT so.id, mc.patient_id, a.branch_id
           FROM study_orders so
           JOIN medical_consultations mc ON mc.id = so.consultation_id
           LEFT JOIN appointments a ON a.id = mc.appointment_id
           WHERE so.id = $1 AND so.status <> 'cancelled'`,
          [sourceId]
        );
      }
      if (!sourceResult.rowCount
          || Number(sourceResult.rows[0].patient_id) !== Number(invoice.patient_id)
          || (sourceResult.rows[0].branch_id
              && Number(sourceResult.rows[0].branch_id) !== Number(invoice.branch_id))) {
        const error = new Error('El origen clínico no corresponde al paciente o a la sede de la factura.');
        error.statusCode = 400;
        throw error;
      }
      const service = serviceResult.rows[0];
      const unitPrice = billing.convertUsdToCurrency(service.price_usd, invoice.exchange_rate_units_per_usd);
      const lineResult = await client.query(
        'SELECT round($1::numeric * $2::numeric, 2)::numeric(12,2)::text AS line_total',
        [unitPrice, quantity]
      );
      const columns = {
        consultation: 'consultation_id',
        procedure: 'procedure_id',
        study: 'study_order_id',
      };
      await client.query(
        `INSERT INTO invoice_items
           (invoice_id, service_id, description, category, quantity, unit_price, line_total,
            base_unit_price_usd, ${columns[sourceType]})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          invoice.id, service.id, service.name, service.service_type, quantity,
          unitPrice, lineResult.rows[0].line_total, service.price_usd, sourceId,
        ]
      );
      await client.query(
        `UPDATE invoices i
         SET subtotal = totals.amount, total = totals.amount, tax = 0,
           total_usd = totals.usd_amount
         FROM (
          SELECT COALESCE(SUM(line_total), 0)::numeric(12,2) AS amount,
                 round(COALESCE(SUM(base_unit_price_usd * quantity), 0), 2)::numeric(12,2) AS usd_amount
          FROM invoice_items WHERE invoice_id = $1
        ) totals
         WHERE i.id = $1`,
        [invoice.id]
      );
      await addBillingAuditEvent(client, invoice.id, 'item_added', req.session.user.id, {
        serviceId: Number(service.id), sourceType, sourceId: Number(sourceId),
      });
    });
    res.redirect(`/billing/invoices/${invoiceId}`);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).send(error.message);
    console.error('Error al agregar servicio a factura:', error.message);
    res.status(500).send('No se pudo agregar el servicio a la factura.');
  }
});

app.post('/billing/invoices/:invoiceId/issue', requireRole('admissions'), async (req, res) => {
  if (!isPositiveInteger(req.params.invoiceId)) return res.status(400).send('Identificador de factura no válido.');
  try {
    await withBillingTransaction(async (client) => {
      const result = await client.query('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [req.params.invoiceId]);
      if (!result.rowCount) {
        const error = new Error('Factura no encontrada.');
        error.statusCode = 404;
        throw error;
      }
      let invoice = result.rows[0];
      if (invoice.status !== 'draft') {
        const error = new Error('Solo se puede emitir un borrador.');
        error.statusCode = 409;
        throw error;
      }
      const rateResult = await client.query(
        `SELECT CASE WHEN c.code = 'USD' THEN 1::NUMERIC
                     ELSE (SELECT r.units_per_usd FROM billing_exchange_rates r
                           WHERE r.currency_code = c.code AND r.effective_at <= CURRENT_TIMESTAMP
                           ORDER BY r.effective_at DESC, r.id DESC LIMIT 1)
                END AS units_per_usd
         FROM billing_currencies c WHERE c.code = $1 AND c.active = TRUE`,
        [invoice.currency]
      );
      if (!rateResult.rowCount || !rateResult.rows[0].units_per_usd) {
        const error = new Error('No existe una tasa vigente para la moneda de la factura.');
        error.statusCode = 409;
        throw error;
      }
      const unitsPerUsd = String(rateResult.rows[0].units_per_usd);
      const items = await client.query(
        'SELECT id, base_unit_price_usd, quantity FROM invoice_items WHERE invoice_id = $1 ORDER BY id FOR UPDATE',
        [invoice.id]
      );
      if (!items.rowCount) {
        const error = new Error('Agrega al menos un servicio antes de emitir la factura.');
        error.statusCode = 409;
        throw error;
      }
      for (const item of items.rows) {
        const unitPrice = billing.convertUsdToCurrency(item.base_unit_price_usd, unitsPerUsd);
        const lineResult = await client.query(
          'SELECT round($1::numeric * $2::numeric, 2)::numeric(12,2)::text AS line_total',
          [unitPrice, item.quantity]
        );
        await client.query(
          'UPDATE invoice_items SET unit_price = $1, line_total = $2 WHERE id = $3',
          [unitPrice, lineResult.rows[0].line_total, item.id]
        );
      }
      const totals = (await client.query(
        'SELECT COALESCE(SUM(line_total), 0)::numeric(12,2)::text AS subtotal FROM invoice_items WHERE invoice_id = $1',
        [invoice.id]
      )).rows[0];
      const convertedTotal = billing.convertCurrencyToUsd(totals.subtotal, unitsPerUsd);
      if (billing.moneyToCents(totals.subtotal) <= 0n
          || billing.moneyToCents(convertedTotal) <= 0n) {
        const error = new Error('La factura debe tener un total positivo para poder emitirse.');
        error.statusCode = 409;
        throw error;
      }
      await client.query(
        `UPDATE invoices
         SET exchange_rate_to_usd = greatest(round(1::NUMERIC / $1::NUMERIC, 8), 0.00000001),
             exchange_rate_units_per_usd = $1,
             subtotal = $2, total = $2, discount = 0, tax = 0, total_usd = $3
         WHERE id = $4`,
        [unitsPerUsd, totals.subtotal, convertedTotal, invoice.id]
      );
      invoice = (await client.query('SELECT * FROM invoices WHERE id = $1', [invoice.id])).rows[0];
      await setBillingAction(client, 'issue');
      const invoiceNumber = `S${invoice.branch_id}-${new Date().getFullYear()}-${String(invoice.id).padStart(6, '0')}`;
      await client.query(
        `UPDATE invoices
         SET status = 'pending', invoice_number = $1,
             issued_by_user_id = $2, issued_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [invoiceNumber, req.session.user.id, invoice.id]
      );
      await addBillingAuditEvent(client, invoice.id, 'issued', req.session.user.id, { invoiceNumber });
    });
    res.redirect(`/billing/invoices/${req.params.invoiceId}`);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).send(error.message);
    console.error('Error al emitir factura:', error.message);
    res.status(500).send('No se pudo emitir la factura.');
  }
});

app.post('/billing/invoices/:invoiceId/payments', requireRole('admissions'), async (req, res) => {
  if (!isPositiveInteger(req.params.invoiceId)) return res.status(400).send('Identificador de factura no válido.');
  let currency;
  let amount;
  try {
    currency = billing.normalizeCurrency(req.body.currency);
    amount = billing.normalizeMoney(req.body.amount, 'El importe');
  } catch (error) {
    return res.status(400).send(error.message);
  }
  const reference = String(req.body.reference || '').trim();
  if (reference.length > 160) return res.status(400).send('La referencia admite hasta 160 caracteres.');
  try {
    await withBillingTransaction(async (client) => {
      const invoiceResult = await client.query('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [req.params.invoiceId]);
      if (!invoiceResult.rowCount) {
        const error = new Error('Factura no encontrada.');
        error.statusCode = 404;
        throw error;
      }
      const invoice = invoiceResult.rows[0];
      if (invoice.status !== 'pending') {
        const error = new Error('Solo se pueden recibir abonos de facturas pendientes.');
        error.statusCode = 409;
        throw error;
      }
      const rateResult = await client.query(
        `SELECT CASE WHEN c.code = 'USD' THEN 1::NUMERIC
                     ELSE (SELECT r.units_per_usd FROM billing_exchange_rates r
                           WHERE r.currency_code = c.code AND r.effective_at <= CURRENT_TIMESTAMP
                           ORDER BY r.effective_at DESC, r.id DESC LIMIT 1)
                END AS units_per_usd
         FROM billing_currencies c WHERE c.code = $1 AND c.active = TRUE`,
        [currency]
      );
      if (!rateResult.rowCount || !rateResult.rows[0].units_per_usd) {
        const error = new Error('No existe una tasa vigente para la moneda recibida.');
        error.statusCode = 409;
        throw error;
      }
      const unitsPerUsd = String(rateResult.rows[0].units_per_usd);
      const amountUsd = billing.convertCurrencyToUsd(amount, unitsPerUsd);
      if (billing.moneyToCents(amountUsd) <= 0n) {
        const error = new Error('El importe convertido es menor que la unidad mínima de USD.');
        error.statusCode = 400;
        throw error;
      }
      const paidResult = await client.query(
        `SELECT COALESCE(SUM(CASE WHEN transaction_type = 'payment' THEN amount_usd ELSE -amount_usd END), 0)::numeric(12,2)::text AS paid_usd
         FROM billing_transactions WHERE invoice_id = $1`,
        [invoice.id]
      );
      const paid = billing.moneyToCents(paidResult.rows[0].paid_usd);
      if (paid + billing.moneyToCents(amountUsd) > billing.moneyToCents(invoice.total_usd)) {
        const error = new Error('El abono supera el saldo pendiente de la factura.');
        error.statusCode = 409;
        throw error;
      }
      await client.query(
        `INSERT INTO billing_transactions
           (invoice_id, branch_id, transaction_type, amount, currency, exchange_rate_to_usd,
            exchange_rate_units_per_usd, amount_usd, reference, received_by_user_id)
         VALUES ($1, $2, 'payment', $3, $4, greatest(round(1::NUMERIC / $5::NUMERIC, 8), 0.00000001), $5, $6, $7, $8)`,
        [invoice.id, invoice.branch_id, amount, currency, unitsPerUsd, amountUsd, reference || null, req.session.user.id]
      );
      const fullyPaid = paid + billing.moneyToCents(amountUsd) === billing.moneyToCents(invoice.total_usd);
      if (fullyPaid) {
        await setBillingAction(client, 'payment');
        await client.query("UPDATE invoices SET status = 'paid' WHERE id = $1", [invoice.id]);
      }
      await addBillingAuditEvent(client, invoice.id, 'payment', req.session.user.id, {
        amount, currency, unitsPerUsd, amountUsd, fullyPaid,
      });
    });
    res.redirect(`/billing/invoices/${req.params.invoiceId}`);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).send(error.message);
    if (error.message?.includes('Payment exceeds')) return res.status(409).send('El abono supera el saldo pendiente de la factura.');
    console.error('Error al registrar abono:', error.message);
    res.status(500).send('No se pudo registrar el abono.');
  }
});

app.post('/billing/invoices/:invoiceId/transactions/:transactionId/refund', requireRole('admissions'), async (req, res) => {
  const { invoiceId, transactionId } = req.params;
  if (!isPositiveInteger(invoiceId) || !isPositiveInteger(transactionId)) {
    return res.status(400).send('Identificador de factura o transacción no válido.');
  }
  try {
    await withBillingTransaction(async (client) => {
      const invoiceResult = await client.query('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [invoiceId]);
      if (!invoiceResult.rowCount) {
        const error = new Error('Factura no encontrada.');
        error.statusCode = 404;
        throw error;
      }
      const invoice = invoiceResult.rows[0];
      if (!['pending', 'paid'].includes(invoice.status)) {
        const error = new Error('Solo se pueden revertir cobros de facturas pendientes o pagadas.');
        error.statusCode = 409;
        throw error;
      }
      const paymentResult = await client.query(
        `SELECT t.* FROM billing_transactions t
         WHERE t.id = $1 AND t.invoice_id = $2 AND t.transaction_type = 'payment'
           AND NOT EXISTS (
             SELECT 1 FROM billing_transactions r WHERE r.reversal_of_transaction_id = t.id
           )
         FOR UPDATE`,
        [transactionId, invoiceId]
      );
      if (!paymentResult.rowCount) {
        const error = new Error('El cobro no existe o ya fue revertido.');
        error.statusCode = 409;
        throw error;
      }
      const payment = paymentResult.rows[0];
      await client.query(
        `INSERT INTO billing_transactions
           (invoice_id, branch_id, transaction_type, reversal_of_transaction_id,
            amount, currency, exchange_rate_to_usd, exchange_rate_units_per_usd,
            amount_usd, reference, received_by_user_id)
         VALUES ($1, $2, 'refund', $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          invoice.id, invoice.branch_id, payment.id, payment.amount, payment.currency,
          payment.exchange_rate_to_usd, payment.exchange_rate_units_per_usd, payment.amount_usd,
          `Reversión íntegra del cobro #${payment.id}`, req.session.user.id,
        ]
      );
      const paidResult = await client.query(
        `SELECT COALESCE(SUM(CASE WHEN transaction_type = 'payment' THEN amount_usd ELSE -amount_usd END), 0)::numeric(12,2)::text AS paid_usd
         FROM billing_transactions WHERE invoice_id = $1`,
        [invoice.id]
      );
      if (invoice.status === 'paid'
          && billing.moneyToCents(paidResult.rows[0].paid_usd) < billing.moneyToCents(invoice.total_usd)) {
        await setBillingAction(client, 'refund');
        await client.query("UPDATE invoices SET status = 'pending' WHERE id = $1", [invoice.id]);
      }
      await addBillingAuditEvent(client, invoice.id, 'refund', req.session.user.id, {
        transactionId: Number(payment.id), amount: payment.amount, currency: payment.currency,
      });
    });
    res.redirect(`/billing/invoices/${invoiceId}`);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).send(error.message);
    console.error('Error al revertir cobro:', error.message);
    res.status(500).send('No se pudo revertir el cobro.');
  }
});

app.post('/billing/invoices/:invoiceId/void', requireRole('admissions'), async (req, res) => {
  if (!isPositiveInteger(req.params.invoiceId)) return res.status(400).send('Identificador de factura no válido.');
  try {
    await withBillingTransaction(async (client) => {
      const result = await client.query('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [req.params.invoiceId]);
      if (!result.rowCount) {
        const error = new Error('Factura no encontrada.');
        error.statusCode = 404;
        throw error;
      }
      if (!['draft', 'pending'].includes(result.rows[0].status)) {
        const error = new Error('Solo se pueden anular borradores o facturas pendientes.');
        error.statusCode = 409;
        throw error;
      }
      await setBillingAction(client, 'void');
      await client.query("UPDATE invoices SET status = 'void' WHERE id = $1", [req.params.invoiceId]);
      await addBillingAuditEvent(client, req.params.invoiceId, 'void', req.session.user.id, {});
    });
    res.redirect(`/billing/invoices/${req.params.invoiceId}`);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).send(error.message);
    if (error.message?.includes('Every payment')) return res.status(409).send('Revierte todos los cobros antes de anular la factura.');
    console.error('Error al anular factura:', error.message);
    res.status(500).send('No se pudo anular la factura.');
  }
});

app.get('/billing/invoices/:invoiceId/print', requireRole('admissions', 'system_admin'), async (req, res) => {
  if (!isPositiveInteger(req.params.invoiceId)) return res.status(400).send('Identificador de factura no válido.');
  try {
    const invoiceResult = await db.query(
      `SELECT i.*, p.first_name, p.last_name, p.dni_document, b.name AS branch_name,
              u.name AS cashier_name
       FROM invoices i
       JOIN patients p ON p.id = i.patient_id
       JOIN branches b ON b.id = i.branch_id
       LEFT JOIN users u ON u.id = i.issued_by_user_id
       WHERE i.id = $1 AND i.status IN ('pending', 'paid', 'void')`,
      [req.params.invoiceId]
    );
    if (!invoiceResult.rowCount) return res.status(404).send('No se encontró una factura emitida.');
    const invoice = invoiceResult.rows[0];
    const itemsResult = await db.query(
      'SELECT description, category, quantity, unit_price, line_total FROM invoice_items WHERE invoice_id = $1 ORDER BY id',
      [invoice.id]
    );
    const paymentsResult = await db.query(
      `SELECT transaction_type, amount, currency, created_at, reversal_of_transaction_id
       FROM billing_transactions WHERE invoice_id = $1 ORDER BY created_at, id`,
      [invoice.id]
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="comprobante-${invoice.id}.pdf"`);
    const document = new PDFDocument({ margin: 48 });
    document.pipe(res);
    document.fontSize(18).text('Comprobante interno de facturación', { align: 'center' });
    document.moveDown().fontSize(10)
      .text(`Factura: ${invoice.invoice_number}`)
      .text(`Estado: ${{ pending: 'Pendiente', paid: 'Pagado', void: 'Anulado' }[invoice.status]}`)
      .text(`Sede: ${invoice.branch_name}`)
      .text(`Paciente: ${invoice.first_name} ${invoice.last_name}`)
      .text(`Documento: ${invoice.dni_document || 'No registrado'}`)
      .text(`Emitida: ${invoice.issued_at?.toLocaleString('es-ES') || '—'}`)
      .text(`Operador: ${invoice.cashier_name || '—'}`);
    document.moveDown().font('Helvetica-Bold').text('Servicios', { underline: true });
    document.font('Helvetica');
    for (const item of itemsResult.rows) {
      document.text(`${item.description} (${item.category}) — ${item.quantity} x ${invoice.currency} ${item.unit_price} = ${invoice.currency} ${item.line_total}`);
    }
    document.moveDown().font('Helvetica-Bold')
      .text(`Subtotal: ${invoice.currency} ${invoice.subtotal}`)
      .text(`Impuestos: ${invoice.currency} ${invoice.tax}`)
      .text(`Total: ${invoice.currency} ${invoice.total}`);
    document.font('Helvetica').moveDown().text('Transacciones');
    for (const entry of paymentsResult.rows) {
      document.text(`${entry.transaction_type === 'payment' ? 'Cobro' : `Devolución #${entry.reversal_of_transaction_id}`} — ${entry.currency} ${entry.amount} — ${entry.created_at.toLocaleString('es-ES')}`);
    }
    document.moveDown(2).fontSize(8)
      .text('Documento interno. No sustituye una factura fiscal. Impuestos no calculados hasta definir la normativa aplicable.', { align: 'center' });
    document.end();
  } catch (error) {
    console.error('Error al generar comprobante de factura:', error.message);
    res.status(500).send('No se pudo generar el comprobante.');
  }
});

const reportRoles = ['system_admin', 'audit_security', 'admissions', 'doctor', 'nurse'];
const financialReportRoles = ['system_admin', 'audit_security'];

async function loadReport(req, res, errorFormat = 'json') {
  const respond = (status, message) => errorFormat === 'html'
    ? res.status(status).send(message)
    : res.status(status).json({ error: message });
  let filters;
  try {
    filters = reports.normalizeFilters(req.query);
  } catch (error) {
    respond(400, error.message);
    return null;
  }
  const includeFinancial = req.session.user.roles.some((role) => financialReportRoles.includes(role));
  try {
    return await reports.getReport(db, filters, includeFinancial);
  } catch (error) {
    if (error.message === 'La sede seleccionada no existe.') {
      respond(400, error.message);
      return null;
    }
    console.error('Error al consultar las vistas analíticas:', error.message);
    respond(500, 'No se pudieron cargar los reportes.');
    return null;
  }
}

app.get('/reports', requireRole(...reportRoles), async (req, res) => {
  const report = await loadReport(req, res, 'html');
  if (!report) return;
  await recordAccessEvent(db, req, {
    eventType: 'report_view',
    resourceType: 'report',
    resourceId: 'overview.html',
    details: {
      from: report.filters.from,
      to: report.filters.to,
      branch_id: report.filters.branchId,
    },
  });
  res.render('reports', { report, filters: report.filters });
});

app.get('/api/reports/overview', requireRole(...reportRoles), async (req, res) => {
  const report = await loadReport(req, res);
  if (!report) return;
  await recordAccessEvent(db, req, {
    eventType: 'report_view',
    resourceType: 'report',
    resourceId: 'overview.api',
    details: {
      from: report.filters.from,
      to: report.filters.to,
      branch_id: report.filters.branchId,
    },
  });
  res.json(report);
});

app.get('/reports/export/:type/:format', requireRole(...reportRoles), async (req, res) => {
  const { type, format } = req.params;
  if (!['clinical', 'financial'].includes(type) || !['csv', 'pdf'].includes(format)) {
    return res.status(400).send('Tipo o formato de reporte no válido.');
  }
  if (type === 'financial'
      && !req.session.user.roles.some((role) => financialReportRoles.includes(role))) {
    return res.status(403).send('No tienes permisos para exportar información financiera.');
  }

  const report = await loadReport(req, res);
  if (!report) return;
  try {
    await recordAccessEvent(db, req, {
      eventType: 'report_export',
      resourceType: 'report',
      resourceId: `${type}.${format}`,
      details: {
        from: report.filters.from,
        to: report.filters.to,
        branch_id: report.filters.branchId,
      },
    });

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="sigemed-${type}-${report.filters.from}-${report.filters.to}.csv"`);
      return res.send(reports.toCsv(report, type));
    }

    const document = new PDFDocument({ margin: 48, size: 'A4' });
    const chunks = [];
    const pdf = await new Promise((resolve, reject) => {
      document.on('data', (chunk) => chunks.push(chunk));
      document.once('end', () => resolve(Buffer.concat(chunks)));
      document.once('error', reject);
      document.fontSize(17).font('Helvetica-Bold')
        .text(type === 'clinical' ? 'Reporte clínico agregado' : 'Reporte financiero agregado', { align: 'center' });
      document.moveDown().fontSize(10).font('Helvetica')
        .text(`Periodo: ${report.filters.from} a ${report.filters.to}`)
        .text(`Sede: ${report.filters.branchId === null ? 'Todas' : report.branches.find((branch) => branch.id === report.filters.branchId)?.name || 'Seleccionada'}`)
        .text('Datos agregados; no incluye identificadores de pacientes.');
      document.moveDown();

      const lines = type === 'clinical'
        ? [
          `Citas: ${report.totals.appointments} | Atendidas: ${report.totals.attended_appointments} | Consultas: ${report.totals.consultations}`,
          `Órdenes de estudio: ${report.totals.study_orders} | Procedimientos: ${report.totals.procedures}`,
          `Ocupación: ${report.totals.occupancy_pct === null ? 'Sin capacidad configurada' : `${report.totals.occupancy_pct}%`}`,
          '',
          'Consultas por sede y especialidad:',
          ...report.specialty.map((row) => `${row.branch_name} — ${row.specialty}: ${row.consultations}`),
          '',
          'Ocupación por sede:',
          ...report.occupancy.map((row) => `${row.branch_name}: ${row.booked}/${row.capacity} citas (${row.occupancy_pct === null ? 'sin capacidad' : `${row.occupancy_pct}%`})`),
          '',
          'Actividad diaria:',
          ...report.clinical.map((row) => `${row.report_date} — ${row.branch_name}: citas ${row.appointments}, atendidas ${row.attended_appointments}, consultas ${row.consultations}, estudios ${row.study_orders}, procedimientos ${row.procedures}`),
        ]
        : [
          `Facturado neto (USD): ${report.financialTotals.invoiced_usd.toFixed(2)}`,
          `Recaudación neta (USD): ${report.financialTotals.collected_net_usd.toFixed(2)}`,
          `Facturas emitidas: ${report.financialTotals.invoices_issued} | Pagadas: ${report.financialTotals.invoices_paid} | Anuladas: ${report.financialTotals.invoices_voided}`,
          '',
          'Actividad financiera diaria (USD):',
          ...report.financial.map((row) => `${row.report_date} — ${row.branch_name}: facturado ${row.invoiced_usd.toFixed(2)}, cobros ${row.payments_usd.toFixed(2)}, reembolsos ${row.refunds_usd.toFixed(2)}, neto ${row.collected_net_usd.toFixed(2)}`),
        ];
      let y = document.y;
      for (const line of lines) {
        if (y > 745) {
          document.addPage();
          y = 48;
        }
        document.text(line, 48, y, { width: 500 });
        y = document.y + 6;
      }
      document.moveDown(2).fontSize(8)
        .text('Uso interno. Indicadores financieros expresados en USD según las tasas congeladas al emitir y cobrar.');
      document.end();
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="sigemed-${type}-${report.filters.from}-${report.filters.to}.pdf"`);
    res.send(pdf);
  } catch (error) {
    console.error('Error al exportar reporte:', error.message);
    if (!res.headersSent) res.status(500).send('No se pudo generar el reporte.');
    else res.destroy(error);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor EMR corriendo en el puerto ${PORT}`);
});