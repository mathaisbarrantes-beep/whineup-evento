# Checklist de publicacion

## 0. Requisitos

Node.js 18.17 o superior. Comprueba con `node -v`.

```bash
npm install
```

## 1. Secretos

Ninguno de estos valores debe acabar en un commit. Generalos y pegalos en el
panel de variables de entorno de tu proveedor.

```bash
npm run secreto
npm run staff -- admin@tudominio.com "UNA CONTRASENA LARGA" admin "Tu nombre"
```

El primero imprime `TICKET_SIGNING_SECRET`, el segundo `STAFF_USERS`.

Si cambias `TICKET_SIGNING_SECRET`, **todos los QR ya emitidos dejan de
funcionar**. Guardalo bien.

## 2. Firestore

1. Crea un proyecto en Firebase y, dentro, una base de datos Firestore.
2. **Configuracion del proyecto -> Cuentas de servicio -> Generar clave
   privada**. El archivo descargado no se sube al repositorio.
3. Copia `project_id`, `client_email` y `private_key` a las variables
   `FIREBASE_*`.
4. Publica las reglas para que nadie acceda directamente a la base de datos:

```bash
firebase deploy --only firestore:rules
```

5. Activa las exportaciones programadas y **restaura una** en un proyecto de
   pruebas antes del evento.

En produccion el servidor **no arranca** sin Firestore: es lo que garantiza que
una entrada se use una sola vez.

## 3. EmailJS

Sigue [EMAILJS.md](EMAILJS.md). Resumen: crear el servicio, activar el acceso
desde servidor en *Account -> Security*, crear las dos plantillas y copiar los
cinco identificadores.

## 4. Despliegue

### Render

`render.yaml` ya esta preparado. Conecta el repositorio y rellena en el panel
las variables marcadas como `sync: false`.

### Vercel

`vercel.json` enruta todo a `api/index.js`. Define las mismas variables en
*Settings -> Environment Variables*.

En ambos casos: dominio propio con HTTPS, y `PUBLIC_URL` apuntando a el sin
barra final.

## 5. Comprobaciones antes de abrir la venta

```bash
curl https://TU-DOMINIO/api/salud
```

Debe responder `"persistencia": "firestore"` y `"emailjs": true`.

Despues, el ensayo completo:

1. Compra de prueba desde la web publica.
2. Llega el correo de "solicitud recibida", **sin QR**.
3. Entra en `/login`, confirma el pago desde el panel.
4. Llega el segundo correo, **con el QR visible**.
5. Escanea ese QR desde el panel: **permitido**.
6. Escanealo otra vez: **denegado, ya utilizado**.
7. Anula otra entrada y comprueba que su QR queda rechazado.
8. Abre `/scanner-dashboard` sin sesion: redirige al login.

Si el paso 6 no falla, no publiques.

## 6. El dia del evento

- Telefonos del staff cargados y con datos moviles propios, sin depender del
  wifi del local.
- Alguien con acceso al panel de administracion disponible por telefono.
- Lista impresa de respaldo por si se cae la conexion.
- Un procedimiento acordado para entradas duplicadas en la puerta: quien decide
  y con que criterio.

## 7. Legal

Completa `terminos.html` y `privacidad.html` antes de cobrar. Ver
[RECOMENDACIONES.md](RECOMENDACIONES.md), seccion final.
