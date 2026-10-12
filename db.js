const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_DATABASE,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
});

pool.on('connect', () => {
  console.log('¡Conexión exitosa a PostgreSQL!');
});

pool.on('error', (err) => {
  console.error('Error en el pool de PostgreSQL:', err.message);
});

module.exports = {
  pool,
  connect: () => pool.connect(),
  end: () => pool.end(),
  query: async (text, params) => {
    try {
      const res = await pool.query(text, params);
      return res;
    } catch (err) {
      console.error('DETALLE DEL ERROR SQL:', err.message);
      throw err;
    }
  },
};