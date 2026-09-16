# Cortesías de preventa — diseño

## Alcance

Premiar a quien compra antes de una fecha límite con algo que se reclama en el
evento, por ejemplo **un shot gratis** en HALLOWEEN PARTY. El beneficio se
configura por evento en el panel, se promete en la portada, en la compra, en la
página del ticket y en los correos, y se reclama en la barra escaneando **el
mismo QR** de la entrada.

Queda fuera:

- Más de una cortesía por evento o niveles escalonados (shot hasta el 21, otra
  cosa hasta el 30).
- El modo Cortesía en el escáner del panel (el de computadora); ese solo
  informa.
- Cambiar las plantillas de EmailJS.
- Asignar cortesías en bloque a entradas creadas antes de configurarla: para
  eso está el botón a mano.
- Control de stock de lo que se regala.

## Decisiones

Tomadas con el usuario el 2026-09-16:

1. **Canje con modo Cortesía** en el escáner del teléfono: la puerta avisa, la
   barra entrega escaneando el mismo QR. Una sola vez y solo si la entrada ya
   pasó por la puerta.
2. **Por evento y a mano:** la regla automática se configura en el evento, y el
   admin puede dar o quitar la cortesía de una entrada puntual.
3. **Cuenta cuando se manda el comprobante:** la hora que decide es la de
   creación de la entrada, no la de confirmación del pago.
4. **Las invitaciones también la traen** si se generan antes de la fecha límite.
5. **Nombres:** lo nuevo se llama **cortesía**. Las entradas gratis que genera
   el panel, que hasta ahora se llamaban «cortesía», pasan a llamarse
   **invitación** en toda la interfaz y en el código.
6. **La cortesía queda fija en cada entrada:** se copia al crearla. Cambiar el
   evento después no altera lo que ya se prometió.
7. **Contador por evento** en el panel: cuántas entradas traen cortesía y
   cuántas se entregaron.

## Datos

```sql
alter table public.eventos
  add column cortesia text,
  add column cortesia_hasta timestamptz,
  add constraint eventos_cortesia_completa
    check ((cortesia is null) = (cortesia_hasta is null)),
  add constraint eventos_cortesia_largo
    check (cortesia is null or char_length(cortesia) between 1 and 60);

alter table public.entradas
  add column cortesia text,
  add column cortesia_entregada_en timestamptz,
  add column cortesia_entregada_por uuid references auth.users(id),
  add constraint entradas_cortesia_entregada
    check (cortesia_entregada_en is null or cortesia is not null);
```

Las columnas son opcionales y el código actual no las lee, así que la migración
se puede aplicar antes de desplegar.

### Canje atómico

`public.canjear_cortesia(p_entrada_id uuid, p_staff_id uuid)` devuelve
`(permitido boolean, motivo text, nombre text, evento text, cortesia text,
entregada_en timestamptz)`. Igual que `validar_entrada`, bloquea la fila con
`for update`, así que dos escaneos simultáneos no pueden entregar dos veces.

| Condición, en este orden | `permitido` | `motivo` |
|---|---|---|
| La entrada no existe | false | `NO_ENCONTRADA` |
| `cortesia` es nula | false | `SIN_CORTESIA` |
| `estado <> 'INGRESADO'` | false | `NO_INGRESO` |
| `cortesia_entregada_en` ya tiene valor | false | `YA_ENTREGADA` (devuelve la hora) |
| Ninguna de las anteriores | true | `ENTREGAR`, y guarda la hora y quién entregó |

- Los motivos van como códigos; los mensajes los arma el servidor.
- **Toda columna se escribe con su tabla** (`e.nombre`, `e.cortesia`,
  `ev.nombre`). Las columnas de salida `nombre`, `evento`, `cortesia` y
  `entregada_en` son variables dentro de la función, y un nombre suelto repite
  el error 42702 que rompió `validar_entrada`.
- Permisos: `revoke all … from public, anon, authenticated` y `grant execute …
  to service_role`.

## Reglas en el servidor

- `cortesiaVigente(evento, ahora)` (función pura en `lib/eventos.js`) recibe el
  evento ya mapeado (`cortesia`, `cortesiaHasta`). Devuelve el texto si hay
  cortesía y `ahora <= cortesiaHasta`; si no, devuelve `null`. El límite es
  inclusivo.
- `mapEventoRow` siempre incluye `cortesia` y `cortesiaHasta`. Solo
  `listarPublicos` los pone en `null` cuando no están vigentes, así el panel y la
  creación de entradas ven siempre el valor real.
- **Al crear entradas**, `POST /api/crear-ticket` y `POST /api/admin/crear-qr`
  guardan `cortesia = cortesiaVigente(evento, new Date())`.
- **Configurar el evento:** `POST` y `PUT /api/admin/eventos` aceptan `cortesia`
  y `cortesiaHasta`.
  - Van los dos o ninguno; los dos vacíos quitan la cortesía.
  - Texto recortado, de 1 a 60 caracteres, y fecha válida.
  - Si algo falla, responde 400 con un mensaje claro.
- **A mano (solo admin):** `PUT /api/admin/entradas/:id/cortesia` con
  `{ dar: true | false }`.
  - `dar: true` copia el texto **actual** del evento, aunque la fecha ya haya
    pasado. Responde 400 si el evento no tiene cortesía y 409 si la entrada ya
    tiene una.
  - `dar: false` la borra. Responde 409 si ya se entregó.
- **Canje (staff y admin):** `POST /api/canjear-cortesia` con `{ ticketId }`
  llama a la función con `req.usuario.id`.
  - Resultado evaluado: `{ ok: true, permitido, motivo, mensaje, nombre,
    evento, cortesia, entregadaEn }`, con HTTP 200 si `permitido` y 403 si no,
    como `validar-ticket`.
  - Fallo del sistema: `ok: false`.
  - Un id que no es uuid equivale a `NO_ENCONTRADA` sin consultar la base.
- **Validar entrada:** si `permitido`, la respuesta suma `cortesia` cuando la
  entrada trae una sin entregar. Se lee con `obtenerPorId`, una consulta más
  que solo sirve para mostrar.

## API: campos nuevos

| Ruta | Agrega |
|---|---|
| `GET /api/eventos` (público) | `cortesia` y `cortesiaHasta` **solo si están vigentes** según la hora del servidor; si no, `null` |
| `GET /api/admin/eventos` | `cortesia` y `cortesiaHasta` siempre, más `cortesias: { asignadas, entregadas }` |
| `GET /api/admin/entradas` | `cortesia` y `cortesiaEntregadaEn` por entrada |
| `GET /api/ticket/:id` (público) | `cortesia` y `cortesiaEntregada` (booleano) |
| `POST /api/crear-ticket` y `POST /api/admin/crear-qr` | `cortesia` en cada ticket devuelto |

El contador usa dos conteos exactos por evento (`count: 'exact', head: true`),
uno con cortesía y otro entregadas, en paralelo. Contar en JavaScript quedaría
cortado en las 1000 filas que devuelve Supabase por pedido.

## Correos

`paramsDeTicket` recibe la entrada y, si trae cortesía:

- agrega al final de `mensaje`: «Tu entrada incluye una cortesía: {texto}. La
  reclamás en la barra mostrando este mismo QR, después de entrar.»
- manda la variable nueva `cortesia` (vacía si no hay).

Aplica a los tres correos: solicitud de compra, entrada activada e invitación.
Las plantillas ya imprimen `mensaje`, así que no hace falta tocarlas.

## Interfaz

### Escáner del teléfono (`/scanner`)

- Selector **Entrada | Cortesía** arriba. El modo activo tiene su propio color
  en la barra y se recuerda por teléfono en `localStorage` (con `try/catch`; si
  falla, arranca en Entrada).
- **Modo Entrada:** como hoy. Si la respuesta trae `cortesia`, «Adelante» suma
  la línea «Trae cortesía: {texto}».
- **Modo Cortesía:** llama a `/api/canjear-cortesia`. Resultados:

| Resultado | Color | Título | Detalle |
|---|---|---|---|
| `ENTREGAR` | verde | Entregar | {cortesía} · {nombre} |
| `YA_ENTREGADA` | rojo | Ya se entregó | a las {hora} |
| `SIN_CORTESIA` | rojo | Sin cortesía | Esta entrada no trae cortesía. |
| `NO_INGRESO` | rojo | Todavía no entró | Primero tiene que pasar por la puerta. ¿Estás en modo Cortesía? |
| `NO_ENCONTRADA` | rojo | Ticket no encontrado | — |
| `ok: false` o sin red | ámbar | Sin validar / Sin conexión | como hoy |

- La espera de 8 s para no releer el mismo código se lleva por modo.

### Panel (`/scanner-dashboard`)

- **Formulario de evento:** campos «Cortesía (ej. 1 shot gratis)» y «Válida
  para compras hasta» (`datetime-local`, que se envía en ISO como la fecha del
  evento). Al editar, se cargan los valores actuales.
- **Lista de eventos:** «Cortesía: {texto} · hasta {fecha}» o «· vencida», y el
  contador «{asignadas} con cortesía · {entregadas} entregadas».
- **Lista de entradas:** estado «Cortesía: {texto} · sin entregar» o
  «· entregada {hora}».
  - Solo el admin ve los botones «Dar cortesía» (si la entrada no tiene y su
    evento sí) y «Quitar cortesía» (si tiene una sin entregar).
  - El panel ya sabe el rol, así que el staff solo ve el estado.
- **Escáner embebido:** solo entradas; muestra «Trae cortesía: {texto}».
- **Renombrado:**
  - La sección «Generar QR de cortesía» pasa a «Generar invitaciones».
  - La etiqueta «Cortesía» de la lista pasa a «Invitación».
  - En el código, `MAX_CORTESIAS` pasa a `MAX_INVITACIONES`, y se corrigen los
    comentarios que usan «cortesía» para esas entradas.

### Portada (`/`)

- Con la cortesía vigente, el destacado, la tarjeta y el modal muestran una
  línea resaltada: «Comprando antes del {fecha, hora}: {texto}».
- El paso 3 de la compra dice «Tu entrada incluye: {texto}. La reclamás en la
  barra con este mismo QR, después de entrar.», **solo si** el ticket devuelto
  trae `cortesia`.

### Página del ticket (`/ticket`)

- Muestra «Incluye cortesía: {texto}» con el estado «Por reclamar en la barra»
  o «Entregada».

## Pruebas

Cada prueba se escribe antes que el código y se ve fallar.

- **`cortesiaVigente`:** antes, justo en y después del límite; sin cortesía;
  datos incompletos.
- **Repositorio de eventos:** validación de los dos campos (ambos o ninguno,
  largo, fecha), mapeo con vigencia en la vista pública y contador.
- **Repositorio de entradas:**
  - asignación al crear compras e invitaciones;
  - dar y quitar a mano, con sus errores 400 y 409;
  - canje: cómo cada motivo se traduce en su mensaje, y que un id inválido no
    consulte la base.
- **Rutas:** existen y piden sesión (401 sin token, 503 sin configuración).
  Dar y quitar a mano es solo para admin.
- **Correos:** que el texto y la variable estén cuando hay cortesía, y que no
  cambien cuando no hay.
- **Función SQL:** probada en producción con un bloque `do … raise` que se
  revierte, en los cinco motivos. Además se comprueban los permisos: como
  `service_role` funciona, y `anon` da 42501.
- **Navegador**, con dobles de `fetch` en el servidor local:
  - los dos modos del escáner con cada fila de la tabla, y que recuerde el modo;
  - en el panel, el formulario, la lista, el contador y los botones según el
    rol;
  - la línea de la portada, vigente y vencida;
  - la página del ticket y el mensaje del paso 3.

## Despliegue

1. Migración en Supabase, que solo agrega y no rompe el código actual.
   Actualizar `supabase/schema.sql` con lo mismo.
2. Código: commit y push **solo con el visto bueno del usuario**. Luego se
   verifica en producción.
3. Prueba real del usuario:
   - configurar la cortesía en HALLOWEEN PARTY;
   - generar una invitación, que debe traerla;
   - escanearla en modo Entrada («Trae cortesía») y después en modo Cortesía
     («Entregar» y luego «Ya se entregó»).

## Requisitos previos

- **Conector `supabase-whineup` conectado.** El 2026-09-16 no arrancó a tiempo
  porque `npx … @latest` descargó la versión 0.12.0 en 20 s. El paquete ya
  quedó en caché (3 s), así que basta con reconectarlo.
- **Login con Google activo en Supabase.** Sin él nadie puede comprar, y la
  preventa no tiene a quién premiar.
