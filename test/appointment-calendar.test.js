const test = require('node:test');
const assert = require('node:assert/strict');
const { mapAppointmentsToCalendarEvents } = require('../services/appointment-calendar');

test('convierte citas a eventos FullCalendar con detalles seguros para el popover', () => {
  const [event] = mapAppointmentsToCalendarEvents([{
    id: 42,
    appointment_date: '2026-10-12',
    appointment_time: '09:20',
    duration_minutes: 20,
    status: 'Scheduled',
    reason_for_visit: 'Control anual',
    first_name: 'Ana',
    last_name: 'Pérez',
    dni_document: 'V-12345678',
    document_type: 'cedula',
    doctor_name: 'Dra. Ruiz',
    branch_name: 'Centro',
  }]);

  assert.deepEqual(event, {
    id: '42',
    title: '09:20 · Ana Pérez',
    start: '2026-10-12T09:20:00',
    end: '2026-10-12T09:40:00',
    url: '/agenda?date=2026-10-12#appointment-42',
    classNames: ['appointment-scheduled'],
    extendedProps: {
      patientName: 'Ana Pérez',
      documentNumber: 'V-12345678',
      reason: 'Control anual',
      doctorName: 'Dra. Ruiz',
      branchName: 'Centro',
      appointmentTime: '09:20',
      status: 'Scheduled',
    },
  });
});

test('representa citas sin hora como eventos de día completo y usa valores seguros por defecto', () => {
  const [event] = mapAppointmentsToCalendarEvents([{
    id: 9,
    appointment_date: '2026-10-12',
    appointment_time: null,
    status: 'Cancelled',
    first_name: 'Luis',
    last_name: 'Gómez',
    document_type: 'none',
    dni_document: null,
    reason_for_visit: null,
    doctor_name: null,
    branch_name: 'Norte',
  }]);

  assert.equal(event.allDay, true);
  assert.equal(event.start, '2026-10-12');
  assert.equal(event.title, 'Luis Gómez');
  assert.equal(event.classNames[0], 'appointment-cancelled');
  assert.equal(event.extendedProps.documentNumber, 'Sin documento propio');
  assert.equal(event.extendedProps.reason, 'No especificado');
});
