const SUPPORTED_SERVICE_TYPES = new Set(['consultation', 'procedure', 'study']);
const RATE_SCALE = 100000000n;

function normalizeCurrency(value) {
  const currency = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error('La moneda debe ser un código ISO de tres letras.');
  }
  return currency;
}

function normalizeExchangeRate(value) {
  const rate = String(value ?? '').trim();
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,8})?$/.test(rate)
      || !/[1-9]/.test(rate)) {
    throw new Error('La tasa de cambio debe ser positiva y tener hasta ocho decimales.');
  }
  return rate;
}

function normalizeMoney(value, label = 'El importe') {
  const amount = String(value ?? '').trim();
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(amount)) {
    throw new Error(`${label} debe ser un importe positivo con hasta dos decimales.`);
  }
  const cents = moneyToCents(amount);
  if (cents <= 0n) throw new Error(`${label} debe ser mayor que cero.`);
  return centsToMoney(cents);
}

function normalizeQuantity(value) {
  const quantity = String(value ?? '').trim();
  if (!/^(?:0|[1-9]\d{0,4})(?:\.\d{1,2})?$/.test(quantity)
      || Number(quantity) <= 0) {
    throw new Error('La cantidad debe ser positiva y tener hasta dos decimales.');
  }
  return quantity;
}

function normalizeService(value) {
  const serviceType = String(value?.service_type ?? '').trim();
  const name = String(value?.name ?? '').trim();
  const code = String(value?.code ?? '').trim().toUpperCase();
  const description = String(value?.description ?? '').trim();
  if (!SUPPORTED_SERVICE_TYPES.has(serviceType)) {
    throw new Error('El tipo de servicio debe ser consulta, procedimiento o estudio.');
  }
  if (!name || name.length > 180) {
    throw new Error('El nombre del servicio es obligatorio y admite hasta 180 caracteres.');
  }
  if (code.length > 60 || description.length > 500) {
    throw new Error('El código o la descripción del servicio superan el límite permitido.');
  }
  return {
    code: code || null,
    name,
    serviceType,
    description: description || null,
  };
}

function moneyToCents(value) {
  const [whole, fraction = ''] = String(value).split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

function centsToMoney(cents) {
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

function rateToScaled(value) {
  const [whole, fraction = ''] = normalizeExchangeRate(value).split('.');
  return BigInt(whole) * RATE_SCALE + BigInt(fraction.padEnd(8, '0'));
}

function roundedDivide(numerator, denominator) {
  return (numerator + denominator / 2n) / denominator;
}

function convertUsdToCurrency(usdAmount, unitsPerUsd) {
  return centsToMoney(roundedDivide(moneyToCents(usdAmount) * rateToScaled(unitsPerUsd), RATE_SCALE));
}

function convertCurrencyToUsd(amount, unitsPerUsd) {
  return centsToMoney(roundedDivide(moneyToCents(amount) * RATE_SCALE, rateToScaled(unitsPerUsd)));
}

module.exports = {
  convertCurrencyToUsd,
  convertUsdToCurrency,
  centsToMoney,
  moneyToCents,
  normalizeCurrency,
  normalizeExchangeRate,
  normalizeMoney,
  normalizeQuantity,
  normalizeService,
};
