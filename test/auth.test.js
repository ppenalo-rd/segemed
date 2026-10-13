const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const path = require('node:path');
const { startSmtpSink } = require('../test-support/smtp-sink');
require('dotenv').config();
const { canAssignRole } = require('../auth');

test('administradores del sistema pueden asignar perfiles activos', () => {
  assert.equal(canAssignRole(['system_admin'], 'system_admin'), true);
  assert.equal(canAssignRole(['system_admin'], 'audit_security'), true);
});

test('auditoría puede asignar perfiles operativos, pero no privilegios administrativos', () => {
  assert.equal(canAssignRole(['audit_security'], 'doctor'), true);
  assert.equal(canAssignRole(['audit_security'], 'admissions'), true);
  assert.equal(canAssignRole(['audit_security'], 'nurse'), true);
  assert.equal(canAssignRole(['audit_security'], 'patient'), true);
  assert.equal(canAssignRole(['audit_security'], 'system_admin'), false);
  assert.equal(canAssignRole(['audit_security'], 'audit_security'), false);
});

test('otros perfiles no pueden asignar roles', () => {
  assert.equal(canAssignRole(['doctor'], 'admissions'), false);
  assert.equal(canAssignRole([], 'doctor'), false);
});

test('producción rechaza secretos de sesión ausentes, cortos o de ejemplo', () => {
  const root = path.join(__dirname, '..');
  for (const secret of [undefined, 'too-short', 'replace-with-a-long-random-secret', 'change-me'.padEnd(40, 'x')]) {
    const env = { ...process.env, NODE_ENV: 'production' };
    if (secret === undefined) delete env.SESSION_SECRET;
    else env.SESSION_SECRET = secret;
    const result = spawnSync(process.execPath, ['index.js'], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.notEqual(result.status, 0, `el secreto ${secret || '<ausente>'} debe rechazarse`);
    assert.match(`${result.stdout}${result.stderr}`, /SESSION_SECRET/);
  }
});

test('dashboard post-login redirige y filtra módulos según los roles', {
  skip: process.env.SIGEMED_AUTH_INTEGRATION !== '1',
}, async () => {
  require('dotenv').config();
  const db = require('../db');
  const root = path.join(__dirname, '..');
  const marker = crypto.randomUUID();
  const actors = [
    { key: 'admin', baseRole: 'admin', role: 'system_admin', expected: ['admissions', 'medical', 'billing', 'reports', 'administration'] },
    { key: 'admissions', baseRole: 'receptionist', role: 'admissions', expected: ['admissions', 'billing'] },
    { key: 'doctor', baseRole: 'doctor', role: 'doctor', expected: ['medical'] },
    { key: 'nurse', baseRole: 'receptionist', role: 'nurse', expected: ['medical'] },
    { key: 'audit', baseRole: 'admin', role: 'audit_security', expected: ['reports'] },
  ];
  const users = [];
  const sessions = new Map();
  const smtpSink = await startSmtpSink();
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
      NODE_ENV: 'development',
      PORT: String(port),
      SESSION_SECRET: crypto.randomBytes(48).toString('hex'),
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(smtpSink.port),
      SMTP_REQUIRE_TLS: 'false',
      SMTP_USER: 'test-user',
      SMTP_PASSWORD: 'test-password',
      SMTP_FROM: 'SIGEMED Tests <no-reply@example.invalid>',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  server.stdout.on('data', (chunk) => { serverOutput += chunk; });
  server.stderr.on('data', (chunk) => { serverOutput += chunk; });

  function saveCookie(actor, response) {
    const headers = response.headers.getSetCookie?.() || [response.headers.get('set-cookie')].filter(Boolean);
    for (const header of headers) {
      const pair = header.split(';')[0];
      const name = pair.split('=')[0];
      const cookie = (sessions.get(actor) || '').split('; ')
        .filter((entry) => entry && entry.split('=')[0] !== name)
        .concat(pair)
        .join('; ');
      sessions.set(actor, cookie);
    }
  }

  async function request(actor, route, options = {}) {
    const response = await fetch(`${baseUrl}${route}`, {
      ...options,
      headers: {
        ...(options.headers || {}),
        ...(sessions.has(actor) ? { Cookie: sessions.get(actor) } : {}),
      },
    });
    saveCookie(actor, response);
    return response;
  }

  async function cleanup() {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE access_audit_logs DISABLE TRIGGER access_audit_logs_immutable');
      const userIds = users.map((user) => user.id);
      if (userIds.length) {
        await client.query('DELETE FROM access_audit_logs WHERE user_id = ANY($1::int[])', [userIds]);
        await client.query('DELETE FROM user_roles WHERE user_id = ANY($1::int[])', [userIds]);
      }
      await client.query("DELETE FROM session WHERE sess::text LIKE $1", [`%${marker}%`]);
      await client.query('ALTER TABLE access_audit_logs ENABLE TRIGGER access_audit_logs_immutable');
      if (userIds.length) await client.query('DELETE FROM users WHERE id = ANY($1::int[])', [userIds]);
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
      if (server.exitCode !== null) throw new Error(`Servidor de integración terminó: ${serverOutput}`);
      try {
        if ((await fetch(`${baseUrl}/health`)).status === 200) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(ready, `servidor de integración no inició: ${serverOutput}`);

    for (const actor of actors) {
      const email = `${actor.key}-${marker}@example.invalid`;
      const password = crypto.randomBytes(24).toString('hex');
      const user = await db.query(
        `INSERT INTO users (name, email, password_hash, role, active)
         VALUES ($1, $2, $3, $4, TRUE) RETURNING id`,
        [`Dashboard ${actor.key}`, email, await bcrypt.hash(password, 4), actor.baseRole]
      );
      const userId = user.rows[0].id;
      users.push({ id: userId, email });
      await db.query(
        'INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE role_key = $2',
        [userId, actor.role]
      );

      const loginPage = await request(actor.key, '/login');
      const loginHtml = await loginPage.text();
      const csrfToken = loginHtml.match(/name="_csrf" value="([^"]+)"/)?.[1];
      assert.ok(csrfToken, 'el formulario de ingreso debe proporcionar el token CSRF');
      const loginResponse = await request(actor.key, '/login', {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email, password, _csrf: csrfToken }),
      });
      assert.equal(loginResponse.status, 302);
      assert.equal(loginResponse.headers.get('location'), '/auth/verify-otp');

      const otpPage = await request(actor.key, '/auth/verify-otp');
      const otpHtml = await otpPage.text();
      const otpCsrfToken = otpHtml.match(/name="_csrf" value="([^"]+)"/)?.[1];
      assert.ok(otpCsrfToken, 'la vista OTP debe proporcionar token CSRF');
      const emailMessage = await smtpSink.nextMessage();
      const otp = emailMessage.match(/\b(\d{6})\b/)?.[1];
      assert.ok(otp, 'el correo de prueba debe contener un código OTP de seis dígitos');
      const verifyResponse = await request(actor.key, '/auth/verify-otp', {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ otp, _csrf: otpCsrfToken }),
      });
      assert.equal(verifyResponse.status, 302);
      assert.equal(verifyResponse.headers.get('location'), '/dashboard');

      const dashboardResponse = await request(actor.key, '/dashboard');
      assert.equal(dashboardResponse.status, 200);
      const dashboardHtml = await dashboardResponse.text();
      const visibleModules = [...dashboardHtml.matchAll(/data-module="([^"]+)"/g)].map((match) => match[1]);
      assert.deepEqual(visibleModules, actor.expected, `módulos visibles para ${actor.role}`);

      const existingSessionLoginPage = await request(actor.key, '/login', { redirect: 'manual' });
      assert.equal(existingSessionLoginPage.status, 302);
      assert.equal(existingSessionLoginPage.headers.get('location'), '/dashboard');
    }
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
      console.error('No se pudieron limpiar los fixtures de autenticación:', error.message);
    } finally {
      await smtpSink.close();
      await db.end();
    }
  }
});
