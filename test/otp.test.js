const test = require('node:test');
const assert = require('node:assert/strict');
const {
  generateOtp,
  hashOtp,
  otpMatches,
} = require('../services/otp');
const { createEmailTransport, sendLoginOtp } = require('../services/email');
const { startSmtpSink } = require('../test-support/smtp-sink');

test('genera códigos OTP numéricos de seis dígitos incluyendo ceros iniciales', () => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    assert.match(generateOtp(), /^\d{6}$/);
  }
});

test('verifica OTP con HMAC y comparación de longitud fija', () => {
  const secret = 'test-secret';
  const hash = hashOtp('004219', secret);
  assert.equal(otpMatches('004219', hash, secret), true);
  assert.equal(otpMatches('004218', hash, secret), false);
  assert.equal(otpMatches('4219', hash, secret), false);
  assert.equal(otpMatches('004219', hash, 'other-secret'), false);
});

test('requiere configuración SMTP completa y define TLS seguro por defecto', () => {
  assert.throws(() => createEmailTransport({}), /SMTP_HOST/);
  const transport = createEmailTransport({
    SMTP_HOST: 'smtp.example.test',
    SMTP_PORT: '587',
    SMTP_USER: 'user',
    SMTP_PASSWORD: 'password',
    SMTP_FROM: 'SIGEMED <no-reply@example.test>',
  });
  assert.equal(transport.options.requireTLS, true);
  assert.equal(transport.options.secure, false);
});

test('envía el código y escapa el nombre en el correo HTML', async () => {
  const smtpSink = await startSmtpSink();
  try {
    await sendLoginOtp(
      { to: 'user@example.test', name: '<Paciente>', code: '001204' },
      {
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: String(smtpSink.port),
        SMTP_REQUIRE_TLS: 'false',
        SMTP_USER: 'test-user',
        SMTP_PASSWORD: 'test-password',
        SMTP_FROM: 'SIGEMED Tests <no-reply@example.test>',
      }
    );
    const message = await smtpSink.nextMessage();
    assert.match(message, /001204/);
    assert.match(message, /&lt;Paciente&gt;/);
    assert.doesNotMatch(message, /<p>Hola <Paciente>/);
  } finally {
    await smtpSink.close();
  }
});
