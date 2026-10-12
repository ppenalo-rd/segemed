const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeFilters, toCsv } = require('../services/reports');

test('normaliza el periodo de reportería con un máximo acotado', () => {
  const filters = normalizeFilters({}, new Date('2026-10-11T12:00:00.000Z'));
  assert.deepEqual(filters, {
    from: '2026-10-01',
    to: '2026-10-11',
    branchId: null,
    periodDays: 11,
  });
  assert.equal(normalizeFilters({
    from: '2026-01-01',
    to: '2026-01-31',
    branch_id: '3',
  }).branchId, 3);
});

test('rechaza periodos incompletos, fechas imposibles, intervalos largos y sedes inválidas', () => {
  assert.throws(() => normalizeFilters({ from: '2026-01-01' }), /fechas inicial y final/);
  assert.throws(() => normalizeFilters({ from: '2026-02-30', to: '2026-03-01' }), /no es válido/);
  assert.throws(() => normalizeFilters({ from: '2025-01-01', to: '2026-01-02' }), /366 días/);
  assert.throws(() => normalizeFilters({ from: '2026-01-01', to: '2026-01-02', branch_id: '-1' }), /sede seleccionada/);
});

test('exporta agregados CSV escapados y neutraliza fórmulas de hoja de cálculo', () => {
  const csv = toCsv({
    clinical: [{
      report_date: '2026-10-11',
      branch_name: 'Sede, "Centro"',
      appointments: 4,
      booked_appointments: 3,
      attended_appointments: 2,
      cancelled_appointments: 1,
      consultations: 2,
      study_orders: 1,
      procedures: 0,
    }],
    specialty: [{ branch_name: '=HYPERLINK("x")', specialty: 'Clínica', consultations: 2 }],
    occupancy: [],
  }, 'clinical');

  assert.ok(csv.startsWith('\uFEFF'));
  assert.match(csv, /"Sede, ""Centro"""/);
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
  assert.doesNotMatch(csv, /Paciente|documento|dni/i);
});
