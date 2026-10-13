// Applies the password rules shared by self-service and administrative changes.
function validateNewPassword(password, confirmation) {
  if (typeof password !== 'string' || typeof confirmation !== 'string') {
    return 'Ingresa la contraseña y su confirmación.';
  }
  if (password !== confirmation) {
    return 'Las contraseñas no coinciden.';
  }
  if (password.length < 12) {
    return 'La contraseña debe tener al menos 12 caracteres.';
  }
  if (Buffer.byteLength(password, 'utf8') > 72) {
    return 'La contraseña no puede superar los 72 bytes.';
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
    return 'Incluye al menos una mayúscula, una minúscula y un número.';
  }
  return null;
}

module.exports = { validateNewPassword };
