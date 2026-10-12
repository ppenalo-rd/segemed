const test = require('node:test');
const assert = require('node:assert/strict');
const {
  convertCurrencyToUsd,
  convertUsdToCurrency,
  normalizeCurrency,
  normalizeExchangeRate,
  normalizeMoney,
  normalizeQuantity,
  normalizeService,
} = require('../services/billing');

test('normaliza moneda, tasa e importes para facturación', () => {
  assert.equal(normalizeCurrency(' usd '), 'USD');
  assert.equal(normalizeExchangeRate('1.25000000'), '1.25000000');
  assert.equal(normalizeMoney('125'), '125.00');
  assert.equal(normalizeQuantity('2.5'), '2.5');
});

test('rechaza códigos e importes monetarios inválidos', () => {
  assert.throws(() => normalizeCurrency('US'), /tres letras/);
  assert.throws(() => normalizeExchangeRate('0'), /positiva/);
  assert.throws(() => normalizeExchangeRate('876,7976'), /positiva/);
  assert.throws(() => normalizeExchangeRate('1.123456789'), /ocho decimales/);
  assert.throws(() => normalizeMoney('1.001'), /dos decimales/);
  assert.throws(() => normalizeQuantity('0'), /cantidad debe ser positiva/);
});

test('valida el catálogo y su tipo de servicio', () => {
  assert.deepEqual(normalizeService({
    code: ' lab-01 ',
    name: ' Hemograma ',
    service_type: 'study',
    description: 'Estudio hematológico',
  }), {
    code: 'LAB-01',
    name: 'Hemograma',
    serviceType: 'study',
    description: 'Estudio hematológico',
  });
  assert.throws(() => normalizeService({ name: 'X', service_type: 'other' }), /tipo de servicio/);
  assert.throws(() => normalizeService({ name: ' ', service_type: 'consultation' }), /nombre/);
});

test('convierte precios USD a moneda local con unidades por USD y redondeo a centavos', () => {
  assert.equal(convertUsdToCurrency('100.00', '2.50000000'), '250.00');
  assert.equal(convertCurrencyToUsd('250.00', '2.50000000'), '100.00');
  assert.equal(convertUsdToCurrency('50.00', '876.79760000'), '43839.88');
  assert.equal(convertCurrencyToUsd('43839.88', '876.79760000'), '50.00');
  assert.equal(convertCurrencyToUsd('0.01', '1.50000000'), '0.01');
});
