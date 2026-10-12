# SIGEMED

SIGEMED es una aplicación de gestión clínica ambulatoria con consulta externa, procedimientos menores, prescripción, facturación y reportería. El backend utiliza Node.js/Express y PostgreSQL.

## Requisitos

- Node.js 20 o superior.
- PostgreSQL con el esquema base de SIGEMED y permisos para ejecutar migraciones.
- Dependencias instaladas con `npm install`.

## Configuración

1. Copia `.env.example` a `.env` y configura los parámetros `DB_USER`, `DB_PASSWORD`, `DB_HOST`, `DB_PORT`, `DB_DATABASE` y `PORT`. No compartas ni incorpores `.env` al control de versiones.
2. Antes de iniciar en producción, configura `NODE_ENV=production` y un `SESSION_SECRET` aleatorio de al menos 32 caracteres. Puedes generar uno con:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
   ```

   No uses el valor de ejemplo ni una contraseña de usuario. La aplicación rechaza secretos ausentes, cortos o con el placeholder conocido en producción.
3. Si TLS termina en un proxy inverso, configura `TRUST_PROXY` con el número exacto de saltos de proxy confiables (0–10). No lo aumentes sin verificar la topología: afecta cómo Express interpreta IP y HTTPS reenviados. El proxy debe forzar HTTPS.

En producción se habilita HSTS por un año, cookies `Secure`, `HttpOnly` y `SameSite=Lax`, Helmet y la desactivación del encabezado `X-Powered-By`. HSTS no incluye subdominios por defecto. Mantén TLS activo en todo el recorrido externo.

## Base de datos y migraciones

La base debe contar con el esquema inicial antes de aplicar las migraciones versionadas. En una instalación nueva, crea la base, aplica el esquema de referencia `database/schema.sql` con el cliente PostgreSQL y después ejecuta:

```powershell
npm run db:migrate
```

El ejecutor procesa en orden los archivos `.sql` de `migrations/`; las migraciones deben poder repetirse según las garantías definidas por cada archivo. La migración `007_global_audit_security.sql` añade índices y refuerza la inmutabilidad de `access_audit_logs`.

### Moneda y facturación

La moneda base y de emisión es VES; el catálogo de servicios conserva sus precios por sede en USD. Para facturar en bolívares, Administración debe registrar en `/admin/billing` la tasa vigente en unidades de la moneda local por cada USD (por ejemplo, `876.7976` VES por USD, con origen `Banco Central de Venezuela` y su fecha/hora efectiva). Caja convierte los precios del catálogo al emitir y congela la tasa y los importes en el comprobante. Una tasa nueva no altera facturas emitidas ni su historial.

La migración `008_ves_base_currency.sql` establece VES como moneda base, habilita VES y USD y preserva las tasas y comprobantes anteriores mediante snapshots compatibles. Las tasas históricas se conservan; valida el origen y vigencia antes de registrar nuevas tasas. Los reportes financieros internos continúan consolidándose en USD para comparar ingresos multimoneda.

## Operación

```powershell
npm start
npm run admin:create
npm run db:migrate
npm run reports:refresh
npm test
```

`npm run admin:create` es interactivo: solicita nombre, correo y una contraseña inicial de al menos 12 caracteres, que se captura sin mostrarla en pantalla. Ejecuta el comando desde una terminal interactiva y entrega credenciales iniciales de forma segura.

### Menú principal post-login

Después de iniciar sesión, la aplicación redirige a `/dashboard`, el menú principal de accesos. Las tarjetas se filtran por los roles activos de la sesión:

- `admissions` y `system_admin`: Admisión y Agenda; Facturación y Caja.
- `doctor` y `nurse` (personal clínico): Consulta Médica / SOAP y Recetas.
- `audit_security` y `system_admin`: Reportes y Estadísticas.
- `system_admin`: Gestión de Usuarios y Configuración.

Las rutas de los módulos conservan sus propios controles de autorización; ocultar una tarjeta no sustituye las verificaciones RBAC del servidor. En Facturación y Caja, `system_admin` tiene acceso de consulta a las facturas, mientras que solo `admissions` puede crear o modificar facturas, emitirlas, registrar pagos o procesar reversiones.

### Refresco programado de reportería

Ejecuta `npm run reports:refresh` fuera del proceso web; el comando actualiza las vistas analíticas y registra la ejecución. Programa su ejecución periódica con el usuario del sistema operativo que tenga acceso a la aplicación y PostgreSQL. Por ejemplo, con cron en Linux:

```cron
*/15 * * * * cd /ruta/absoluta/SAS && /usr/bin/npm run reports:refresh >> /var/log/sigemed-reports-refresh.log 2>&1
```

En Windows, configura una tarea en el Programador de tareas que ejecute `npm.cmd run reports:refresh`, con el directorio de trabajo del proyecto y el entorno que contiene la conexión de PostgreSQL. Protege el archivo de entorno y los registros de salida con permisos restrictivos.

## Auditoría, roles y datos clínicos

- Los eventos de acceso, autenticación, consulta de historia clínica, guardado SOAP, acciones de prescripción y reportes se escriben en `access_audit_logs`; las auditorías de facturación permanecen en `billing_audit_events`.
- Las escrituras SOAP y las acciones de prescripción incluyen su evento de auditoría dentro de la misma transacción que los cambios.
- Los registros de auditoría son append-only a nivel de base de datos. No se deben deshabilitar los triggers de inmutabilidad en operaciones normales.
- El detalle auditado contiene metadatos operativos; no registra contraseñas ni el contenido clínico del SOAP o de las recetas.
- La autorización de rutas sigue los roles y reglas de la aplicación; las acciones de facturación se restringen al personal habilitado de Recepción/Caja y administración según el flujo.
- Trata los PDFs, los datos clínicos, los respaldos y los logs como información sensible; limita su acceso y define retención y restauración conforme a la normativa aplicable.

## Pruebas

La suite unitaria se ejecuta con:

```powershell
npm test
```

Para incluir las integraciones de autenticación/RBAC, facturación y reportería, establece `SIGEMED_AUTH_INTEGRATION=1`, `SIGEMED_BILLING_INTEGRATION=1` y `SIGEMED_REPORTS_INTEGRATION=1` en el entorno de prueba antes de ejecutar `npm test`. Las pruebas integradas requieren una base PostgreSQL de prueba con el esquema y las migraciones aplicadas; crean y limpian fixtures. No las ejecutes apuntando a producción.

## Preparación para UAT

Antes de habilitar UAT, verifica que:

- las variables de producción y credenciales de base de datos estén configuradas en el gestor de secretos del entorno;
- TLS, proxy confiable, respaldos y procedimiento de recuperación hayan sido probados;
- todas las migraciones estén aplicadas y el refresco de reportería esté programado;
- exista una cuenta administradora inicial segura y las cuentas/roles de UAT tengan privilegios mínimos;
- la suite de pruebas y los escenarios de aceptación clínica, financiera y de permisos hayan sido aprobados con datos no productivos.
