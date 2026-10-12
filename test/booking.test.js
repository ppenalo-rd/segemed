const test = require('node:test');
const assert = require('node:assert/strict');
const {
  generateAvailableSlots,
  getWeekday,
  intervalsOverlap,
  normalizeCalendarRange,
  timeToMinutes,
} = require('../services/booking');
const { normalizeDoctorScheduleSlots } = require('../services/doctor-schedules');

test('calcula el día de la semana en UTC sin depender de la zona del servidor', () => {
  assert.equal(getWeekday('2026-10-11'), 'DOMINGO');
  assert.throws(() => getWeekday('2026-02-30'), /no existe/);
});

test('valida y convierte horas de 24 horas', () => {
  assert.equal(timeToMinutes('08:30'), 510);
  assert.throws(() => timeToMinutes('25:00'), /HH:MM/);
});

test('detecta intersección temporal entre citas de distinta duración', () => {
  assert.equal(intervalsOverlap(540, 40, 570, 20), true);
  assert.equal(intervalsOverlap(540, 30, 570, 20), false);
});

test('genera turnos según duración y excluye bloques ocupados', () => {
  const slots = generateAvailableSlots(
    [{ start: '08:00:00', end: '09:30:00' }],
    30,
    [{ start: '08:30:00', duration: 30 }]
  );
  assert.deepEqual(slots, ['08:00', '09:00']);
});

test('valida rangos de calendario mensuales y semanales con fin exclusivo', () => {
  assert.deepEqual(normalizeCalendarRange('2026-10-01T00:00:00-04:00', '2026-11-01'), {
    startDate: '2026-10-01',
    endDate: '2026-11-01',
  });
  assert.deepEqual(normalizeCalendarRange('2026-10-12', '2026-10-19'), {
    startDate: '2026-10-12',
    endDate: '2026-10-19',
  });
  assert.throws(() => normalizeCalendarRange('2026-02-30', '2026-03-01'), /no existe/);
  assert.throws(() => normalizeCalendarRange('2026-10-01garbage', '2026-11-01'), /fechas válidas/);
  assert.throws(() => normalizeCalendarRange('2026-10-01T99:00:00Z', '2026-11-01'), /fechas válidas/);
  assert.throws(() => normalizeCalendarRange('2026-10-12', '2027-01-01'), /1 a 62 días/);
});

test('normaliza por separado turnos de mañana y tarde para guardar la matriz semanal', () => {
  const slots = normalizeDoctorScheduleSlots([
    {
      branch_id: '2',
      day_of_week: 'LUNES',
      morning_enabled: 'on',
      morning_start: '08:00',
      morning_end: '12:00',
      morning_limit: '8',
    },
    {
      branch_id: '3',
      day_of_week: 'LUNES',
      afternoon_enabled: 'on',
      afternoon_start: '13:00',
      afternoon_end: '17:00',
      afternoon_limit: '6',
    },
  ]);

  assert.deepEqual(slots, [
    {
      branchId: 2,
      dayOfWeek: 'LUNES',
      period: 'morning',
      enabled: true,
      start: '08:00',
      end: '12:00',
      limit: 8,
    },
    {
      branchId: 3,
      dayOfWeek: 'LUNES',
      period: 'afternoon',
      enabled: true,
      start: '13:00',
      end: '17:00',
      limit: 6,
    },
  ]);
});

test('rechaza franjas con día, sede, horas o cupos inválidos', () => {
  const validSlot = {
    branch_id: '1',
    day_of_week: 'LUNES',
    morning_enabled: 'on',
    morning_start: '08:00',
    morning_end: '12:00',
    morning_limit: '10',
  };

  assert.throws(
    () => normalizeDoctorScheduleSlots([{ ...validSlot, day_of_week: 'FUNDAY' }]),
    /día de semana válido/
  );
  assert.throws(
    () => normalizeDoctorScheduleSlots([{ ...validSlot, branch_id: '0' }]),
    /sede válida/
  );
  assert.throws(
    () => normalizeDoctorScheduleSlots([{ ...validSlot, morning_start: '12:00' }]),
    /inicio debe ser anterior/
  );
  assert.throws(
    () => normalizeDoctorScheduleSlots([{ ...validSlot, morning_limit: '51' }]),
    /entre 1 y 50/
  );
});
