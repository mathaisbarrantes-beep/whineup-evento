# WhineUp: checklist de publicación

## 1. Infraestructura

1. Crea un servicio Node en Render, Railway o VPS.
2. Conecta el repositorio y ejecuta `npm ci` como build y `npm start` como start.
3. Configura un dominio propio con HTTPS.
4. Define todas las variables de `.env.example` en el panel del proveedor. No subas `.env`.
5. Comprueba `https://TU-DOMINIO/api/salud` y configura el health check.

`render.yaml` incluye una configuración inicial para Render.

## 2. Supabase (base de datos, autenticación y respaldos)

1. Crea un proyecto en https://supabase.com/dashboard/projects, nombre `whineup-evento`.
2. Copia el contenido de `supabase/schema.sql` y pégalo en el SQL Editor del proyecto; ejecútalo una sola vez.
3. Configura `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (Settings → API → Project API keys → `service_role`, secreta) y `SUPABASE_ANON_KEY` (la clave `anon`/`public`, esa sí puede quedar visible en el navegador).
4. En Authentication → Providers, activa **Google** y sigue el asistente de Supabase para configurar el cliente OAuth de Google Cloud. En Authentication → URL Configuration, agrega la URL real del sitio en "Site URL" y "Redirect URLs".
5. Crea las cuentas de staff/admin manualmente en Authentication → Users → "Add user" (correo + contraseña). Después, en el SQL Editor, actualiza su rol: `update public.perfiles set rol = 'admin' where id = '<uuid del usuario>';` (o `'staff'`).
6. Programa respaldos automáticos en Settings → Database → Backups y verifica una restauración antes del primer evento.
7. En producción, si `SUPABASE_URL` o `SUPABASE_SERVICE_ROLE_KEY` faltan, las rutas que dependen de la base responden error en vez de guardar nada en memoria — no hay modo de respaldo silencioso.

## 3. Pagos

El flujo actual soporta dos operaciones seguras:

- PayPal: recibe una referencia y requiere confirmación del administrador.
- Número/transferencia: recibe el comprobante o número y requiere confirmación del administrador.

Un ticket queda en `PENDIENTE_PAGO` y su QR es rechazado por el scanner hasta que un administrador lo confirme desde el panel. Para automatizar PayPal, hay que crear una aplicación PayPal, guardar sus credenciales en variables de entorno y conectar un webhook verificado; nunca se debe confiar en una referencia enviada desde el navegador.

## 4. Email

Configura SMTP real con una contraseña de aplicación o proveedor transaccional. Verifica SPF, DKIM y DMARC del dominio. Haz una compra de prueba y confirma recepción, spam y adjunto QR.

## 5. Seguridad y administración

Genera un hash de contraseña sin guardar la contraseña en el repositorio:

```powershell
node -e "const c=require('crypto');const p=process.argv[1];const s=c.randomBytes(16).toString('hex');console.log('scrypt$'+s+'$'+c.scryptSync(p,s,64).toString('hex'))" "CAMBIA ESTA CONTRASEÑA"
```

Usa el resultado en `STAFF_USERS` con `passwordHash`. Cambia la contraseña de desarrollo antes de publicar. Revisa que el admin use HTTPS, activa backups y rota credenciales si fueron compartidas durante pruebas.

## 6. QR y acceso

1. Prueba cámara, permisos y conexión desde el teléfono real del staff.
2. Verifica que un ticket pagado entre una sola vez.
3. Verifica que un ticket pendiente, inexistente o repetido sea rechazado.
4. Prepara un procedimiento offline para caída de internet y un responsable de soporte.

## 7. Legal y operación

Publica términos, privacidad, política de reembolso, datos de contacto y datos fiscales según el país donde vendas. Define quién confirma pagos, quién atiende reclamos, cuánto tiempo conserva datos y cómo se revocan entradas.

## Criterio de salida

No publiques hasta completar: dominio HTTPS, Firestore real, PayPal o conciliación manual probada, SMTP real, usuarios con hash, respaldo restaurado y simulacro completo de compra-confirmación-validación.
