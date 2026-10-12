const DAY_NAMES = ['DOMINGO', 'LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO'];

function getWeekday(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('La fecha no tiene un formato válido.');
  }
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error('La fecha indicada no existe.');
  }
  return DAY_NAMES[parsed.getUTCDay()];
}

function normalizeCalendarRange(start, end, maxDays = 62) {
  const datePattern = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
  const startValue = String(start || '');
  const endValue = String(end || '');
  const startMatch = datePattern.exec(startValue);
  const endMatch = datePattern.exec(endValue);
  if (!startMatch || !endMatch
      || (startValue.includes('T') && Number.isNaN(Date.parse(startValue)))
      || (endValue.includes('T') && Number.isNaN(Date.parse(endValue)))) {
    throw new Error('El rango del calendario no tiene fechas válidas.');
  }
  const startDate = startMatch[1];
  const endDate = endMatch[1];
  getWeekday(startDate);
  getWeekday(endDate);

  const startTime = Date.parse(`${startDate}T00:00:00Z`);
  const endTime = Date.parse(`${endDate}T00:00:00Z`);
  const dayCount = (endTime - startTime) / 86_400_000;
  if (!Number.isInteger(dayCount) || dayCount < 1 || dayCount > maxDays) {
    throw new Error(`El rango del calendario debe ser de 1 a ${maxDays} días.`);
  }

  return { startDate, endDate };
}

function timeToMinutes(time) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(time || '');
  if (!match) {
    throw new Error('La hora debe usar el formato HH:MM.');
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function toTimeString(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function intervalsOverlap(startA, durationA, startB, durationB) {
  return startA < startB + durationB && startA + durationA > startB;
}

function generateAvailableSlots(shifts, duration, occupied) {
  const slots = [];
  for (const shift of shifts) {
    if (!shift) continue;
    const start = timeToMinutes(String(shift.start).slice(0, 5));
    const end = timeToMinutes(String(shift.end).slice(0, 5));
    for (let cursor = start; cursor + duration <= end; cursor += duration) {
      if (!occupied.some((appointment) => intervalsOverlap(
        cursor,
        duration,
        timeToMinutes(String(appointment.start).slice(0, 5)),
        appointment.duration
      ))) {
        slots.push(toTimeString(cursor));
      }
    }
  }
  return slots;
}

module.exports = {
  generateAvailableSlots,
  getWeekday,
  intervalsOverlap,
  normalizeCalendarRange,
  timeToMinutes,
};
