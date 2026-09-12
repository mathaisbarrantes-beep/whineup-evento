# WhineUp: checklist de publicación

## 1. Infraestructura

1. Crea un servicio Node en Render, Railway o VPS.
2. Conecta el repositorio y ejecuta `npm ci` como build y `npm start` como start.
3. Configura un dominio propio con HTTPS.
4. Define todas las variables de `.env.example` en el panel del proveedor. No subas `.env`.
5. Comprueba `https://TU-DOMINIO/api/salud` y configura el health check.

`render.yaml` incluye una configuración inicial para Render.

## 2. Firestore y respaldos

1. Crea un proyecto Firebase y una cuenta de servicio.
2. Configura `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL` y `FIREBASE_PRIVATE_KEY`.
3. Crea la colección `tickets` y restringe el acceso público. El servidor usa Firebase Admin.
4. Programa exportaciones y verifica la restauración antes del primer evento.
5. En producción la app se detiene si Firestore no está configurado; no se permite el almacenamiento en memoria.

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
