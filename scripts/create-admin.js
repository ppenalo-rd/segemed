require('dotenv').config();

const bcrypt = require('bcryptjs');
const readline = require('node:readline');
const db = require('../db');

function prompt(question) {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => terminal.question(question, (answer) => {
    terminal.close();
    resolve(answer.trim());
  }));
}

async function createAdministrator() {
  const name = await prompt('Nombre del administrador: ');
  const email = (await prompt('Correo del administrador: ')).toLowerCase();
  const password = await promptSecret('Contraseña inicial (mínimo 12 caracteres): ');

  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12) {
    throw new Error('Nombre, correo válido y contraseña de al menos 12 caracteres son obligatorios.');
  }

  function promptSecret(message) {
    return new Promise((resolve, reject) => {
      if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
        reject(new Error('Ejecuta este comando desde una terminal interactiva para proteger la contraseña.'));
        return;
      }
      let value = '';
      process.stdout.write(message);
      process.stdin.setEncoding('utf8');
      process.stdin.setRawMode(true);
      process.stdin.resume();
      const onKey = (key) => {
        if (key === '\u0003') {
          process.stdin.setRawMode(false);
          process.stdin.removeListener('data', onKey);
          reject(new Error('Operación cancelada.'));
          return;
        }
        if (key === '\r' || key === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.removeListener('data', onKey);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (key === '\u007f' || key === '\b') {
          value = value.slice(0, -1);
          return;
        }
        value += key;
        process.stdout.write('*');
      };
      process.stdin.on('data', onKey);
    });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO users (name, email, password_hash, role, active)
       VALUES ($1, $2, $3, 'admin', TRUE)
       RETURNING id`,
      [name, email, passwordHash]
    );
    const userId = rows[0].id;
    await client.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT $1, id FROM roles WHERE role_key = 'system_admin'
       ON CONFLICT DO NOTHING`,
      [userId]
    );
    await client.query('COMMIT');
    console.log(`Cuenta administradora creada para ${email}. Configure SESSION_SECRET antes de exponer el servidor.`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

createAdministrator()
  .catch((error) => {
    console.error('No se pudo crear el administrador:', error.message);
    process.exitCode = 1;
  })
  .finally(() => db.end());
