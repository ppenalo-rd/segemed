require('dotenv').config();
const db = require('../db');

async function refreshReports() {
  const client = await db.connect();
  let locked = false;
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock(hashtext('sigemed-report-refresh')) AS locked");
    if (!lock.rows[0].locked) throw new Error('Ya hay una actualización de reportería en curso.');
    locked = true;

    await client.query('REFRESH MATERIALIZED VIEW CONCURRENTLY reporting_clinical_daily_mv');
    await client.query('REFRESH MATERIALIZED VIEW CONCURRENTLY reporting_specialty_daily_mv');
    await client.query('REFRESH MATERIALIZED VIEW CONCURRENTLY reporting_financial_daily_mv');
    await client.query(
      'INSERT INTO reporting_refresh_log (views_refreshed) VALUES ($1)',
      [3]
    );
    console.log('Vistas analíticas actualizadas: clínicas, especialidades y finanzas.');
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext('sigemed-report-refresh'))");
    client.release();
  }
}

refreshReports()
  .catch((error) => {
    console.error('No se pudieron actualizar las vistas de reportería:', error.message);
    process.exitCode = 1;
  })
  .finally(() => db.end());
