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

El ejecutor procesa en orden los archivos `.sql` de `migrations/`; las migraciones deben poder repetirse según las garantías definidas por cada archivo. La migración `007_global_audit_security.sql` añade índices y refuerza la inmutabilidad de `access_audit_logs`. La migración `009_email_otp_authentication.sql` crea la tabla de desafíos OTP. La migración `011_user_role_check.sql` mantiene compatibles los valores históricos de `users.role` y habilita las claves de rol normalizadas usadas por la aplicación. La migración `012_password_change_otp.sql` crea los desafíos aislados para verificar cambios de contraseña. La migración `013_soap_note_drafts.sql` añade borradores SOAP temporales asociados al paciente, médico y consulta, separados de las notas clínicas definitivas. La migración `014_soap_edit_two_factor_audit.sql` creó originalmente desafíos OTP SOAP y la bitácora de cambios por campo protegida contra actualizaciones y borrados; el flujo OTP SOAP ya no está activo.

### Autenticación de dos factores por correo

Después de validar el correo y la contraseña, SIGEMED envía un código OTP de seis dígitos al correo registrado y requiere validarlo en `/auth/verify-otp` antes de crear la sesión autenticada. El código vence a los cinco minutos, admite hasta cinco intentos y puede reenviarse con una espera mínima de 60 segundos. Las rutas de verificación y reenvío además tienen límites de solicitudes por IP.

Las sesiones autenticadas se extienden hasta ocho horas desde la última actividad. Mientras haya interacción, las pantallas autenticadas renuevan la sesión cada cinco minutos; tras diez minutos sin actividad, dejan de hacerlo. Si la sesión vence, la aplicación devuelve al ingreso para autenticarse nuevamente, sin desactivar la protección CSRF.

Configura el SMTP de tu proveedor con los valores indicados en `.env.example`; el puerto 587 usa STARTTLS y el 465 usa TLS implícito. Mantén `SMTP_REQUIRE_TLS=true` salvo en pruebas SMTP locales aisladas. No se habilita una sesión de usuario si el correo no puede enviarse. No se almacena `otp_code` en texto claro: `email_otp_challenges.otp_hash` guarda un HMAC del código, y la expiración, reenvío e intentos se controlan en la base de datos. `is_2fa_verified` se mantiene en la sesión autenticada (no como estado global de `users`), evitando que la verificación de una sesión autorice otras sesiones concurrentes. Se auditan los éxitos y fallos de autenticación sin registrar el código.

El cambio de contraseña propio está disponible en «Mi perfil» y el restablecimiento administrativo en Usuarios y accesos y en el directorio de médicos vinculados. En todos los casos se exige OTP enviado al correo de la cuenta afectada; la solicitud guarda solo el hash bcrypt de la nueva clave y un HMAC del OTP en `password_change_challenges`. El código vence en cinco minutos, permite hasta cinco intentos y tiene una espera de 60 segundos entre solicitudes. Las contraseñas requieren 12 caracteres, mayúscula, minúscula y número. Al cambiar la clave se revocan las sesiones de la cuenta y se registra el evento en auditoría. Aplica `npm run db:migrate` para crear la tabla de desafíos.

### Licenciamiento local

`services/license-verifier.js` valida una licencia SIGEMED firmada con Ed25519, asociada a un `installationId`, y acepta exclusivamente 30, 60, 90, 120, 150, 180 o 365 días. El sobre es `{ payload, signature }`; la firma Base64URL sin padding cubre UTF-8 `JSON.stringify` de los campos del payload, en este orden exacto: `version`, `product`, `licenseId`, `installationId`, `durationDays`, `activatedAt`, `expiresAt`. No admite campos adicionales. Las marcas de tiempo deben ser UTC ISO canónicas; el vencimiento debe coincidir exactamente con la activación más el plazo firmado. La función `verifyLocalLicense` retorna `active` o `read_only` con una causa explícita. También serializa las comprobaciones concurrentes por almacén y mantiene el mayor instante UTC observado para detectar retrocesos del reloj.

El adaptador `services/windows-license-state-store.js` persiste tanto el marcador de reloj como la licencia con DPAPI `CurrentUser`, ACL para la cuenta actual y `SYSTEM`, y reemplazo atómico. Los archivos predeterminados son `%ProgramData%\SIGEMED\License\clock-state.bin` y `license.bin`; requiere Windows PowerShell 5.1 y que el servicio SIGEMED se ejecute siempre bajo la misma cuenta de Windows con su perfil disponible. Los errores de permisos, descifrado, corrupción o escritura dejan el sistema en solo lectura. La clave privada del emisor no forma parte de la aplicación.

En producción, el servidor activa el enforcement antes de empezar a escuchar. Configura `SIGEMED_LICENSE_PUBLIC_KEY_PATH` con la ruta del PEM de la clave pública del emisor; en Windows, el `installationId` se deriva de `MachineGuid`. `SIGEMED_LICENSE_STATE_DIR` permite cambiar la carpeta persistente protegida (debe ser absoluta); si falta el identificador, la clave, una licencia válida o el almacén DPAPI, las escrituras clínicas se bloquean. Fuera de Windows el arranque continúa en solo lectura cuando el enforcement está activo, y no se habilita un almacén alternativo inseguro.

El enforcement se puede activar fuera de producción con `SIGEMED_LICENSE_ENFORCEMENT=true`. En desarrollo queda deshabilitado por defecto y el estado se informa como `development_mode`; esa opción no desactiva el enforcement en producción. La pantalla `/admin/license`, visible para el administrador del sistema, permite cargar el archivo firmado, valida firma, instalación, duración y reloj antes de persistirlo.

Al no haber licencia activa, o al vencer o detectarse retroceso del reloj, se rechazan con HTTP 423 la creación de notas SOAP, el guardado/eliminación de borradores SOAP y la creación, firma o cancelación de recetas. Se conservan las rutas de consulta de historias, reportes, PDFs y respaldos. El bloqueo de escritura no modifica ni elimina datos clínicos previos. Esta integración no sustituye el instalador ni implementa el proceso externo de emisión/liberación de licencias.

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

Después de iniciar sesión, la aplicación redirige a `/dashboard`, organizado por áreas y filtrado por rol activo:

- `doctor`: Consultorio Médico y Evolución, que abre por defecto la agenda de hoy. El médico puede consultar el directorio clínico desde ese flujo.
- `admissions`: Admisión y Sala de Espera y Gestión de Pacientes.
- `system_admin`: acceso a todos los módulos, incluidas las vistas de agenda, pacientes e historia clínica, además de Facturación, Reportes, Configuración y Seguridad/Auditoría.
- `audit_security`: Reportes y Seguridad/Auditoría, en modo de solo lectura.

Las rutas del servidor aplican RBAC independientemente de las tarjetas y enlaces del menú. Recepción puede gestionar citas y datos demográficos, pero no abrir historias clínicas. `system_admin` puede consultar todas las vistas y gestionar funciones administrativas, pero no puede crear ni modificar evoluciones SOAP o recetas salvo que su cuenta también conserve un rol Médico activo; el servidor vuelve a comprobar ese rol en cada operación clínica. Auditoría no puede administrar usuarios ni acceder a historias clínicas.

En `/admin/users`, solo `system_admin` puede crear cuentas, editar accesos y vincular cuentas médicas. Los cambios de acceso se guardan de forma transaccional, se registran en auditoría y revocan las sesiones existentes del usuario afectado. Desde esa pantalla también se pueden asociar cuentas médicas con profesionales existentes. Solo los perfiles asociados aparecen como médicos disponibles para agendar.

El directorio médico utiliza `specialties` y la relación `doctor_specialties` para asociar especialidades al perfil profesional, con una especialidad principal. El catálogo inicial incluye Medicina General, Pediatría, Traumatología, Cardiología y Ginecología. Ejecuta `npm run db:migrate` para aplicar `010_doctor_specialties_seed.sql`; esta migración también asocia los perfiles existentes cuando su campo de especialidad coincide con una de esas especialidades. Los selectores de la agenda muestran únicamente médicos con perfil no anulado, cuenta activa y rol Médico activo.

En `/admin/doctors`, el botón **Editar** abre el perfil con los datos existentes precargados. Los cambios se guardan mediante `POST /admin/doctors/save` con consultas parametrizadas; allí también se puede cambiar la especialidad principal y activar o desactivar el perfil. Al guardar, se muestra una confirmación y se conserva la asociación de la especialidad principal en `doctor_specialties`.

### Calendario médico

La ruta `/agenda` ofrece a `admissions` y `system_admin` una vista mensual, semanal y de lista con filtros por médico y sede. Las citas se cargan bajo demanda desde `GET /api/calendar/appointments` usando el rango visible del calendario; el rango se valida y limita a 62 días. El listado operativo queda acotado a los últimos tres días y los próximos 30; al abrir una cita histórica, `?date=YYYY-MM-DD` centra el listado y calendario en esa fecha. Al seleccionar un día se abre el formulario de agendamiento con la fecha precargada; su envío AJAX codifica los campos como `application/x-www-form-urlencoded`, formato que procesa el middleware Express junto con el token CSRF. Desde el listado, Recepción puede llamar al paciente de forma asíncrona, lo que cambia la cita a `In Consultation` y registra la transición en auditoría.

La creación continúa usando `POST /appointments/create` y `GET /api/doctor-availability`; ambas operaciones quedan restringidas a Recepción y el servidor vuelve a validar la matriz de horarios, la duración y los conflictos antes de guardar. Los cambios de estado se procesan mediante `POST /appointments/:id/status`, se autorizan para médicos y admisión y se auditan. El médico solo puede cambiar el estado de sus propias citas. La agenda médica de hoy permite abrir directamente la historia clínica con el `appointment_id`; al guardar SOAP, el servidor valida que la cita corresponda al paciente y al médico autenticado y vincula la consulta a la cita. La vista carga FullCalendar 6.1.19 desde jsDelivr; el Content Security Policy permite ese origen para scripts.

Las modificaciones de notas SOAP guardadas están disponibles solo para médicos activos y únicamente durante las 24 horas posteriores a `medical_consultations.created_at`; el servidor vuelve a validar el límite dentro de la transacción clínica. No se solicita OTP para editar una nota. Las diferencias reales se escriben por campo en `soap_audit_logs`, dentro de esa transacción, con valores previo y nuevo, usuario, fecha e IP. La bitácora tiene un trigger de solo inserción y no almacena contenido clínico en los logs generales de acceso. Los formularios y borradores SOAP conservan la protección CSRF; no hay excepciones para estas rutas.

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
- `/admin/security/audit` muestra hasta 100 eventos recientes a `system_admin` y `audit_security`. Es una vista de solo lectura y omite los detalles JSON y cualquier contenido clínico.
- La vista no administra respaldos ni políticas de privacidad; esos procesos aún requieren procedimientos operativos externos.
- El detalle auditado contiene metadatos operativos; no registra contraseñas ni el contenido clínico del SOAP o de las recetas.
- La autorización de rutas sigue los roles y reglas de la aplicación; la gestión de facturas queda restringida a `system_admin`.
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
