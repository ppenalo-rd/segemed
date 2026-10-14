const test = require('node:test');
const assert = require('node:assert/strict');
const { createSoapCsrfClient } = require('../public/js/soap-csrf');

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => 'application/json; charset=utf-8' },
    async json() { return body; },
  };
}

test('sincroniza CSRF con heartbeat y propaga cookie de sesión a la petición SOAP', async () => {
  const calls = [];
  let token = 'stale-token';
  const client = createSoapCsrfClient({
    getToken: () => token,
    setToken: (nextToken) => { token = nextToken; },
    async fetchImpl(url, options) {
      calls.push({ url, options });
      return url === '/auth/session/heartbeat'
        ? jsonResponse(200, { csrfToken: 'current-token' })
        : jsonResponse(200, { saved: true });
    },
  });

  const result = await client.request('/patients/7/soap-draft', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: {} }),
  });

  assert.equal(result.result.saved, true);
  assert.equal(token, 'current-token');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(calls[1].options.credentials, 'same-origin');
  assert.equal(calls[1].options.headers['X-CSRF-Token'], 'current-token');
});

test('refresca y reintenta una sola vez solo ante rechazo explícito de token CSRF', async () => {
  const calls = [];
  let heartbeatCount = 0;
  let token = '';
  const client = createSoapCsrfClient({
    getToken: () => token,
    setToken: (nextToken) => { token = nextToken; },
    async fetchImpl(url, options) {
      calls.push({ url, options });
      if (url === '/auth/session/heartbeat') {
        heartbeatCount += 1;
        return jsonResponse(200, { csrfToken: `token-${heartbeatCount}` });
      }
      return options.headers['X-CSRF-Token'] === 'token-2'
        ? jsonResponse(200, { verified: true })
        : jsonResponse(403, { error: 'csrf_token_mismatch' });
    },
  });

  const result = await client.request('/patients/7/consultations/11/soap-edit-otp/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ soap_data: {} }),
  });

  assert.equal(result.result.verified, true);
  assert.equal(heartbeatCount, 2);
  assert.equal(calls.filter((call) => call.url.includes('/soap-edit-otp/request')).length, 2);
  assert.equal(calls[1].options.headers['X-CSRF-Token'], 'token-1');
  assert.equal(calls[3].options.headers['X-CSRF-Token'], 'token-2');
});

test('no reintenta una respuesta 403 que no sea un rechazo CSRF explícito', async () => {
  const calls = [];
  const client = createSoapCsrfClient({
    getToken: () => '',
    setToken() {},
    async fetchImpl(url) {
      calls.push(url);
      return url === '/auth/session/heartbeat'
        ? jsonResponse(200, { csrfToken: 'current-token' })
        : jsonResponse(403, { error: 'forbidden' });
    },
  });

  const result = await client.request('/patients/7/soap-draft', { method: 'DELETE' });

  assert.equal(result.response.status, 403);
  assert.equal(result.result.error, 'forbidden');
  assert.equal(calls.filter((url) => url !== '/auth/session/heartbeat').length, 1);
  assert.equal(calls.filter((url) => url === '/auth/session/heartbeat').length, 1);
});

test('no reintenta otros errores HTTP y comunica sesión expirada al no recibir heartbeat JSON', async () => {
  let requestCount = 0;
  const client = createSoapCsrfClient({
    getToken: () => 'token',
    setToken() {},
    async fetchImpl(url) {
      if (url === '/auth/session/heartbeat') {
        return {
          status: 200,
          ok: true,
          headers: { get: () => 'text/html' },
          async json() { return {}; },
        };
      }
      requestCount += 1;
      return jsonResponse(403, { error: 'forbidden' });
    },
  });

  await assert.rejects(
    client.request('/patients/7/soap-draft', { method: 'PUT' }),
    { code: 'session_expired', message: 'session_expired' }
  );
  assert.equal(requestCount, 0);
});
