const nodemailer = require('nodemailer');

function createEmailTransport(env = process.env) {
  const host = env.SMTP_HOST;
  const port = Number(env.SMTP_PORT || 587);
  const user = env.SMTP_USER;
  const pass = env.SMTP_PASSWORD;
  const from = env.SMTP_FROM;

  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !user || !pass || !from) {
    throw new Error('Configura SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD y SMTP_FROM para enviar códigos 2FA.');
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: env.SMTP_SECURE === 'true' || port === 465,
    auth: { user, pass },
    requireTLS: env.SMTP_REQUIRE_TLS !== 'false' && port !== 465,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

async function sendLoginOtp({ to, name, code, expiresMinutes = 5 }, env = process.env) {
  const transport = createEmailTransport(env);
  const safeName = escapeHtml(name || 'usuario');
  await transport.sendMail({
    from: env.SMTP_FROM,
    to,
    subject: 'Código de verificación de SIGEMED',
    text: `Hola ${name || 'usuario'}, tu código de verificación es ${code}. Vence en ${expiresMinutes} minutos. Si no solicitaste este acceso, ignora este mensaje.`,
    html: `<p>Hola ${safeName},</p><p>Tu código de verificación de SIGEMED es:</p><p style="font-size:28px;font-weight:bold;letter-spacing:8px">${code}</p><p>Este código vence en ${expiresMinutes} minutos. Si no solicitaste este acceso, ignora este mensaje.</p>`,
  });
}

async function sendPasswordChangeOtp({ to, name, code, expiresMinutes = 5 }, env = process.env) {
  const transport = createEmailTransport(env);
  const safeName = escapeHtml(name || 'usuario');
  await transport.sendMail({
    from: env.SMTP_FROM,
    to,
    subject: 'Verificación para cambio de contraseña SIGEMED',
    text: `Hola ${name || 'usuario'}, el código para cambiar tu contraseña de SIGEMED es ${code}. Vence en ${expiresMinutes} minutos. Si no solicitaste este cambio, ignora este mensaje y contacta al administrador.`,
    html: `<p>Hola ${safeName},</p><p>Se solicitó un cambio de contraseña para tu cuenta SIGEMED. Introduce este código para confirmarlo:</p><p style="font-size:28px;font-weight:bold;letter-spacing:8px">${code}</p><p>Este código vence en ${expiresMinutes} minutos. Si no solicitaste este cambio, ignora este mensaje y contacta al administrador.</p>`,
  });
}

module.exports = {
  createEmailTransport,
  sendLoginOtp,
  sendPasswordChangeOtp,
};
