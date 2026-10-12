const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { once } = require('node:events');

test('reportes agregados, exportaciones auditadas y acceso por rol', {
  skip: process.env.SIGEMED_REPORTS_INTEGRATION !== '1',
}, async () => {
  require('dotenv').config();
  const db = require('../db');
  const root = require('node:path').join(__dirname, '..');
  const marker = crypto.randomUUID();
  const shortMarker = marker.replace(/-/g, '').slice(0, 12);
  const patientMarker = `PatientOnly-${shortMarker}`;
  const fixture = {};
  const emails = [];
  const cookies = { admin: '', cashier: '', doctor: '' };
  const probe = require('node:net').createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['index.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'production',
      SESSION_SECRET: crypto.randomBytes(48).toString('hex'),
      TRUST_PROXY: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  server.stdout.on('data', (chunk) => { serverOutput += chunk; });
  server.stderr.on('data', (chunk) => { serverOutput += chunk; });

  function saveCookies(actor, response) {
    const headers = response.headers.getSetCookie?.() || [response.headers.get('set-cookie')].filter(Boolean);
    for (const header of headers) {
      const pair = header.split(';')[0];
      const name = pair.split('=')[0];
      cookies[actor] = cookies[actor].split('; ').filter((entry) => entry && entry.split('=')[0] !== name)
        .concat(pair).join('; ');
    }
  }

  async function request(actor, path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        'X-Forwarded-Proto': 'https',
        ...(options.headers || {}),
        ...(cookies[actor] ? { Cookie: cookies[actor] } : {}),
      },
    });
    saveCookies(actor, response);
    return response;
  }

  function csrf(html) {
    const match = html.match(/name="_csrf" value="([^"]+)"/);
    assert.ok(match, 'la sesión debe incluir token CSRF');
    return match[1];
  }

  async function createUser(actor, baseRole, roleKey) {
    const email = `${actor}-${marker}@example.invalid`;
    const password = crypto.randomBytes(20).toString('hex');
    const result = await db.query(
      `INSERT INTO users (name, email, password_hash, role, active)
       VALUES ($1, $2, $3, $4, TRUE) RETURNING id`,
      [`Reports ${actor}`, email, await bcrypt.hash(password, 4), baseRole]
    );
    fixture[actor] = result.rows[0].id;
    emails.push(email);
    await db.query(
      'INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE role_key = $2',
      [fixture[actor], roleKey]
    );
    return { email, password };
  }

  async function login(actor, user) {
    const page = await request(actor, '/login');
    const token = csrf(await page.text());
    const response = await request(actor, '/login', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: user.email, password: user.password, _csrf: token }),
    });
    assert.equal(response.status, 302);
    assert.match(response.headers.get('set-cookie') || '', /;\s*secure(?:;|$)/i);
  }

  async function runRefresh() {
    const child = spawn(process.execPath, ['scripts/refresh-reports.js'], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, `refresh de reportería falló: ${output}`);
  }

  async function cleanup() {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE access_audit_logs DISABLE TRIGGER access_audit_logs_immutable');
      await client.query('ALTER TABLE invoices DISABLE TRIGGER invoices_billing_guard');
      await client.query('ALTER TABLE billing_transactions DISABLE TRIGGER billing_transactions_immutable');
      await client.query('ALTER TABLE prescriptions DISABLE TRIGGER prescriptions_signed_immutable');
      await client.query('ALTER TABLE prescription_items DISABLE TRIGGER prescription_items_signed_immutable');
      await client.query(
        'DELETE FROM access_audit_logs WHERE user_agent = $1',
        [`SIGEMED-Audit-Test-${shortMarker}`]
      );
      await client.query(
        'DELETE FROM access_audit_logs WHERE patient_id = $1 OR user_id = ANY($2::int[])',
        [
          fixture.patient || -1,
          [fixture.admin, fixture.cashier, fixture.doctor].filter(Boolean),
        ]
      );
      if (fixture.invoice) {
        await client.query('DELETE FROM billing_transactions WHERE invoice_id = $1', [fixture.invoice]);
        await client.query('DELETE FROM invoices WHERE id = $1', [fixture.invoice]);
      }
      if (fixture.consultation) {
        await client.query(
          'DELETE FROM prescription_items WHERE prescription_id IN (SELECT id FROM prescriptions WHERE consultation_id = $1)',
          [fixture.consultation]
        );
        await client.query('DELETE FROM prescriptions WHERE consultation_id = $1', [fixture.consultation]);
      }
      if (fixture.procedure) await client.query('DELETE FROM minor_procedures WHERE id = $1', [fixture.procedure]);
      if (fixture.studyOrder) await client.query('DELETE FROM study_orders WHERE id = $1', [fixture.studyOrder]);
      if (fixture.consultation) await client.query('DELETE FROM medical_consultations WHERE id = $1', [fixture.consultation]);
      if (fixture.appointment) await client.query('DELETE FROM appointments WHERE id = $1', [fixture.appointment]);
      if (fixture.doctorProfile) {
        await client.query('DELETE FROM doctor_specialties WHERE doctor_id = $1', [fixture.doctorProfile]);
        await client.query('DELETE FROM doctor_user_accounts WHERE doctor_id = $1', [fixture.doctorProfile]);
        await client.query('DELETE FROM doctors WHERE id = $1', [fixture.doctorProfile]);
        await client.query('DELETE FROM doctor_schedules WHERE doctor_id = $1', [fixture.doctorProfile]);
      }
      if (fixture.specialty) await client.query('DELETE FROM specialties WHERE id = $1', [fixture.specialty]);
      if (fixture.patient) await client.query('DELETE FROM patients WHERE id = $1', [fixture.patient]);
      for (const email of emails) await client.query('DELETE FROM session WHERE sess::text LIKE $1', [`%${email}%`]);
      for (const userId of [fixture.admin, fixture.cashier, fixture.doctor].filter(Boolean)) {
        await client.query('DELETE FROM access_audit_logs WHERE user_id = $1', [userId]);
        await client.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
        await client.query('DELETE FROM users WHERE id = $1', [userId]);
      }
      await client.query('ALTER TABLE access_audit_logs ENABLE TRIGGER access_audit_logs_immutable');
      await client.query('ALTER TABLE invoices ENABLE TRIGGER invoices_billing_guard');
      await client.query('ALTER TABLE billing_transactions ENABLE TRIGGER billing_transactions_immutable');
      await client.query('ALTER TABLE prescriptions ENABLE TRIGGER prescriptions_signed_immutable');
      await client.query('ALTER TABLE prescription_items ENABLE TRIGGER prescription_items_signed_immutable');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await runRefresh();
  }

  let failure;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (server.exitCode !== null) throw new Error(`Servidor de integración terminó: ${serverOutput}`);
      try {
        const healthResponse = await fetch(`${baseUrl}/health`, {
          headers: { 'X-Forwarded-Proto': 'https' },
        });
        if (healthResponse.status === 200) {
          assert.equal(healthResponse.headers.get('x-powered-by'), null);
          assert.match(healthResponse.headers.get('strict-transport-security') || '', /max-age=31536000/);
          ready = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(ready, `servidor de integración no inició: ${serverOutput}`);

    const admin = await createUser('admin', 'admin', 'audit_security');
    const cashier = await createUser('cashier', 'receptionist', 'admissions');
    const doctor = await createUser('doctor', 'doctor', 'doctor');
    const failedLoginPage = await request('admin', '/login');
    const failedLoginResponse = await request('admin', '/login', {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': `SIGEMED-Audit-Test-${shortMarker}`,
      },
      body: new URLSearchParams({
        email: `missing-${marker}@example.invalid`,
        password: crypto.randomBytes(20).toString('hex'),
        _csrf: csrf(await failedLoginPage.text()),
      }),
    });
    assert.equal(failedLoginResponse.status, 401);
    const branch = (await db.query(
      'SELECT id FROM branches WHERE active IS DISTINCT FROM FALSE ORDER BY id LIMIT 1'
    )).rows[0];
    assert.ok(branch, 'se requiere al menos una sede activa');
    fixture.patient = (await db.query(
      `INSERT INTO patients (document_type, dni_document, first_name, last_name)
       VALUES ('cedula', $1, 'Reports', $2) RETURNING id`,
      [`REP-${shortMarker}`, patientMarker]
    )).rows[0].id;
    const specialtyName = `Reports specialty ${marker}`;
    fixture.specialty = (await db.query(
      'INSERT INTO specialties (name) VALUES ($1) RETURNING id',
      [specialtyName]
    )).rows[0].id;
    fixture.doctorProfile = (await db.query(
      `INSERT INTO doctors (code, name, main_specialty, dni_document)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [`RPT-${shortMarker}`, `Reports Doctor ${marker}`, specialtyName, `DOC-${shortMarker}`]
    )).rows[0].id;
    await db.query('INSERT INTO doctor_user_accounts (doctor_id, user_id) VALUES ($1, $2)', [fixture.doctorProfile, fixture.doctor]);
    await db.query(
      'INSERT INTO doctor_specialties (doctor_id, specialty_id, is_primary) VALUES ($1, $2, TRUE)',
      [fixture.doctorProfile, fixture.specialty]
    );
    const reportDate = '1990-01-01';
    const weekday = ['DOMINGO', 'LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO'][
      new Date(`${reportDate}T00:00:00.000Z`).getUTCDay()
    ];
    await db.query(
      `INSERT INTO doctor_schedules
         (doctor_id, branch_id, day_of_week, morning_enabled, morning_start_time, morning_end_time,
          morning_limit, afternoon_enabled, afternoon_limit)
       VALUES ($1, $2, $3, TRUE, '08:00', '12:00', 2, FALSE, 0)`,
      [fixture.doctorProfile, branch.id, weekday]
    );
    fixture.appointment = (await db.query(
      `INSERT INTO appointments
         (patient_id, doctor_id, branch_id, appointment_date, status, time_scheduled,
          duration_minutes, appointment_type)
       VALUES ($1, $2, $3, $4::date, 'Attended', $4::date + TIME '09:00', 20, 'consultation')
       RETURNING id`,
      [fixture.patient, fixture.doctor, branch.id, reportDate]
    )).rows[0].id;
    fixture.consultation = (await db.query(
      `INSERT INTO medical_consultations (patient_id, doctor_id, appointment_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [fixture.patient, fixture.doctor, fixture.appointment]
    )).rows[0].id;
    fixture.studyOrder = (await db.query(
      `INSERT INTO study_orders (consultation_id, study_id, ordered_by_user_id, ordered_at)
       SELECT $1, id, $2, $3::date + TIME '10:00'
       FROM study_catalog ORDER BY id LIMIT 1 RETURNING id`,
      [fixture.consultation, fixture.doctor, reportDate]
    )).rows[0].id;
    fixture.procedure = (await db.query(
      `INSERT INTO minor_procedures (consultation_id, name, performed_by_user_id, performed_at)
       VALUES ($1, 'Reports test procedure', $2, $3::date + TIME '11:00') RETURNING id`,
      [fixture.consultation, fixture.doctor, reportDate]
    )).rows[0].id;
    fixture.invoice = (await db.query(
      `INSERT INTO invoices
         (invoice_number, patient_id, branch_id, currency, exchange_rate_to_usd,
          exchange_rate_units_per_usd, subtotal, total, total_usd, status, issued_at)
       VALUES ($1, $2, $3, 'USD', 1, 1, 20, 20, 20, 'pending', $4::date::timestamptz)
       RETURNING id`,
      [`RPT-${marker}`, fixture.patient, branch.id, reportDate]
    )).rows[0].id;
    await db.query(
      `INSERT INTO billing_transactions
         (invoice_id, branch_id, transaction_type, amount, currency, exchange_rate_to_usd,
          exchange_rate_units_per_usd, amount_usd, received_by_user_id, created_at)
       VALUES ($1, $2, 'payment', 5, 'USD', 1, 1, 5, $3, $4::date + TIME '12:00')`,
      [fixture.invoice, branch.id, fixture.cashier, reportDate]
    );
    await runRefresh();

    await login('admin', admin);
    await login('doctor', doctor);
    const params = new URLSearchParams({ from: reportDate, to: reportDate, branch_id: String(branch.id) });
    const adminReportResponse = await request('admin', `/api/reports/overview?${params}`);
    assert.equal(adminReportResponse.status, 200);
    const adminReport = await adminReportResponse.json();
    assert.equal(adminReport.financialVisible, true);
    assert.ok(adminReport.totals.attended_appointments >= 1);
    assert.ok(adminReport.totals.consultations >= 1);
    assert.ok(adminReport.totals.study_orders >= 1);
    assert.ok(adminReport.totals.procedures >= 1);
    assert.ok(adminReport.specialty.some((row) => row.specialty === specialtyName));
    assert.equal(adminReport.financialTotals.invoiced_usd, 20);
    assert.equal(adminReport.financialTotals.collected_net_usd, 5);
    assert.ok(adminReport.occupancy.some((row) => row.capacity >= 2 && row.booked >= 1),
      JSON.stringify(adminReport.occupancy));
    assert.equal((await request('admin', `/reports?${params}`)).status, 200);

    const clinicalCsv = await request('admin', `/reports/export/clinical/csv?${params}`);
    assert.equal(clinicalCsv.status, 200);
    const clinicalCsvBody = await clinicalCsv.text();
    assert.match(clinicalCsvBody, /consultas_por_especialidad/);
    assert.doesNotMatch(clinicalCsvBody, new RegExp(patientMarker));
    const financialCsv = await request('admin', `/reports/export/financial/csv?${params}`);
    assert.equal(financialCsv.status, 200);
    assert.match(await financialCsv.text(), /20/);
    const clinicalPdf = await request('admin', `/reports/export/clinical/pdf?${params}`);
    assert.equal(clinicalPdf.status, 200);
    assert.equal(Buffer.from(await clinicalPdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');

    await login('cashier', cashier);
    const cashierResponse = await request('cashier', `/api/reports/overview?${params}`);
    assert.equal(cashierResponse.status, 200);
    const cashierReport = await cashierResponse.json();
    assert.equal(cashierReport.financialVisible, false);
    assert.equal(cashierReport.financialTotals, null);
    assert.equal((await request('cashier', `/reports/export/financial/csv?${params}`)).status, 403);
    const operationsCsv = await request('cashier', `/reports/export/clinical/csv?${params}`);
    assert.equal(operationsCsv.status, 200);
    assert.doesNotMatch(await operationsCsv.text(), new RegExp(patientMarker));
    const audited = await db.query(
      `SELECT count(*)::int AS count
       FROM access_audit_logs
       WHERE user_id = $1 AND event_type = 'report_export'`,
      [fixture.admin]
    );
    assert.equal(audited.rows[0].count, 3);

    const historyResponse = await request('doctor', `/patients/${fixture.patient}/history`);
    assert.equal(historyResponse.status, 200);
    const historyHtml = await historyResponse.text();
    const clinicalCsrf = csrf(historyHtml);
    const soapResponse = await request('doctor', `/patients/${fixture.patient}/soap`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        _csrf: clinicalCsrf,
        consultation_id: String(fixture.consultation),
        chief_complaint: 'Control de integración',
        objective: 'Signos estables',
        assessment: 'Seguimiento clínico',
        plan: 'Continuar seguimiento',
      }),
    });
    assert.equal(soapResponse.status, 302);

    const prescriptionUrl = `/patients/${fixture.patient}/consultations/${fixture.consultation}/prescriptions`;
    const createPrescription = async (medicationName) => request('doctor', prescriptionUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        _csrf: clinicalCsrf,
        'items[0][medication_name]': medicationName,
        'items[0][dose]': '1 unidad',
        'items[0][frequency]': 'Cada 24 horas',
      }),
    });
    assert.equal((await createPrescription(`Integración ${shortMarker}`)).status, 302);
    let draftPrescription = (await db.query(
      `SELECT id FROM prescriptions
       WHERE consultation_id = $1 AND prescribed_by_user_id = $2 AND status = 'draft'
       ORDER BY id DESC LIMIT 1`,
      [fixture.consultation, fixture.doctor]
    )).rows[0];
    assert.ok(draftPrescription);
    const signResponse = await request(
      'doctor',
      `/patients/${fixture.patient}/prescriptions/${draftPrescription.id}/sign`,
      {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ _csrf: clinicalCsrf, confirm_prescription: 'on' }),
      }
    );
    assert.equal(signResponse.status, 302);
    assert.equal((await request(
      'doctor',
      `/patients/${fixture.patient}/prescriptions/${draftPrescription.id}/pdf`
    )).status, 200);

    assert.equal((await createPrescription(`Cancelación ${shortMarker}`)).status, 302);
    draftPrescription = (await db.query(
      `SELECT id FROM prescriptions
       WHERE consultation_id = $1 AND prescribed_by_user_id = $2 AND status = 'draft'
       ORDER BY id DESC LIMIT 1`,
      [fixture.consultation, fixture.doctor]
    )).rows[0];
    assert.ok(draftPrescription);
    assert.equal((await request(
      'doctor',
      `/patients/${fixture.patient}/prescriptions/${draftPrescription.id}/cancel`,
      {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ _csrf: clinicalCsrf }),
      }
    )).status, 302);
    assert.equal((await request(
      'doctor',
      `/patients/${fixture.patient}/full-history/${fixture.consultation}`
    )).status, 200);
    const logoutResponse = await request('doctor', '/logout', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: clinicalCsrf }),
    });
    assert.equal(logoutResponse.status, 302);
    const auditSummary = await db.query(
      `SELECT event_type, count(*)::int AS count
       FROM access_audit_logs
       WHERE user_id = $1 AND event_type IN ('auth_login_success', 'report_view')
       GROUP BY event_type`,
      [fixture.admin]
    );
    const adminAuditCounts = new Map(auditSummary.rows.map((row) => [row.event_type, row.count]));
    assert.equal(adminAuditCounts.get('auth_login_success'), 1);
    assert.ok(adminAuditCounts.get('report_view') >= 2);
    const failedLoginAudit = await db.query(
      `SELECT count(*)::int AS count
       FROM access_audit_logs
       WHERE event_type = 'auth_login_failure'
         AND details->>'reason' = 'invalid_credentials'`,
    );
    assert.ok(failedLoginAudit.rows[0].count >= 1);
    const doctorHistoryAudit = await db.query(
      `SELECT id FROM access_audit_logs
       WHERE user_id = $1 AND event_type = 'clinical_history_view'
         AND patient_id = $2 ORDER BY id DESC LIMIT 1`,
      [fixture.doctor, fixture.patient]
    );
    assert.equal(doctorHistoryAudit.rows.length, 1);
    const clinicalAudit = await db.query(
      `SELECT event_type, count(*)::int AS count
       FROM access_audit_logs
       WHERE user_id = $1 AND patient_id = $2
         AND event_type IN (
           'clinical_soap_saved', 'prescription_created', 'prescription_signed',
           'prescription_cancelled', 'clinical_prescription_pdf_view', 'clinical_history_pdf_view'
         )
       GROUP BY event_type`,
      [fixture.doctor, fixture.patient]
    );
    const clinicalAuditCounts = new Map(clinicalAudit.rows.map((row) => [row.event_type, row.count]));
    assert.equal(clinicalAuditCounts.get('clinical_soap_saved'), 1);
    assert.equal(clinicalAuditCounts.get('prescription_created'), 2);
    assert.equal(clinicalAuditCounts.get('prescription_signed'), 1);
    assert.equal(clinicalAuditCounts.get('prescription_cancelled'), 1);
    assert.equal(clinicalAuditCounts.get('clinical_prescription_pdf_view'), 1);
    assert.equal(clinicalAuditCounts.get('clinical_history_pdf_view'), 1);
    const doctorLogout = await db.query(
      `SELECT count(*)::int AS count
       FROM access_audit_logs
       WHERE user_id = $1 AND event_type = 'auth_logout'`,
      [fixture.doctor]
    );
    assert.equal(doctorLogout.rows[0].count, 1);
    await assert.rejects(
      db.query('UPDATE access_audit_logs SET details = $2::jsonb WHERE id = $1', [
        doctorHistoryAudit.rows[0].id, JSON.stringify({ tampered: true }),
      ]),
      /Audit records are immutable/
    );
    await assert.rejects(
      db.query('DELETE FROM access_audit_logs WHERE id = $1', [doctorHistoryAudit.rows[0].id]),
      /Audit records are immutable/
    );
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (server.exitCode === null) server.kill();
    await new Promise((resolve) => {
      if (server.exitCode !== null) resolve();
      else {
        server.once('exit', resolve);
        setTimeout(resolve, 2000);
      }
    });
    try {
      await cleanup();
    } catch (error) {
      if (!failure) throw error;
      console.error('No se pudo limpiar el fixture de reportería:', error.message);
    } finally {
      await db.end();
    }
  }
});
