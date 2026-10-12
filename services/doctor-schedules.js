const DAYS_OF_WEEK = new Set([
  'LUNES',
  'MARTES',
  'MIERCOLES',
  'JUEVES',
  'VIERNES',
  'SABADO',
  'DOMINGO',
]);

function normalizeDoctorScheduleSlot(slot, period) {
  if (!slot || !['morning', 'afternoon'].includes(period)) {
    throw new Error('El turno médico no es válido.');
  }

  const dayOfWeek = String(slot.day_of_week ?? '').trim().toUpperCase();
  const branchId = String(slot.branch_id ?? '').trim();
  if (!DAYS_OF_WEEK.has(dayOfWeek)) {
    throw new Error('Selecciona un día de semana válido para el horario.');
  }
  if (!/^[1-9]\d*$/.test(branchId) || Number(branchId) > 2147483647) {
    throw new Error('Selecciona una sede válida para el horario.');
  }

  const enabled = slot[`${period}_enabled`] === 'on'
    || slot[`${period}_enabled`] === true
    || slot[`${period}_enabled`] === 'true';
  const start = String(slot[`${period}_start`] ?? '').trim();
  const end = String(slot[`${period}_end`] ?? '').trim();
  const rawLimit = String(slot[`${period}_limit`] ?? '').trim();
  const limit = rawLimit ? Number(rawLimit) : 10;

  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(start)
      || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(end)) {
    throw new Error('Las horas del turno deben tener formato válido.');
  }
  if (enabled && start >= end) {
    throw new Error('La hora de inicio debe ser anterior a la hora de fin.');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error('El límite de cupos debe ser un entero entre 1 y 50.');
  }

  return {
    branchId: Number(branchId),
    dayOfWeek,
    period,
    enabled,
    start,
    end,
    limit,
  };
}

function normalizeDoctorScheduleSlots(schedules) {
  if (!Array.isArray(schedules) || schedules.length === 0) {
    throw new Error('No se recibieron horarios para guardar.');
  }

  return schedules.map((slot, index) => normalizeDoctorScheduleSlot(
    slot,
    index % 2 === 0 ? 'morning' : 'afternoon'
  ));
}

module.exports = {
  normalizeDoctorScheduleSlots,
};
