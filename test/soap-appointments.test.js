const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SOAP_APPOINTMENT_STATUSES,
  findEligibleTodaysSoapAppointment,
} = require('../services/soap-appointments');

test('solo busca citas de hoy del paciente y médico con estado operativo elegible', async () => {
  let queryCall;
  const appointment = { id: 41, status: 'Waiting Room' };
  const result = await findEligibleTodaysSoapAppointment({
    async query(sql, values) {
      queryCall = { sql, values };
      return { rows: [appointment] };
    },
  }, { patientId: '8', doctorId: '3' });

  assert.equal(result, appointment);
  assert.match(queryCall.sql, /appointment_date = CURRENT_DATE/);
  assert.match(queryCall.sql, /status = ANY\(\$3::text\[\]\)/);
  assert.match(queryCall.sql, /ORDER BY time_scheduled, id/);
  assert.deepEqual(queryCall.values, [8, 3, SOAP_APPOINTMENT_STATUSES]);
  assert.deepEqual(SOAP_APPOINTMENT_STATUSES, ['Scheduled', 'Waiting Room', 'In Consultation']);
});

test('vincula la búsqueda al ID de cita solicitado y puede bloquearla para el guardado', async () => {
  let queryCall;
  await findEligibleTodaysSoapAppointment({
    async query(sql, values) {
      queryCall = { sql, values };
      return { rows: [] };
    },
  }, { patientId: 8, doctorId: 3, appointmentId: '41', lock: true });

  assert.match(queryCall.sql, /AND id = \$4/);
  assert.match(queryCall.sql, /FOR UPDATE/);
  assert.deepEqual(queryCall.values, [8, 3, SOAP_APPOINTMENT_STATUSES, 41]);
});

test('retorna null si no hay cita del día con la identidad y estado requeridos', async () => {
  const result = await findEligibleTodaysSoapAppointment({
    async query() {
      return { rows: [] };
    },
  }, { patientId: 8, doctorId: 3 });

  assert.equal(result, null);
});
