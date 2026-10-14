(function exposeSoapCsrf(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.SIGEMEDSoapCsrf = api;
  }
}(globalThis, () => {
  function createSoapCsrfClient({ fetchImpl, getToken, setToken, heartbeatUrl = '/auth/session/heartbeat' }) {
    async function refreshToken() {
      const response = await fetchImpl(heartbeatUrl, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      const contentType = response.headers.get('content-type') || '';
      if (!response.ok || !contentType.includes('application/json')) {
        const error = new Error('session_expired');
        error.code = 'session_expired';
        throw error;
      }
      const result = await response.json();
      if (typeof result.csrfToken !== 'string' || !result.csrfToken) {
        throw new Error('No se pudo sincronizar el token de seguridad de la sesión.');
      }
      setToken(result.csrfToken);
      return result.csrfToken;
    }

    async function send(url, options, csrfToken) {
      const headers = { ...(options.headers || {}), 'X-CSRF-Token': csrfToken };
      return fetchImpl(url, {
        ...options,
        credentials: 'same-origin',
        cache: 'no-store',
        headers,
      });
    }

    async function request(url, options) {
      let csrfToken = await refreshToken();
      let response = await send(url, options, csrfToken);
      let result = await response.json().catch(() => ({}));

      if (response.status === 403 && result.error === 'csrf_token_mismatch') {
        csrfToken = await refreshToken();
        response = await send(url, options, csrfToken);
        result = await response.json().catch(() => ({}));
      }

      if (response.status === 401 && result.error === 'session_expired') {
        const error = new Error('session_expired');
        error.code = 'session_expired';
        throw error;
      }
      if (!response.headers.get('content-type')?.includes('application/json')) {
        const error = new Error('session_expired');
        error.code = 'session_expired';
        throw error;
      }
      return { response, result, csrfToken: getToken() };
    }

    return { refreshToken, request };
  }

  return { createSoapCsrfClient };
}));
