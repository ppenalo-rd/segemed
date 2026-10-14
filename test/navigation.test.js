const test = require('node:test');
const assert = require('node:assert/strict');
const { buildNavigationSections } = require('../services/navigation');

function modulesFor(role) {
  return buildNavigationSections([role]).flatMap((section) => section.modules.map((module) => module.id));
}

test('muestra al médico únicamente consultorio, cuya entrada predeterminada es la agenda de hoy', () => {
  const sections = buildNavigationSections(['doctor']);
  assert.deepEqual(modulesFor('doctor'), ['medical']);
  assert.equal(sections[0].modules[0].href, '/appointments/today');
});

test('muestra a recepción la sala de espera y el directorio, sin facturación', () => {
  assert.deepEqual(modulesFor('admissions'), ['admissions', 'patients']);
});

test('limita administración a facturación, reportes, configuración y auditoría', () => {
  assert.deepEqual(modulesFor('system_admin'), ['billing', 'reports', 'configuration', 'security-audit']);
});

test('limita auditoría a reportes y eventos de seguridad de solo lectura', () => {
  assert.deepEqual(modulesFor('audit_security'), ['reports', 'security-audit']);
});

test('oculta módulos a perfiles fuera de la matriz aprobada', () => {
  assert.deepEqual(buildNavigationSections(['nurse']), []);
});
