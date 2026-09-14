# WhineUp — entradas con QR de un solo uso

Venta de entradas para eventos, envio del codigo QR por correo y validacion en
la puerta desde la misma web. Sin base de datos en el navegador y sin ninguna
clave expuesta en el frontend.

## Como funciona

```
Comprador                     Servidor                      Staff
    |                            |                            |
    |-- datos + referencia ----->|                            |
    |                            |-- correo "recibido" ------>| (sin QR)
    |                            |                            |
    |                            |<---- confirma el pago -----|
    |<-- correo con el QR -------|                            |
    |                            |                            |
    |------ muestra el QR -------|-------> escanea ---------->|
    |                            |  PERMITIDO / DENEGADO      |
```

El QR contiene `<id>.<firma HMAC>`. Sin el secreto del servidor no se puede
fabricar uno valido. Al escanearlo, una transaccion atomica en Firestore lo
marca como usado: el segundo intento siempre se rechaza.

## Puesta en marcha

```bash
npm install
cp .env.example .env
npm run secreto
npm run staff -- admin@tudominio.com "UNA CONTRASENA LARGA" admin "Tu nombre"
```

Pega ambos resultados en `.env` y arranca:

```bash
npm run dev
```

- Web publica: <http://localhost:3000>
- Panel de staff: <http://localhost:3000/login>

Sin Firestore configurado arranca en modo memoria, solo para desarrollo.

```bash
npm test
```

## Documentacion

| Archivo | Contenido |
| --- | --- |
| [EMAILJS.md](EMAILJS.md) | Configurar EmailJS y las plantillas de correo |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Checklist completo antes de publicar |
| [SEGURIDAD.md](SEGURIDAD.md) | Auditoria: que estaba mal y como quedo |
| [RECOMENDACIONES.md](RECOMENDACIONES.md) | Que anadir a continuacion |

## Estructura

```
server.js                 Rutas HTTP
lib/config.js             Unico punto que lee variables de entorno
lib/security.js           Cabeceras, CSP, limite de peticiones, escapado
lib/tokens.js             Firma y verificacion de los codigos QR
lib/store.js              Firestore (produccion) o memoria (desarrollo)
lib/auth.js               Sesiones de staff, roles, proteccion CSRF
lib/email.js              EmailJS via API REST, con SMTP de respaldo
lib/eventos.js            Catalogo de eventos y precios
public/                   Paginas publicas
views/                    Paginas que exigen sesion
scripts/                  Generador de secretos y hashes
firestore.rules           Bloquea el acceso directo a la base de datos
```

## Aviso

`TICKET_SIGNING_SECRET` firma todos los QR. Si lo cambias, **todas las entradas
ya emitidas dejan de funcionar**. Guardalo fuera del repositorio y no lo rotes
con un evento en curso.
