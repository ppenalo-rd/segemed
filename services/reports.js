const MAX_PERIOD_DAYS = 366;

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Normalizes and bounds the date and branch filters used by every report.
function normalizeFilters(input = {}, now = new Date()) {
  const currentDate = now.toISOString().slice(0, 10);
  const monthStart = `${currentDate.slice(0, 7)}-01`;
  let from = input.from;
  let to = input.to;

  if (!from && !to) {
    from = monthStart;
    to = currentDate;
  } else if (!from || !to) {
    throw new Error('Indica las fechas inicial y final del periodo.');
  }
  if (!validDate(from) || !validDate(to) || from > to) {
    throw new Error('El periodo indicado no es válido.');
  }
  const periodDays = (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86400000 + 1;
  if (periodDays > MAX_PERIOD_DAYS) {
    throw new Error(`El periodo no puede superar ${MAX_PERIOD_DAYS} días.`);
  }

  let branchId = null;
  if (input.branch_id !== undefined && input.branch_id !== '') {
    if (!/^[1-9]\d*$/.test(String(input.branch_id)) || Number(input.branch_id) > 2147483647) {
      throw new Error('La sede seleccionada no es válida.');
    }
    branchId = Number(input.branch_id);
  }
  return { from, to, branchId, periodDays };
}

function numeric(value) {
  return Number(value || 0);
}

function isoDate(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

// Reads pre-aggregated reporting data and computes schedule occupancy for a bounded period.
async function getReport(db, filters, includeFinancial) {
  if (filters.branchId !== null) {
    const branch = await db.query('SELECT id FROM branches WHERE id = $1', [filters.branchId]);
    if (!branch.rowCount) throw new Error('La sede seleccionada no existe.');
  }

  const [branches, clinicalRows, specialtyRows, occupancyRows, financialRows, freshness] = await Promise.all([
    db.query('SELECT id, name FROM branches ORDER BY name'),
    db.query(
      `SELECT d.report_date, d.branch_id, b.name AS branch_name,
              d.appointments, d.booked_appointments, d.attended_appointments,
              d.cancelled_appointments, d.consultations, d.study_orders, d.procedures
       FROM reporting_clinical_daily_mv d
       JOIN branches b ON b.id = d.branch_id
       WHERE d.report_date BETWEEN $1::date AND $2::date
         AND ($3::integer IS NULL OR d.branch_id = $3)
       ORDER BY d.report_date, b.name`,
      [filters.from, filters.to, filters.branchId]
    ),
    db.query(
      `SELECT d.branch_id, b.name AS branch_name, d.specialty,
              SUM(d.consultations)::BIGINT AS consultations
       FROM reporting_specialty_daily_mv d
       JOIN branches b ON b.id = d.branch_id
       WHERE d.report_date BETWEEN $1::date AND $2::date
         AND ($3::integer IS NULL OR d.branch_id = $3)
       GROUP BY d.branch_id, b.name, d.specialty
       ORDER BY b.name, consultations DESC, d.specialty`,
      [filters.from, filters.to, filters.branchId]
    ),
    db.query(
      `WITH calendar AS (
         SELECT day::date AS report_date,
                (ARRAY['DOMINGO','LUNES','MARTES','MIERCOLES','JUEVES','VIERNES','SABADO'])
                  [EXTRACT(DOW FROM day)::integer + 1] AS day_name
         FROM generate_series($1::date, $2::date, INTERVAL '1 day') day
       ),
       capacity AS (
         SELECT c.report_date, s.branch_id,
                SUM(CASE WHEN s.morning_enabled THEN COALESCE(s.morning_limit, 0) ELSE 0 END
                    + CASE WHEN s.afternoon_enabled THEN COALESCE(s.afternoon_limit, 0) ELSE 0 END)::BIGINT AS capacity
         FROM calendar c
         JOIN doctor_schedules s ON upper(s.day_of_week) = c.day_name
         WHERE ($3::integer IS NULL OR s.branch_id = $3)
         GROUP BY c.report_date, s.branch_id
       ),
       booked AS (
         SELECT appointment_date AS report_date, branch_id,
                COUNT(*) FILTER (WHERE status <> 'Cancelled')::BIGINT AS booked
         FROM appointments
         WHERE appointment_date BETWEEN $1::date AND $2::date
           AND ($3::integer IS NULL OR branch_id = $3)
         GROUP BY appointment_date, branch_id
       ),
       branch_totals AS (
         SELECT COALESCE(c.branch_id, a.branch_id) AS branch_id,
                SUM(COALESCE(c.capacity, 0))::BIGINT AS capacity,
                SUM(COALESCE(a.booked, 0))::BIGINT AS booked
         FROM capacity c
         FULL OUTER JOIN booked a USING (report_date, branch_id)
         GROUP BY COALESCE(c.branch_id, a.branch_id)
       )
       SELECT t.branch_id, b.name AS branch_name, t.capacity, t.booked
       FROM branch_totals t
       JOIN branches b ON b.id = t.branch_id
       ORDER BY b.name`,
      [filters.from, filters.to, filters.branchId]
    ),
    includeFinancial
      ? db.query(
        `SELECT d.report_date, d.branch_id, b.name AS branch_name,
                d.invoices_issued, d.invoices_paid, d.invoices_voided,
                d.invoiced_usd, d.voided_usd, d.payments_usd,
                d.refunds_usd, d.collected_net_usd
         FROM reporting_financial_daily_mv d
         JOIN branches b ON b.id = d.branch_id
         WHERE d.report_date BETWEEN $1::date AND $2::date
           AND ($3::integer IS NULL OR d.branch_id = $3)
         ORDER BY d.report_date, b.name`,
        [filters.from, filters.to, filters.branchId]
      )
      : Promise.resolve({ rows: [] }),
    db.query('SELECT refreshed_at FROM reporting_refresh_log ORDER BY refreshed_at DESC LIMIT 1'),
  ]);

  const clinical = clinicalRows.rows.map((row) => ({
    ...row,
    report_date: isoDate(row.report_date),
    appointments: numeric(row.appointments),
    booked_appointments: numeric(row.booked_appointments),
    attended_appointments: numeric(row.attended_appointments),
    cancelled_appointments: numeric(row.cancelled_appointments),
    consultations: numeric(row.consultations),
    study_orders: numeric(row.study_orders),
    procedures: numeric(row.procedures),
  }));
  const specialty = specialtyRows.rows.map((row) => ({ ...row, consultations: numeric(row.consultations) }));
  const occupancy = occupancyRows.rows.map((row) => {
    const capacity = numeric(row.capacity);
    const booked = numeric(row.booked);
    return {
      ...row,
      capacity,
      booked,
      occupancy_pct: capacity > 0 ? Number(((booked / capacity) * 100).toFixed(1)) : null,
    };
  });
  const financial = financialRows.rows.map((row) => ({
    ...row,
    report_date: isoDate(row.report_date),
    invoices_issued: numeric(row.invoices_issued),
    invoices_paid: numeric(row.invoices_paid),
    invoices_voided: numeric(row.invoices_voided),
    invoiced_usd: numeric(row.invoiced_usd),
    voided_usd: numeric(row.voided_usd),
    payments_usd: numeric(row.payments_usd),
    refunds_usd: numeric(row.refunds_usd),
    collected_net_usd: numeric(row.collected_net_usd),
  }));

  const totals = clinical.reduce((sum, row) => {
    for (const key of ['appointments', 'booked_appointments', 'attended_appointments',
      'cancelled_appointments', 'consultations', 'study_orders', 'procedures']) {
      sum[key] += row[key];
    }
    return sum;
  }, {
    appointments: 0, booked_appointments: 0, attended_appointments: 0, cancelled_appointments: 0,
    consultations: 0, study_orders: 0, procedures: 0,
  });
  const occupancyTotals = occupancy.reduce((sum, row) => ({
    capacity: sum.capacity + row.capacity,
    booked: sum.booked + row.booked,
  }), { capacity: 0, booked: 0 });
  totals.capacity = occupancyTotals.capacity;
  totals.occupancy_booked = occupancyTotals.booked;
  totals.occupancy_pct = occupancyTotals.capacity
    ? Number(((occupancyTotals.booked / occupancyTotals.capacity) * 100).toFixed(1))
    : null;
  const financialTotals = financial.reduce((sum, row) => {
    for (const key of ['invoices_issued', 'invoices_paid', 'invoices_voided', 'invoiced_usd',
      'voided_usd', 'payments_usd', 'refunds_usd', 'collected_net_usd']) {
      sum[key] += row[key];
    }
    return sum;
  }, {
    invoices_issued: 0, invoices_paid: 0, invoices_voided: 0, invoiced_usd: 0,
    voided_usd: 0, payments_usd: 0, refunds_usd: 0, collected_net_usd: 0,
  });

  return {
    filters,
    branches: branches.rows,
    totals,
    financialTotals: includeFinancial ? financialTotals : null,
    clinical,
    specialty,
    occupancy,
    financial: includeFinancial ? financial : [],
    financialVisible: includeFinancial,
    refreshedAt: freshness.rows[0]?.refreshed_at || null,
  };
}

function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

// Serializes report aggregates as RFC-compatible CSV without exposing patient identifiers.
function toCsv(report, type) {
  const rows = [];
  if (type === 'clinical') {
    rows.push(['tipo', 'fecha', 'sede', 'especialidad', 'citas', 'citas_reservadas',
      'atendidas', 'canceladas', 'consultas', 'ordenes_estudio', 'procedimientos', 'capacidad', 'ocupacion_pct']);
    for (const row of report.clinical) {
      rows.push(['actividad_diaria', row.report_date, row.branch_name, '', row.appointments,
        row.booked_appointments, row.attended_appointments, row.cancelled_appointments,
        row.consultations, row.study_orders, row.procedures, '', '']);
    }
    for (const row of report.specialty) {
      rows.push(['consultas_por_especialidad', '', row.branch_name, row.specialty, '', '', '', '',
        row.consultations, '', '', '', '']);
    }
    for (const row of report.occupancy) {
      rows.push(['ocupacion_sede', '', row.branch_name, '', '', row.booked, '', '', '', '', '',
        row.capacity, row.occupancy_pct ?? '']);
    }
  } else {
    rows.push(['fecha', 'sede', 'facturas_emitidas', 'facturas_pagadas', 'facturas_anuladas',
      'facturado_usd', 'anulado_usd', 'cobros_usd', 'reembolsos_usd', 'recaudacion_neta_usd']);
    for (const row of report.financial) {
      rows.push([row.report_date, row.branch_name, row.invoices_issued, row.invoices_paid,
        row.invoices_voided, row.invoiced_usd, row.voided_usd, row.payments_usd,
        row.refunds_usd, row.collected_net_usd]);
    }
  }
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

module.exports = { getReport, normalizeFilters, toCsv };
