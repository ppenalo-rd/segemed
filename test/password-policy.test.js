const test = require('node:test');
const assert = require('node:assert/strict');
const { validateNewPassword } = require('../services/password-policy');

test('accepts a confirmed password meeting the strength requirements', () => {
  assert.equal(validateNewPassword('ClinicaSegura2026', 'ClinicaSegura2026'), null);
});

test('rejects missing, mismatched, short, weak, and bcrypt-overlong passwords', () => {
  assert.match(validateNewPassword(undefined, ''), /contraseña y su confirmación/);
  assert.match(validateNewPassword('ClinicaSegura2026', 'ClinicaSegura2025'), /no coinciden/);
  assert.match(validateNewPassword('Clinica2026', 'Clinica2026'), /12 caracteres/);
  assert.match(validateNewPassword('clinicasegura2026', 'clinicasegura2026'), /mayúscula/);
  assert.match(validateNewPassword('Á'.repeat(37) + 'aA1', 'Á'.repeat(37) + 'aA1'), /72 bytes/);
});
