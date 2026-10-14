const DASHBOARD_SECTIONS = [
  {
    id: 'medical-operations',
    title: 'Operaciones médicas y atención al paciente',
    modules: [
      {
        id: 'medical',
        icon: '🧑‍⚕️',
        title: 'Consultorio Médico y Evolución',
        description: 'Agenda de hoy, evolución SOAP, recetas y directorio clínico.',
        href: '/appointments/today',
        roles: ['doctor'],
      },
      {
        id: 'admissions',
        icon: '🚪',
        title: 'Admisión y Sala de Espera',
        description: 'Citas, registro de pacientes y control del flujo de atención.',
        href: '/agenda',
        roles: ['admissions'],
      },
      {
        id: 'patients',
        icon: '📂',
        title: 'Gestión de Pacientes',
        description: 'Directorio general, búsqueda y datos demográficos.',
        href: '/pacientes',
        roles: ['admissions'],
      },
    ],
  },
  {
    id: 'financial-operations',
    title: 'Gestión administrativa y facturación',
    modules: [{
      id: 'billing',
      icon: '💰',
      title: 'Facturación y Caja',
      description: 'Comprobantes, pagos, estados de cuenta y reportes de caja.',
      href: '/billing',
      roles: ['system_admin'],
    }],
  },
  {
    id: 'analytics',
    title: 'Reportes y analítica',
    modules: [{
      id: 'reports',
      icon: '📊',
      title: 'Reportes y Estadísticas',
      description: 'Indicadores agregados y exportaciones de consulta.',
      href: '/reports',
      roles: ['system_admin', 'audit_security'],
    }],
  },
  {
    id: 'configuration-security',
    title: 'Configuración y seguridad',
    modules: [
      {
        id: 'configuration',
        icon: '⚙️',
        title: 'Configuración del Sistema',
        description: 'Cuentas, roles, perfiles médicos y parámetros del sistema.',
        href: '/admin/users',
        roles: ['system_admin'],
      },
      {
        id: 'security-audit',
        icon: '🔒',
        title: 'Seguridad y Auditoría',
        description: 'Consulta de eventos de auditoría en modo de solo lectura.',
        href: '/admin/security/audit',
        roles: ['system_admin', 'audit_security'],
      },
    ],
  },
];

function buildNavigationSections(userRoles) {
  const roles = Array.isArray(userRoles) ? userRoles : [];
  return DASHBOARD_SECTIONS
    .map((section) => ({
      ...section,
      modules: section.modules.filter((module) => module.roles.some((role) => roles.includes(role))),
    }))
    .filter((section) => section.modules.length > 0);
}

module.exports = { buildNavigationSections };
