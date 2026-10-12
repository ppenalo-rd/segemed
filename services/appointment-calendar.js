const { timeToMinutes } = require('./booking');

function mapAppointmentsToCalendarEvents(appointments) {
  return appointments.map((appointment) => {
    const patientName = `${appointment.first_name} ${appointment.last_name}`.trim();
    const start = appointment.appointment_time
      ? `${appointment.appointment_date}T${appointment.appointment_time}:00`
      : appointment.appointment_date;
    const duration = Number(appointment.duration_minutes || 20);
    let end;
    if (appointment.appointment_time) {
      const endMinute = timeToMinutes(appointment.appointment_time) + duration;
      end = `${appointment.appointment_date}T${String(Math.floor(endMinute / 60)).padStart(2, '0')}:${String(endMinute % 60).padStart(2, '0')}:00`;
    }
    const statusClass = {
      Scheduled: 'appointment-scheduled',
      'Waiting Room': 'appointment-waiting',
      'In Consultation': 'appointment-consultation',
      Attended: 'appointment-attended',
      Cancelled: 'appointment-cancelled',
    }[appointment.status] || 'appointment-other';

    return {
      id: String(appointment.id),
      title: `${appointment.appointment_time ? `${appointment.appointment_time} · ` : ''}${patientName}`,
      start,
      ...(end ? { end } : { allDay: true }),
      url: `/agenda?date=${appointment.appointment_date}#appointment-${appointment.id}`,
      classNames: [statusClass],
      extendedProps: {
        patientName,
        documentNumber: appointment.document_type === 'none'
          ? 'Sin documento propio'
          : appointment.dni_document || 'No registrado',
        reason: appointment.reason_for_visit || 'No especificado',
        doctorName: appointment.doctor_name || 'Médico no asociado',
        branchName: appointment.branch_name,
        appointmentTime: appointment.appointment_time || 'Todo el día',
        status: appointment.status,
      },
    };
  });
}

module.exports = { mapAppointmentsToCalendarEvents };
