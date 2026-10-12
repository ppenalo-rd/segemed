const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

test('flujo autenticado de facturación, cobros multimoneda, reversos e inmutabilidad', {
  skip: process.env.SIGEMED_BILLING_INTEGRATION !== '1',
}, async () => {
  require('dotenv').config();
  const db = require('../db');
  const root = require('node:path').join(__dirname, '..');
  const probe = require('node:net').createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const server = spawn(process.execPath, ['index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  server.stdout.on('data', (chunk) => { serverOutput += chunk; });
  server.stderr.on('data', (chunk) => { serverOutput += chunk; });

  const marker = crypto.randomUUID();
  const emails = [];
  const ids = {};
  const cookies = { admin: '', cashier: '', doctor: '' };
  const baseUrl = `http://127.0.0.1:${port}`;

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
        ...(options.headers || {}),
        ...(cookies[actor] ? { Cookie: cookies[actor] } : {}),
      },
    });
    saveCookies(actor, response);
    return response;
  }

  function csrf(html) {
    const match = html.match(/name="_csrf" value="([^"]+)"/);
    assert.ok(match, 'la vista autenticada debe incluir token CSRF');
    return match[1];
  }

  async function post(actor, path, values, token, expectedStatus = 302) {
    const response = await request(actor, path, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...values, _csrf: token }),
    });
    assert.equal(response.status, expectedStatus, `${path}: ${await response.text()}`);
    return response;
  }

  async function createUser(roleKey, userRole, label) {
    const email = `${label}-${marker}@example.invalid`;
    const password = crypto.randomBytes(18).toString('hex');
    const result = await db.query(
      `INSERT INTO users (name, email, password_hash, role, active)
       VALUES ($1, $2, $3, $4, TRUE) RETURNING id`,
      [label, email, await bcrypt.hash(password, 4), userRole]
    );
    const id = result.rows[0].id;
    await db.query(
      'INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE role_key = $2',
      [id, roleKey]
    );
    emails.push(email);
    return { id, email, password };
  }

  async function login(actor, user) {
    const page = await request(actor, '/login');
    const token = csrf(await page.text());
    await post(actor, '/login', { email: user.email, password: user.password }, token);
  }

  async function cleanup() {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE access_audit_logs DISABLE TRIGGER access_audit_logs_immutable');
      await client.query('ALTER TABLE invoices DISABLE TRIGGER invoices_billing_guard');
      await client.query('ALTER TABLE invoice_items DISABLE TRIGGER invoice_items_billing_guard');
      await client.query('ALTER TABLE billing_transactions DISABLE TRIGGER billing_transactions_immutable');
      await client.query('ALTER TABLE billing_audit_events DISABLE TRIGGER billing_audit_events_immutable');
      await client.query('ALTER TABLE billing_exchange_rates DISABLE TRIGGER billing_exchange_rates_immutable');
      await client.query(
        'DELETE FROM access_audit_logs WHERE user_id = ANY($1::int[]) OR patient_id = $2',
        [[ids.admin, ids.cashier, ids.doctor].filter(Boolean), ids.patient || -1]
      );
      if (ids.invoice) {
        await client.query('DELETE FROM billing_audit_events WHERE invoice_id = $1', [ids.invoice]);
        await client.query('DELETE FROM billing_transactions WHERE invoice_id = $1', [ids.invoice]);
        await client.query('DELETE FROM invoice_items WHERE invoice_id = $1', [ids.invoice]);
        await client.query('DELETE FROM invoices WHERE id = $1', [ids.invoice]);
      }
      if (ids.procedure) await client.query('DELETE FROM minor_procedures WHERE id = $1', [ids.procedure]);
      if (ids.studyOrder) await client.query('DELETE FROM study_orders WHERE id = $1', [ids.studyOrder]);
      if (ids.consultation) await client.query('DELETE FROM medical_consultations WHERE id = $1', [ids.consultation]);
      if (ids.patient) await client.query('DELETE FROM patients WHERE id = $1', [ids.patient]);
      if (ids.services?.length) {
        await client.query('DELETE FROM billing_service_prices WHERE service_id = ANY($1::int[])', [ids.services]);
        await client.query('DELETE FROM billing_services WHERE id = ANY($1::int[])', [ids.services]);
      }
      if (ids.currency) {
        await client.query('DELETE FROM billing_exchange_rates WHERE source LIKE $1', [`Integration test ${marker}%`]);
      }
      for (const email of emails) {
        await client.query('DELETE FROM session WHERE sess::text LIKE $1', [`%${email}%`]);
      }
      for (const userId of [ids.admin, ids.cashier, ids.doctor].filter(Boolean)) {
        await client.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
        await client.query('DELETE FROM users WHERE id = $1', [userId]);
      }
      await client.query('ALTER TABLE invoices ENABLE TRIGGER invoices_billing_guard');
      await client.query('ALTER TABLE invoice_items ENABLE TRIGGER invoice_items_billing_guard');
      await client.query('ALTER TABLE billing_transactions ENABLE TRIGGER billing_transactions_immutable');
      await client.query('ALTER TABLE billing_audit_events ENABLE TRIGGER billing_audit_events_immutable');
      await client.query('ALTER TABLE billing_exchange_rates ENABLE TRIGGER billing_exchange_rates_immutable');
      await client.query('ALTER TABLE access_audit_logs ENABLE TRIGGER access_audit_logs_immutable');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  let failure;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (server.exitCode !== null) throw new Error(`Servidor de integración terminó prematuramente: ${serverOutput}`);
      try {
        if ((await fetch(`${baseUrl}/health`)).status === 200) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(ready, `servidor de integración no inició: ${serverOutput}`);

    const admin = await createUser('system_admin', 'admin', 'Billing admin test');
    ids.admin = admin.id;
    const cashier = await createUser('admissions', 'receptionist', 'Billing cashier test');
    ids.cashier = cashier.id;
    const doctor = await createUser('doctor', 'doctor', 'Billing doctor test');
    ids.doctor = doctor.id;
    const branch = (await db.query('SELECT id FROM branches WHERE active IS DISTINCT FROM FALSE ORDER BY id LIMIT 1')).rows[0];
    assert.ok(branch);
    const patient = await db.query(
      `INSERT INTO patients (document_type, dni_document, first_name, last_name)
       VALUES ('cedula', $1, 'Billing', 'Integration') RETURNING id`,
      [`BILL-${marker}`]
    );
    ids.patient = patient.rows[0].id;
    ids.consultation = (await db.query(
      'INSERT INTO medical_consultations (patient_id) VALUES ($1) RETURNING id',
      [ids.patient]
    )).rows[0].id;
    ids.studyOrder = (await db.query(
      `INSERT INTO study_orders (consultation_id, study_id, ordered_by_user_id)
       SELECT $1, id, $2 FROM study_catalog ORDER BY id LIMIT 1 RETURNING id`,
      [ids.consultation, ids.doctor]
    )).rows[0].id;
    ids.procedure = (await db.query(
      `INSERT INTO minor_procedures (consultation_id, name, performed_by_user_id)
       VALUES ($1, 'Billing test procedure', $2) RETURNING id`,
      [ids.consultation, ids.doctor]
    )).rows[0].id;

    await login('admin', admin);
    const adminPage = await request('admin', '/admin/billing');
    assert.equal(adminPage.status, 200);
    const adminHtml = await adminPage.text();
    assert.match(adminHtml, /Moneda base del sistema: <strong>VES<\/strong>/);
    assert.match(adminHtml, /Unidades por 1 USD/);
    const adminToken = csrf(adminHtml);
    ids.currency = 'VES';
    const localDate = new Date(Date.now() - 60_000);
    const localStamp = `${localDate.getFullYear()}-${String(localDate.getMonth() + 1).padStart(2, '0')}-${String(localDate.getDate()).padStart(2, '0')}T${String(localDate.getHours()).padStart(2, '0')}:${String(localDate.getMinutes()).padStart(2, '0')}`;
    await post('admin', '/admin/billing/exchange-rates', {
      currency_code: ids.currency, units_per_usd: '876.7976', effective_at: localStamp,
      source: `Integration test ${marker} BCV rate`,
    }, adminToken);

    ids.services = [];
    for (const [type, name, price] of [
      ['consultation', 'Consultation test', '20.00'],
      ['procedure', 'Procedure test', '10.00'],
      ['study', 'Study test', '20.00'],
    ]) {
      const serviceCode = `T${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
      await post('admin', '/admin/billing/services', {
        code: serviceCode, name: `${name} ${marker}`, service_type: type,
      }, adminToken);
      const serviceId = (await db.query('SELECT id FROM billing_services WHERE code = $1', [serviceCode])).rows[0].id;
      ids.services.push(serviceId);
      await post('admin', `/admin/billing/services/${serviceId}/prices/${branch.id}`, {
        price_usd: price, active: 'true',
      }, adminToken);
    }
    const adminBillingPage = await request('admin', '/billing');
    assert.equal(adminBillingPage.status, 200, 'administración debe poder consultar el módulo de facturación');
    const adminBillingHtml = await adminBillingPage.text();
    assert.match(adminBillingHtml, /Acceso de consulta/);
    assert.doesNotMatch(adminBillingHtml, /Crear borrador de factura/);
    assert.equal((await post('admin', '/billing/invoices', {
      patient_id: String(ids.patient), branch_id: String(branch.id), currency: 'USD',
    }, adminToken, 403)).status, 403, 'admin no debe procesar cobros');
    await login('cashier', cashier);
    assert.equal((await request('cashier', '/admin/billing')).status, 403, 'caja no debe editar catálogo o tasas');
    assert.equal((await request('cashier', '/billing')).status, 200);
    await login('doctor', doctor);
    assert.equal((await request('doctor', '/billing')).status, 403, 'médico no debe procesar cobros');

    const cashierPage = await request('cashier', '/billing');
    const cashierToken = csrf(await cashierPage.text());
    await post('cashier', '/billing/invoices', {
      patient_id: String(ids.patient), branch_id: String(branch.id), currency: 'USD',
    }, cashierToken, 400);
    await post('cashier', '/billing/invoices', {
      patient_id: String(ids.patient), branch_id: String(branch.id), currency: ids.currency,
    }, cashierToken);
    ids.invoice = Number((await db.query(
      `SELECT id FROM invoices WHERE patient_id = $1 AND created_by_user_id = $2 ORDER BY id DESC LIMIT 1`,
      [ids.patient, ids.cashier]
    )).rows[0]?.id);
    assert.ok(ids.invoice);
    assert.equal((await request('cashier', `/billing/invoices/${ids.invoice}`)).status, 200);
    const adminInvoiceResponse = await request('admin', `/billing/invoices/${ids.invoice}`);
    assert.equal(adminInvoiceResponse.status, 200, 'administración puede consultar el detalle de factura');
    const adminInvoiceHtml = await adminInvoiceResponse.text();
    assert.match(adminInvoiceHtml, /Acceso de consulta/);
    assert.doesNotMatch(adminInvoiceHtml, /Agregar servicio \(borrador\)|Registrar abono|Emitir factura y congelar importes/);
    for (const [serviceId, source] of [
      [ids.services[0], `consultation:${ids.consultation}`],
      [ids.services[1], `procedure:${ids.procedure}`],
      [ids.services[2], `study:${ids.studyOrder}`],
    ]) {
      await post('cashier', `/billing/invoices/${ids.invoice}/items`, {
        service_id: String(serviceId), quantity: '1', source_ref: source,
      }, cashierToken);
    }
    let invoice = (await db.query(
      `SELECT status, currency, exchange_rate_to_usd, exchange_rate_units_per_usd,
              subtotal, total, total_usd
       FROM invoices WHERE id = $1`,
      [ids.invoice]
    )).rows[0];
    assert.equal(invoice.status, 'draft');
    assert.equal(invoice.currency, 'VES');
    assert.equal(invoice.subtotal, '43839.88');
    assert.equal(invoice.total_usd, '50.00');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM invoice_items WHERE invoice_id = $1', [ids.invoice])).rows[0].n, 3);

    await post('cashier', `/billing/invoices/${ids.invoice}/issue`, {}, cashierToken);
    invoice = (await db.query('SELECT status, invoice_number, issued_by_user_id FROM invoices WHERE id = $1', [ids.invoice])).rows[0];
    assert.equal(invoice.status, 'pending');
    assert.ok(invoice.invoice_number);
    assert.equal(invoice.issued_by_user_id, ids.cashier);
    const issuedAmounts = (await db.query(
      `SELECT exchange_rate_to_usd, exchange_rate_units_per_usd, total, total_usd
       FROM invoices WHERE id = $1`,
      [ids.invoice]
    )).rows[0];
    assert.equal(issuedAmounts.exchange_rate_to_usd, '0.00114051');
    assert.equal(issuedAmounts.exchange_rate_units_per_usd, '876.79760000');
    assert.equal(issuedAmounts.total, '43839.88');
    assert.equal(issuedAmounts.total_usd, '50.00');
    await post('cashier', `/billing/invoices/${ids.invoice}/items`, {
      service_id: String(ids.services[0]), quantity: '1', source_ref: `consultation:${ids.consultation}`,
    }, cashierToken, 409);
    await post('admin', `/billing/invoices/${ids.invoice}/payments`, {
      amount: '1', currency: 'USD',
    }, adminToken, 403);
    await post('cashier', `/billing/invoices/${ids.invoice}/payments`, {
      amount: '8767.98', currency: ids.currency, reference: 'partial payment',
    }, cashierToken);
    assert.equal((await db.query('SELECT status FROM invoices WHERE id = $1', [ids.invoice])).rows[0].status, 'pending');
    await post('cashier', `/billing/invoices/${ids.invoice}/payments`, {
    amount: '35080.68', currency: ids.currency,
    }, cashierToken, 409);
    await post('cashier', `/billing/invoices/${ids.invoice}/payments`, {
    amount: '35071.90', currency: ids.currency,
    }, cashierToken);
    assert.equal((await db.query('SELECT status FROM invoices WHERE id = $1', [ids.invoice])).rows[0].status, 'paid');
    const currentDate = new Date();
    const currentStamp = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-${String(currentDate.getDate()).padStart(2, '0')}T${String(currentDate.getHours()).padStart(2, '0')}:${String(currentDate.getMinutes()).padStart(2, '0')}`;
    await post('admin', '/admin/billing/exchange-rates', {
      currency_code: ids.currency, units_per_usd: '900', effective_at: currentStamp,
      source: `Integration test ${marker} Updated BCV rate`,
    }, adminToken);
    const immutableInvoiceRate = (await db.query(
      'SELECT exchange_rate_units_per_usd, total FROM invoices WHERE id = $1',
      [ids.invoice]
    )).rows[0];
    assert.equal(immutableInvoiceRate.exchange_rate_units_per_usd, '876.79760000');
    assert.equal(immutableInvoiceRate.total, '43839.88');
    const pdf = await request('cashier', `/billing/invoices/${ids.invoice}/print`);
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers.get('content-type'), /application\/pdf/);
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');

    await assert.rejects(
      db.query('UPDATE invoices SET total = 1 WHERE id = $1', [ids.invoice]),
      (error) => error.message.includes('immutable')
    );
    const itemId = (await db.query('SELECT id FROM invoice_items WHERE invoice_id = $1 LIMIT 1', [ids.invoice])).rows[0].id;
    await assert.rejects(
      db.query('UPDATE invoice_items SET line_total = 0 WHERE id = $1', [itemId]),
      (error) => error.message.includes('immutable')
    );
    const transactions = (await db.query(
      'SELECT id FROM billing_transactions WHERE invoice_id = $1 ORDER BY id',
      [ids.invoice]
    )).rows;
    await assert.rejects(
      db.query('UPDATE billing_transactions SET amount = 1 WHERE id = $1', [transactions[0].id]),
      (error) => error.message.includes('immutable')
    );
    await post('cashier', `/billing/invoices/${ids.invoice}/transactions/${transactions[1].id}/refund`, {}, cashierToken);
    assert.equal((await db.query('SELECT status FROM invoices WHERE id = $1', [ids.invoice])).rows[0].status, 'pending');
    await post('cashier', `/billing/invoices/${ids.invoice}/void`, {}, cashierToken, 409);
    await post('cashier', `/billing/invoices/${ids.invoice}/transactions/${transactions[0].id}/refund`, {}, cashierToken);
    await post('cashier', `/billing/invoices/${ids.invoice}/void`, {}, cashierToken);
    assert.equal((await db.query('SELECT status FROM invoices WHERE id = $1', [ids.invoice])).rows[0].status, 'void');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM billing_audit_events WHERE invoice_id = $1', [ids.invoice])).rows[0].n, 10);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (server.exitCode === null) server.kill();
    await new Promise((resolve) => {
      if (server.exitCode !== null) resolve();
      else {
        server.once('exit', resolve);
        setTimeout(resolve, 2_000);
      }
    });
    try {
      await cleanup();
    } catch (error) {
      if (!failure) throw error;
      console.error('No se pudo limpiar el fixture de facturación:', error.message);
    } finally {
      await db.end();
    }
  }
});
