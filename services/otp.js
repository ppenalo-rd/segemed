const crypto = require('node:crypto');

const OTP_TTL_MINUTES = 5;
const OTP_RESEND_COOLDOWN_SECONDS = 60;
const OTP_MAX_ATTEMPTS = 5;

function generateOtp() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashOtp(code, secret) {
  return crypto.createHmac('sha256', secret).update(code).digest('hex');
}

function otpMatches(code, expectedHash, secret) {
  if (!/^\d{6}$/.test(code) || !/^[a-f0-9]{64}$/i.test(expectedHash || '')) return false;
  const submittedHash = Buffer.from(hashOtp(code, secret), 'hex');
  const storedHash = Buffer.from(expectedHash, 'hex');
  return crypto.timingSafeEqual(submittedHash, storedHash);
}

module.exports = {
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_TTL_MINUTES,
  generateOtp,
  hashOtp,
  otpMatches,
};
