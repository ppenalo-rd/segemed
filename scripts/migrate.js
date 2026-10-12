require('dotenv').config();

const fs = require('node:fs/promises');
const path = require('node:path');
const db = require('../db');

async function runMigrations() {
  const migrationDirectory = path.join(__dirname, '..', 'migrations');
  const migrations = (await fs.readdir(migrationDirectory))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const migration of migrations) {
    const sql = await fs.readFile(path.join(migrationDirectory, migration), 'utf8');
    await db.query(sql);
    console.log(`Migración aplicada: ${migration}`);
  }
}

runMigrations()
  .catch((error) => {
    console.error('Error al ejecutar migraciones:', error.message);
    process.exitCode = 1;
  })
  .finally(() => db.end());
