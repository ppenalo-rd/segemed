# SIGEMED

SIGEMED es una aplicación de gestión clínica ambulatoria con consulta externa, procedimientos menores, prescripción, facturación y reportería. El backend utiliza Node.js/Express y PostgreSQL.

## Requisitos

- Node.js 20 o superior.
- PostgreSQL con el esquema base de SIGEMED y permisos para ejecutar migraciones.
- Dependencias instaladas con `npm install`.

## Configuración

1. Copia `.env.example` a `.env` y configura los parámetros `DB_USER`, `DB_PASSWORD`, `DB_HOST`, `DB_PORT`, `DB_DATABASE` y `PORT`. Configura también `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` y `SMTP_FROM` para el envío de códigos 2FA. No compartas ni incorpores `.env` al control de versiones.
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

El ejecutor procesa en orden los archivos `.sql` de `migrations/`; las migraciones deben poder repetirse según las garantías definidas por cada archivo. La migración `007_global_audit_security.sql` añade índices y refuerza la inmutabilidad de `access_audit_logs`. La migración `009_email_otp_authentication.sql` crea la tabla de desafíos OTP. La migración `011_user_role_check.sql` mantiene compatibles los valores históricos de `users.role` y habilita las claves de rol normalizadas usadas por la aplicación. La migración `012_password_change_otp.sql` crea los desafíos aislados para verificar cambios de contraseña.

### Autenticación de dos factores por correo

Después de validar el correo y la contraseña, SIGEMED envía un código OTP de seis dígitos al correo registrado y requiere validarlo en `/auth/verify-otp` antes de crear la sesión autenticada. El código vence a los cinco minutos, admite hasta cinco intentos y puede reenviarse con una espera mínima de 60 segundos. Las rutas de verificación y reenvío además tienen límites de solicitudes por IP.

Las sesiones autenticadas se extienden hasta ocho horas desde la última actividad. Mientras haya interacción, las pantallas autenticadas renuevan la sesión cada cinco minutos; tras diez minutos sin actividad, dejan de hacerlo. Si la sesión vence, la aplicación devuelve al ingreso para autenticarse nuevamente, sin desactivar la protección CSRF.

Configura el SMTP de tu proveedor con los valores indicados en `.env.example`; el puerto 587 usa STARTTLS y el 465 usa TLS implícito. Mantén `SMTP_REQUIRE_TLS=true` salvo en pruebas SMTP locales aisladas. No se habilita una sesión de usuario si el correo no puede enviarse. No se almacena `otp_code` en texto claro: `email_otp_challenges.otp_hash` guarda un HMAC del código, y la expiración, reenvío e intentos se controlan en la base de datos. `is_2fa_verified` se mantiene en la sesión autenticada (no como estado global de `users`), evitando que la verificación de una sesión autorice otras sesiones concurrentes. Se auditan los éxitos y fallos de autenticación sin registrar el código.

El cambio de contraseña propio está disponible en «Mi perfil» y el restablecimiento administrativo en Usuarios y accesos y en el directorio de médicos vinculados. En todos los casos se exige OTP enviado al correo de la cuenta afectada; la solicitud guarda solo el hash bcrypt de la nueva clave y un HMAC del OTP en `password_change_challenges`. El código vence en cinco minutos, permite hasta cinco intentos y tiene una espera de 60 segundos entre solicitudes. Las contraseñas requieren 12 caracteres, mayúscula, minúscula y número. Al cambiar la clave se revocan las sesiones de la cuenta y se registra el evento en auditoría. Aplica `npm run db:migrate` para crear la tabla de desafíos.

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

En `/admin/users`, los administradores y el personal de auditoría autorizado pueden crear cuentas o editar el nombre, correo, estado y perfiles permitidos desde la tabla de cuentas. Los cambios de acceso se guardan de forma transaccional, se registran en auditoría y revocan las sesiones existentes del usuario afectado. El personal de auditoría no puede asignar perfiles administrativos ni desactivar cuentas de administradores. Desde la misma pantalla, también se puede asociar una cuenta con perfil Médico a un profesional existente o vincular un perfil médico sin asignar a una cuenta activa ya existente. Solo los perfiles asociados aparecen como médicos disponibles para agendar; la agenda indica cómo completar el vínculo cuando no hay ninguno habilitado.

El directorio médico utiliza `specialties` y la relación `doctor_specialties` para asociar especialidades al perfil profesional, con una especialidad principal. El catálogo inicial incluye Medicina General, Pediatría, Traumatología, Cardiología y Ginecología. Ejecuta `npm run db:migrate` para aplicar `010_doctor_specialties_seed.sql`; esta migración también asocia los perfiles existentes cuando su campo de especialidad coincide con una de esas especialidades. Los selectores de la agenda muestran únicamente médicos con perfil no anulado, cuenta activa y rol Médico activo.

En `/admin/doctors`, el botón **Editar** abre el perfil con los datos existentes precargados. Los cambios se guardan mediante `POST /admin/doctors/save` con consultas parametrizadas; allí también se puede cambiar la especialidad principal y activar o desactivar el perfil. Al guardar, se muestra una confirmación y se conserva la asociación de la especialidad principal en `doctor_specialties`.

### Calendario médico

La ruta `/agenda` ofrece una vista mensual, semanal y de lista con filtros por médico y sede. Las citas se cargan bajo demanda desde `GET /api/calendar/appointments` usando el rango visible del calendario; el rango se valida y limita a 62 días. El listado operativo queda acotado a los últimos tres días y los próximos 30; al abrir una cita histórica, `?date=YYYY-MM-DD` centra el listado y calendario en esa fecha. Al pasar o enfocar una cita se muestran hora, paciente, documento, motivo, médico, sede y estado. Al seleccionarla se abre su fila en la agenda. Al seleccionar un día se abre el formulario de agendamiento con la fecha precargada; su envío AJAX codifica los campos como `application/x-www-form-urlencoded`, formato que procesa el middleware Express junto con el token CSRF.

La creación continúa usando `POST /appointments/create` y `GET /api/doctor-availability`; el servidor vuelve a validar la matriz de horarios, duración configurada para el tipo de atención y conflictos antes de guardar. Los cambios de estado se auditan y vuelven a mostrar la cita enfocada en su fecha original. Las cuentas con rol `doctor` solo reciben su propio calendario salvo que tengan además permisos de administración, admisión o auditoría. La vista carga FullCalendar 6.1.19 desde jsDelivr; el Content Security Policy permite ese origen para scripts.

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
