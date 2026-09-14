# Auditoria de seguridad

Revision completa del repositorio antes de vender la primera entrada.
Estado: **todos los puntos listados aqui estan corregidos en el codigo.**

## Resumen del historial de Git

Se revisaron los 9 commits del repositorio buscando claves, tokens y
contrasenas. **No hay ningun secreto real en el historial**: solo los
marcadores de posicion de `.env.example`. No hace falta reescribir el
historial ni rotar nada por este motivo.

---

## Fallos criticos corregidos

### 1. Cualquiera podia quemar entradas ajenas

`POST /api/validar-ticket` no pedia autenticacion. Con el identificador de una
entrada (visible en la URL del ticket y en el panel), un tercero podia marcarla
como usada desde `curl`. El comprador legitimo se quedaba fuera del evento.

**Corregido:** el endpoint exige sesion de staff, y ademas limita el numero de
validaciones por minuto.

### 2. El "un solo uso" no estaba garantizado

Sin Firestore, el servidor guardaba las entradas en un `Map` en memoria. En
Vercel cada peticion puede caer en una instancia distinta, cada una con su
propio `Map`: **la misma entrada se podia usar una vez por instancia**. El
`DEPLOYMENT.md` afirmaba que el servidor se detenia sin Firestore; no lo hacia.

**Corregido:** en produccion el servidor no arranca sin Firestore y lo dice con
un mensaje explicito. La memoria queda reservada al desarrollo local. El
consumo de la entrada se hace dentro de una transaccion atomica, asi que dos
escaneres simultaneos no pueden aceptar el mismo codigo.

### 3. Datos personales de los compradores expuestos

`GET /api/ticket/:id` era publico y devolvia el documento completo: correo,
telefono y referencia de pago de cualquier comprador.

**Corregido:** el endpoint exige un token firmado y devuelve solo lo que el
titular necesita ver. Correo, telefono y referencia no salen nunca por ahi.

### 4. El QR era falsificable si se filtraba un identificador

El codigo QR contenia unicamente el UUID de la entrada. Ese UUID aparecia en la
URL del ticket, en el panel y en la respuesta de la API: quien viera uno podia
generar el QR correspondiente con cualquier generador online.

**Corregido:** el QR contiene `<id>.<firma HMAC-SHA256>`. Sin el secreto del
servidor no se puede fabricar una firma valida, y el escaner descarta los
codigos falsos sin llegar a consultar la base de datos.

### 5. XSS almacenado en el panel de administracion

El panel pintaba el nombre, el correo y la referencia de pago con `innerHTML`.
Un comprador podia escribir como nombre `<img src=x onerror="...">` y ese codigo
se ejecutaba en el navegador del administrador, con su sesion activa: robo de
cuenta con solo rellenar el formulario de compra.

**Corregido:** todo el contenido dinamico se inserta con `textContent`. Ademas
se anaden cabeceras CSP y se eliminan los caracteres de control en la entrada.

### 6. El panel de staff se servia sin sesion

`express.static` publicaba toda la carpeta `public/`, incluido
`scanner-dashboard.html`. Bastaba pedir `/scanner-dashboard.html` para saltarse
el middleware de autenticacion y ver la estructura interna del panel.

**Corregido:** la pagina vive ahora en `views/`, fuera del directorio estatico,
y solo se sirve tras comprobar la sesion.

### 7. Las sesiones se perdian (y no escalaban)

Las sesiones vivian en un `Map` en memoria: se borraban en cada despliegue y,
en serverless, el login practicamente no funcionaba.

**Corregido:** las sesiones se guardan en Firestore. Se almacena el **hash** del
token, no el token: ni con acceso de lectura a la base de datos se puede
suplantar a un miembro del staff.

---

## Fallos medios corregidos

| Problema | Solucion |
| --- | --- |
| El identificador de cada entrada se enviaba a `api.qrserver.com`, un tercero | El QR se genera en nuestro propio servidor |
| El nombre del comprador se insertaba sin escapar en el HTML del correo | Se escapa antes de construir el cuerpo |
| La misma referencia de pago podia generar entradas ilimitadas | Se detecta y se rechaza la referencia repetida |
| Sin limite de peticiones en compra, validacion ni consulta de QR | Limitador por IP en cada uno |
| Fuerza bruta contra el login evitable reiniciando el servidor | Contador persistente, por usuario y por IP |
| Sin CSP: cualquier inyeccion podia cargar scripts externos | CSP restrictiva mas `Permissions-Policy` y `COOP` |
| Cookie `SameSite=lax`, sin verificacion de origen | `SameSite=strict`, solo cuerpos JSON y comprobacion de `Origin` |
| Los errores devolvian detalles internos | Mensajes genericos al navegador, detalle solo en los logs |
| El precio y el tipo de entrada llegaban desde el navegador | Salen del catalogo del servidor |
| Expulsar a alguien de `STAFF_USERS` no cerraba su sesion | El rol se revalida en cada peticion |
| Reglas de Firestore sin definir | `firestore.rules` cierra todo acceso directo de clientes |

---

## Donde viven las claves

Ningun secreto esta en el codigo ni en el repositorio. `lib/config.js` es el
unico archivo que lee `process.env`, y nada de lo que contiene se envia al
navegador.

| Clave | Donde se define | Quien la ve |
| --- | --- | --- |
| `TICKET_SIGNING_SECRET` | Variable de entorno | Solo el servidor |
| `EMAILJS_PRIVATE_KEY` | Variable de entorno | Solo el servidor |
| `EMAILJS_PUBLIC_KEY` | Variable de entorno | Solo el servidor |
| `FIREBASE_PRIVATE_KEY` | Variable de entorno | Solo el servidor |
| `STAFF_USERS` (hashes) | Variable de entorno | Solo el servidor |
| `SMTP_PASSWORD` | Variable de entorno | Solo el servidor |

Comprueba que sigue siendo cierto en cualquier momento:

```bash
grep -rn "EMAILJS\|FIREBASE\|SMTP\|TICKET_SIGNING" public/ views/
```

No debe devolver ni una linea.

---

## Antes de publicar

- [ ] `npm run secreto` y guardar `TICKET_SIGNING_SECRET` en el proveedor
- [ ] `npm run staff -- admin@tudominio.com "CLAVE LARGA" admin "Nombre"`
- [ ] Firestore creado y `firebase deploy --only firestore:rules` aplicado
- [ ] `PUBLIC_URL` con el dominio real y HTTPS activo
- [ ] EmailJS configurado segun [EMAILJS.md](EMAILJS.md)
- [ ] `GET /api/salud` responde `"persistencia": "firestore"`
- [ ] Compra de prueba -> confirmacion -> correo recibido -> QR escaneado
- [ ] El mismo QR escaneado dos veces: la segunda vez **debe** ser rechazado
- [ ] Una entrada sin pago confirmado: rechazada
- [ ] `/scanner-dashboard` sin sesion: redirige al login
