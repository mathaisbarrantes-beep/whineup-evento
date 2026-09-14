# Contexto del proyecto

Venta de entradas para eventos con codigo QR de un solo uso, envio del QR por
correo y validacion en la puerta desde la misma web.

Este archivo se carga automaticamente al abrir una sesion nueva. Contiene el
**por que** de las decisiones, que es lo que no se deduce leyendo el codigo.

---

## Estado actual

| | |
| --- | --- |
| Rama de trabajo | `seguridad-y-emailjs` (commit `cef1cd4`, pusheada) |
| `main` | `05d7613`, la version **anterior e insegura**. No mergeada todavia |
| Repositorio | github.com/mathaisbarrantes-beep/whineup-evento |
| Evento configurado | HALLOWEEN PARTY, 31 Oct 2026, WhineUp CR, 45 000 CRC |

### Lo que falta antes de publicar

1. **Ejecutar el codigo por primera vez.** La reescritura se hizo en una maquina
   sin Node.js instalado. Se verifico la sintaxis de los diez archivos JS y de
   los bloques `<script>` en linea, pero **la logica nunca se ejecuto**.
   Primer paso en cualquier sesion nueva: `node -v && npm test`.
2. **Ensayo manual completo**, los 8 pasos de [DEPLOYMENT.md](DEPLOYMENT.md)
   seccion 5. El critico es el 6: escanear dos veces el mismo QR y comprobar
   que la segunda vez se rechaza.
3. **Credenciales de EmailJS.** Faltan los cinco identificadores y `PUBLIC_URL`.
   Ver [EMAILJS.md](EMAILJS.md).
4. **Datos de pago reales** en `public/index.html`: `paypal@whineup.cr` y
   `+506 8888-0000` son marcadores de posicion.
5. **`terminos.html` y `privacidad.html`** estan practicamente vacios. No se
   puede cobrar sin completarlos.
6. **Mergear a `main`** cuando lo anterior este verificado.

---

## Como funciona el flujo

```
Comprador            Servidor                    Staff
    |                   |                          |
    |- datos + ref ---->| estado PENDIENTE_PAGO    |
    |                   |- correo "recibido" ----->| (sin QR)
    |                   |<--- confirma el pago ----|
    |<-- correo con QR -| estado PENDIENTE         |
    |                   |                          |
    |---- muestra QR ---|-------- escanea -------->| estado INGRESADO
```

Estados: `PENDIENTE_PAGO` -> `PENDIENTE` -> `INGRESADO`. Aparte, `ANULADO`
desde el panel, que invalida el QR en cualquier momento.

---

## Decisiones tomadas y por que

No revertir ninguna de estas sin entender el motivo: cada una corrige un fallo
real que estaba en el codigo anterior. El detalle completo esta en
[SEGURIDAD.md](SEGURIDAD.md).

### El QR lleva `<id>.<firma HMAC-SHA256>`, no un UUID pelado

Antes contenia solo el UUID, que aparecia en la URL del ticket, en el panel y
en la respuesta de la API: quien viera uno podia regenerar el QR con cualquier
web. Ahora sin `TICKET_SIGNING_SECRET` no se puede fabricar una firma valida, y
el escaner descarta los falsos sin consultar la base de datos.

Tampoco es una URL: un QR con URL lo abre cualquier camara de telefono. El
token pelado no significa nada para quien lo escanee por casualidad.

### Firestore es obligatorio en produccion

El servidor se niega a arrancar sin el. El almacenamiento en memoria no
garantiza el uso unico: en serverless cada instancia tiene su propio `Map`, asi
que la misma entrada entraba una vez por instancia. El consumo va dentro de una
transaccion atomica para que dos escaneres simultaneos no acepten el mismo
codigo.

### Los usuarios de staff viven en la variable `STAFF_USERS`, no en la base de datos

Las **sesiones** si estan en Firestore (coleccion `sesiones`, guardando el
SHA-256 del token, no el token). Los **usuarios** no.

Para un equipo de 3-10 personas compensa: no hay endpoint de registro que
atacar, y un filtrado de Firestore no expone ningun hash de contrasena. El
costo es que dar de alta a alguien exige editar la variable y redesplegar.

Si el equipo crece de ~10, o hay rotacion entre eventos, o se quiere que cada
uno cambie su contrasena, entonces si conviene una coleccion `usuarios`.
**Esto quedo pendiente de decidir con el usuario.**

### EmailJS por API REST desde el servidor, no con el SDK del navegador

El uso habitual de EmailJS deja la clave publica a la vista de cualquiera, que
puede gastar la cuota. Aqui ningun identificador de EmailJS llega al navegador.

Exige activar **Account -> Security -> "Allow EmailJS API for non-browser
applications"**. Sin eso EmailJS rechaza todo y no sale ni un correo. Es el
paso que se olvida siempre.

### El QR va como URL firmada, no como adjunto

`{{qr_url}}` apunta a `/qr/<token>/entrada.png` del propio dominio. Esquiva el
limite de tamano del cuerpo de la API REST de EmailJS, y Gmail y Outlook
muestran imagenes remotas sin problema. La URL lleva la firma, asi que no es
adivinable.

### `textContent` siempre, `innerHTML` nunca

El panel de administracion pintaba el nombre del comprador con `innerHTML`: un
comprador podia poner `<img src=x onerror=...>` como nombre y ese codigo se
ejecutaba en el navegador del administrador, con su sesion activa. Hay
ayudantes `crear()` y `vaciar()` en `views/scanner-dashboard.html` y en
`public/index.html` para construir nodos sin esa via.

### `views/` frente a `public/`

`express.static` publicaba toda la carpeta `public/`, asi que pedir
`/scanner-dashboard.html` se saltaba el control de sesion. Las paginas que
exigen sesion viven ahora en `views/`, fuera del directorio estatico.

**Cualquier pagina nueva que requiera sesion va en `views/`, no en `public/`.**

### Defensa CSRF sin libreria

Tres capas: cookie `SameSite=strict`, solo se aceptan cuerpos JSON (un
formulario HTML de otro sitio no puede fabricar uno), y verificacion de la
cabecera `Origin`. Por eso **no** esta `express.urlencoded`: quitarlo es
deliberado.

### Cero dependencias nuevas

Se usa el `fetch` nativo de Node 18+ para EmailJS. `nodemailer` se carga de
forma perezosa y solo si hay SMTP configurado. Las dependencias siguen siendo
las cinco originales.

### Al filtrar por estado se ordena en memoria

`lib/store.js`, funcion `listTickets`. Combinar `where` con `orderBy` en
Firestore obliga a crear un indice compuesto, y la consulta falla en produccion
justo cuando mas falta hace. No "optimizar" eso anadiendo el `orderBy`.

### El precio sale del catalogo del servidor

`lib/eventos.js`. El navegador envia solo el `eventoId`; nunca el importe ni el
tipo de entrada. Antes llegaban desde el formulario.

---

## Estructura

```
server.js                 Rutas HTTP y nada mas
lib/config.js             UNICO archivo que lee process.env
lib/security.js           Cabeceras, CSP, rate limit, escapeHtml, cookies
lib/tokens.js             Firma y verificacion de los codigos QR
lib/store.js              Firestore (produccion) o memoria (solo desarrollo)
lib/auth.js               Sesiones de staff, roles, CSRF
lib/email.js              EmailJS via REST, con SMTP de respaldo
lib/eventos.js            Catalogo de eventos y precios
public/                   Paginas publicas (servidas de forma estatica)
views/                    Paginas que exigen sesion (nunca estaticas)
scripts/                  Generador de secretos y hashes scrypt
test/                     Pruebas con el runner nativo de Node
firestore.rules           Bloquea el acceso directo de clientes
api/index.js              Punto de entrada para Vercel
```

### Regla sobre secretos

`lib/config.js` es el unico que toca `process.env`. Nada de lo que contiene se
envia al navegador. Comprobacion rapida, no debe devolver nada:

```bash
grep -rn "EMAILJS\|FIREBASE\|SMTP\|TICKET_SIGNING" public/ views/
```

---

## Endpoints

| Metodo | Ruta | Acceso |
| --- | --- | --- |
| GET | `/api/salud` | publico |
| GET | `/api/eventos` | publico |
| GET | `/api/estadisticas-publicas` | publico |
| POST | `/api/crear-ticket` | publico, 5 por 10 min por IP |
| GET | `/api/ticket/:token` | token firmado |
| GET | `/qr/:token/entrada.png` | token firmado |
| POST | `/api/login` | publico, con limite |
| POST | `/api/logout` | publico |
| GET | `/api/session-status` | publico |
| POST | `/api/validar-ticket` | **staff o admin** |
| GET | `/api/admin/entradas` | admin |
| GET | `/api/admin/pagos-pendientes` | admin |
| POST | `/api/admin/confirmar-pago/:ticketId` | admin |
| POST | `/api/admin/anular/:ticketId` | admin |
| POST | `/api/admin/reenviar/:ticketId` | admin |
| POST | `/api/admin/crear-qr` | staff o admin |

Paginas: `/`, `/login`, `/ticket`, `/escaner`, `/scanner-dashboard` (con sesion).

---

## Convenciones

- **Todo en espanol**: mensajes al usuario, nombres de funciones y variables en
  el codigo nuevo, comentarios y documentacion.
- **Sin acentos ni caracteres especiales dentro de los archivos `.js`**. Evita
  problemas de codificacion entre Windows y los proveedores de despliegue. En
  los `.md` y en el HTML si se usan.
- Los comentarios explican **por que**, no que hace la linea.
- Los mensajes de error al navegador son genericos; el detalle va al log.
- Un fallo de correo nunca tumba una venta ni una validacion:
  `lib/email.js` no lanza, devuelve el resultado.

---

## Comandos

```bash
npm install
npm run dev        # servidor local con recarga
npm test           # pruebas de firma de tokens
npm run secreto    # genera TICKET_SIGNING_SECRET
npm run staff -- correo@dominio.com "CONTRASENA" admin "Nombre"
```

---

## Trampas conocidas

- **`TICKET_SIGNING_SECRET` no se rota con un evento en curso.** Cambiarlo
  invalida todos los QR ya emitidos.
- **`.env` no esta en el repositorio** y no debe estarlo. Al cambiar de maquina
  hay que recrearlo. Si el secreto de firma difiere entre maquinas, los QR
  firmados en una no validan en la otra.
- **Los QR con solo el UUID ya no sirven.** Si se llego a emitir alguno con la
  version anterior, hay que reenviarlo desde el panel.
- **Cuota de EmailJS**: 200 correos al mes en el plan gratuito, y cada entrada
  consume dos. Al generar cortesias en lote conviene desmarcar el envio.
- El limitador de peticiones vive en memoria: en serverless cuenta por
  instancia. Es una primera barrera, no sustituye a un WAF.

---

## Documentacion

| Archivo | Contenido |
| --- | --- |
| [README.md](README.md) | Arranque rapido y estructura |
| [EMAILJS.md](EMAILJS.md) | Configurar EmailJS y las plantillas de correo |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Checklist completo de publicacion |
| [SEGURIDAD.md](SEGURIDAD.md) | Auditoria: que estaba mal y como quedo |
| [RECOMENDACIONES.md](RECOMENDACIONES.md) | Que anadir despues, por prioridad |

Lo mas urgente de RECOMENDACIONES: cobro automatico por webhook en vez de
referencia manual, control de aforo (el campo existe pero no se aplica), y modo
sin conexion para el escaner.
