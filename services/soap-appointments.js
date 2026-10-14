const SOAP_APPOINTMENT_STATUSES = ['Scheduled', 'Waiting Room', 'In Consultation'];

async function findEligibleTodaysSoapAppointment(client, {
  patientId,
  doctorId,
  appointmentId = null,
  lock = false,
}) {
  const values = [Number(patientId), Number(doctorId), SOAP_APPOINTMENT_STATUSES];
  let appointmentFilter = '';
  if (appointmentId !== null && appointmentId !== undefined) {
    values.push(Number(appointmentId));
    appointmentFilter = `AND id = $${values.length}`;
  }

  const { rows } = await client.query(
    `SELECT id, status
     FROM appointments
     WHERE patient_id = $1
       AND doctor_id = $2
       AND appointment_date = CURRENT_DATE
       AND status = ANY($3::text[])
       ${appointmentFilter}
     ORDER BY time_scheduled, id
     LIMIT 1
     ${lock ? 'FOR UPDATE' : ''}`,
    values
  );
  return rows[0] || null;
}

module.exports = {
  SOAP_APPOINTMENT_STATUSES,
  findEligibleTodaysSoapAppointment,
};
