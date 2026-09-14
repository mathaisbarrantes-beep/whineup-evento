# Migración de WhineUp a Supabase — diseño

## Alcance

Este documento cubre el sub-proyecto **backend**: mover el almacenamiento de
entradas/eventos de Firestore a Supabase (Postgres), reemplazar el login de
staff hecho a mano por Supabase Auth con roles, agregar login con Google para
compradores, y garantizar que un QR no pueda usarse dos veces.

El **rediseño visual** (todas las páginas, con `/design`, modal de compra
funcional) es un sub-proyecto aparte que se especifica después de que este
quede aprobado, porque depende del contrato de la API que este documento
define (qué datos pide y devuelve cada endpoint).

No se automatiza el cobro (PayPal/transferencia siguen confirmándose a mano
por un admin, igual que hoy). No se agregan pruebas automatizadas: el
repositorio no tiene suite de tests hoy; se deja un plan de pruebas manual.

## Arquitectura

`server.js` (Express) sigue siendo el único componente que escribe en la base
de datos, usando la **service role key** de Supabase (equivalente a lo que
hoy hace con la cuenta de servicio de Firebase). El navegador solo usa
Supabase directamente para dos cosas:

1. El botón "Iniciar sesión con Google" (compradores) y el login por
   correo/contraseña (staff/admin) — ambos manejados por Supabase Auth desde
   el navegador con la **anon/publishable key**.
2. Guardar la sesión resultante (Supabase lo hace solo) y enviarla como
   `Authorization: Bearer <token>` en cada pedido a `/api/...`.

El servidor verifica ese token con Supabase, busca el rol de esa persona en
`perfiles`, y decide si puede hacer la operación pedida. Esto reemplaza el
sistema actual de cookies y `STAFF_USERS` en variable de entorno.

Importante: como el servidor siempre usa la service role key, las políticas
de RLS (más abajo) **no filtran nada de lo que hace `server.js`** — esa
clave las ignora a propósito, para que el servidor pueda hacer su trabajo.
El filtrado real (por ejemplo, "un comprador solo ve sus propias entradas",
o "la landing solo muestra eventos activos") lo tiene que hacer el código de
cada ruta con su propio `WHERE`. RLS queda como una segunda barrera para el
día en que algo se conecte directo con la clave pública (anon key) — hoy esa
clave solo se usa para el login, no para leer ni escribir tablas.

```
Navegador ──(Google / correo+contraseña)──> Supabase Auth
Navegador ──(Bearer token + datos)────────> Express (server.js)
Express   ──(service role key)────────────> Postgres de Supabase
```

Se elimina el modo "en memoria" que existe hoy como respaldo cuando Firebase
no está configurado (`MEMORY_TICKETS`, `STAFF_SESSIONS`). Es un cambio
deliberado: como el objetivo es que todo el flujo de datos viva en Supabase,
mantener un segundo almacenamiento paralelo solo agrega complejidad y un
lugar más donde algo puede desincronizarse. Si Supabase no está configurado,
el servidor arranca pero las rutas que necesitan base de datos responden con
un error claro en vez de fingir que funcionan.

## Modelo de datos

Tres tablas nuevas en Postgres, en el esquema `public`.

**`perfiles`** — un renglón por persona (comprador o staff), vinculado a la
cuenta de Supabase Auth. Se crea solo, automáticamente, la primera vez que
alguien inicia sesión.

**`eventos`** — reemplaza la lista fija `EVENTOS` que hoy está escrita en
`server.js`. El admin podrá crear, editar y desactivar eventos desde el
panel sin tocar código.

**`entradas`** — reemplaza la colección `tickets` de Firestore. Mismo ciclo
de vida que hoy: `PENDIENTE_PAGO` → `PENDIENTE` (pagado, QR activo) →
`INGRESADO` (QR ya usado). Se agrega `CANCELADO` para uso futuro del admin
(por ejemplo, si hay que anular una entrada por reembolso), aunque este
diseño no construye una pantalla para eso todavía.

## SQL completo

Un solo archivo (`supabase/schema.sql`) para pegar en el SQL Editor de
Supabase, o para que yo lo aplique directo si me das acceso al proyecto una
vez creado.

```sql
-- Extensión necesaria para generar UUIDs
create extension if not exists pgcrypto;

-- ========== PERFILES ==========

create table public.perfiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nombre text,
  rol text not null default 'cliente' check (rol in ('cliente','staff','admin')),
  creado_en timestamptz not null default now()
);

alter table public.perfiles enable row level security;

create policy "perfiles_select" on public.perfiles
  for select using (
    auth.uid() = id
    or exists (select 1 from public.perfiles p where p.id = auth.uid() and p.rol in ('staff','admin'))
  );

-- Crea el perfil solo, la primera vez que alguien inicia sesión
create or replace function public.manejar_nuevo_usuario()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.perfiles (id, nombre)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', new.email))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.manejar_nuevo_usuario();

-- Función auxiliar: rol de la persona que está haciendo el pedido.
-- (security definer para que no choque con las políticas de RLS de perfiles)
create or replace function public.rol_actual()
returns text
language sql
security definer
stable
set search_path = public
as $$
  select rol from public.perfiles where id = auth.uid();
$$;

-- ========== EVENTOS ==========

create table public.eventos (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  fecha timestamptz not null,
  lugar text not null,
  precio numeric(10,2) not null check (precio >= 0),
  categoria text not null default 'General',
  descripcion text,
  cupo_maximo integer check (cupo_maximo is null or cupo_maximo > 0),
  activo boolean not null default true,
  creado_por uuid references auth.users(id),
  creado_en timestamptz not null default now()
);

alter table public.eventos enable row level security;

create policy "eventos_lectura_publica" on public.eventos
  for select using (activo = true or public.rol_actual() in ('staff','admin'));

create policy "eventos_admin_escritura" on public.eventos
  for all using (public.rol_actual() = 'admin') with check (public.rol_actual() = 'admin');

-- ========== ENTRADAS ==========

create table public.entradas (
  id uuid primary key default gen_random_uuid(),
  evento_id uuid not null references public.eventos(id),
  usuario_id uuid references auth.users(id),
  nombre text not null,
  correo text not null,
  telefono text,
  tipo_entrada text not null default 'General' check (tipo_entrada in ('General','VIP')),
  precio numeric(10,2) not null,
  metodo_pago text check (metodo_pago in ('paypal','numero')),
  referencia_pago text,
  pagado boolean not null default false,
  estado text not null default 'PENDIENTE_PAGO' check (estado in ('PENDIENTE_PAGO','PENDIENTE','INGRESADO','CANCELADO')),
  pago_confirmado_por uuid references auth.users(id),
  pago_confirmado_en timestamptz,
  ingresado_en timestamptz,
  generado_por uuid references auth.users(id),
  creado_en timestamptz not null default now()
);

create index entradas_usuario_id_idx on public.entradas(usuario_id);
create index entradas_evento_id_idx on public.entradas(evento_id);
create index entradas_estado_idx on public.entradas(estado);

alter table public.entradas enable row level security;

create policy "entradas_select_propias" on public.entradas
  for select using (auth.uid() = usuario_id or public.rol_actual() in ('staff','admin'));

-- No hay políticas de INSERT/UPDATE para usuarios comunes: todas las
-- escrituras las hace el servidor con la service role key, que ignora RLS.
-- Esto es intencional (ver "Arquitectura" en el diseño): centraliza la
-- validación de negocio en un solo lugar en vez de duplicarla en políticas.

-- ========== INVALIDAR QR AL ESCANEAR (atómico) ==========

create or replace function public.validar_entrada(p_entrada_id uuid)
returns table (
  permitido boolean,
  mensaje text,
  nombre text,
  evento text,
  tipo_entrada text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entrada public.entradas%rowtype;
  v_evento_nombre text;
begin
  -- "for update" bloquea el renglón: si dos escaneos llegan al mismo
  -- tiempo, el segundo espera a que termine el primero y ve el estado ya
  -- actualizado. Por diseño de Postgres, no pueden pasar los dos.
  select * into v_entrada from public.entradas where id = p_entrada_id for update;

  if not found then
    return query select false, 'Ticket no encontrado.'::text, null::text, null::text, null::text;
    return;
  end if;

  if not v_entrada.pagado or v_entrada.estado = 'PENDIENTE_PAGO' then
    return query select false, 'Denegado: pago pendiente de confirmación.'::text, null::text, null::text, null::text;
    return;
  end if;

  select nombre into v_evento_nombre from public.eventos where id = v_entrada.evento_id;

  if v_entrada.estado <> 'PENDIENTE' then
    return query select false, 'Denegado: ticket ya utilizado.'::text, v_entrada.nombre, v_evento_nombre, v_entrada.tipo_entrada;
    return;
  end if;

  update public.entradas
    set estado = 'INGRESADO', ingresado_en = now()
    where id = p_entrada_id;

  return query select true, 'Acceso permitido.'::text, v_entrada.nombre, v_evento_nombre, v_entrada.tipo_entrada;
end;
$$;

revoke all on function public.validar_entrada(uuid) from public;
grant execute on function public.validar_entrada(uuid) to service_role;
```

## Cambios en `server.js`

- Reemplazar `firebase-admin` por `@supabase/supabase-js`, inicializado con
  `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`.
- Quitar `STAFF_USERS`, `STAFF_SESSIONS`, `LOGIN_ATTEMPTS`, el sistema de
  cookies (`AUTH_COOKIE`, `readCookies`, `verifyStaffPassword`, etc.) y las
  rutas `/api/login` y `/api/logout`. El login de staff pasa a hacerse desde
  el navegador directo contra Supabase Auth (correo + contraseña).
- Nuevo middleware `requireRole(...roles)`: lee `Authorization: Bearer`,
  valida el token con Supabase, busca el rol en `perfiles`, deja pasar si
  coincide.
- `GET /api/session-status` sigue existiendo pero ahora valida el token en
  vez de leer la cookie.
- `GET /api/eventos` lee de la tabla `eventos` (antes era la constante fija
  `EVENTOS`).
- Nuevas rutas de administración de eventos: `POST /api/admin/eventos`,
  `PUT /api/admin/eventos/:id`, `DELETE /api/admin/eventos/:id` (desactiva,
  no borra), todas `requireRole('admin')`.
- `POST /api/crear-ticket` ahora requiere sesión (comprador logueado con
  Google); `usuario_id` sale del token, no del formulario.
- Nueva ruta `GET /api/mis-entradas` (`requireRole('cliente','staff','admin')`)
  para que un comprador vea sus propias entradas — hoy no existe forma de
  consultarlas sin el link directo al ticket.
- `POST /api/validar-ticket` llama a la función `validar_entrada` por RPC en
  vez de la transacción de Firestore.
- El resto de las rutas de admin (`confirmar-pago`, `pagos-pendientes`,
  `entradas`, `crear-qr`) se mantienen igual en su lógica, solo cambia de
  dónde leen/escriben. `crear-qr` sigue generando entradas gratis sin
  cuenta de comprador asociada — por eso `usuario_id` en `entradas` es
  nullable (a diferencia de las compras normales, donde siempre viene del
  token de sesión).
- `package.json`: quitar `firebase-admin`, agregar `@supabase/supabase-js`.

## Cambios en el frontend

- Agregar el cliente `supabase-js` (vía CDN o bundle) a `index.html` y
  `login.html`.
- `index.html`: botón "Iniciar sesión con Google" antes de poder comprar;
  el modal de compra manda el token de sesión junto con los datos.
- `login.html`: en vez de mandar el formulario a `/api/login`, llama
  `supabase.auth.signInWithPassword({ correo, contraseña })` directo.
- Todas las llamadas a rutas `/api/admin/...` y `/api/mis-entradas` agregan
  el header `Authorization: Bearer <token>` con el token de la sesión activa
  de Supabase.

(El detalle visual de estas pantallas se define en el sub-proyecto de
rediseño, no acá — esto es solo el cableado con la API.)

## Manejo de errores

Se mantiene el mismo patrón que ya usa el código: `try/catch` en cada ruta,
`console.error` para el detalle técnico, mensaje en español para la
persona usuaria. Casos nuevos a cubrir:

- Supabase no configurado (faltan variables de entorno): las rutas que
  dependen de la base responden `503` con "El servicio no está disponible
  en este momento" en vez de fallar de forma confusa.
- Token vencido o inválido en una ruta protegida: `401` "Sesión expirada,
  inicia sesión de nuevo."
- Rol insuficiente: `403`, mismo mensaje que ya usan hoy las rutas de admin.

## Plan de pruebas (manual, una vez creado el proyecto)

1. Crear cuenta con Google en la landing, verificar que aparece en
   `perfiles` con `rol = 'cliente'`.
2. Comprar una entrada, verificar que queda en `PENDIENTE_PAGO`.
3. Confirmar el pago como admin, verificar que llega el correo con el QR y
   que el estado pasa a `PENDIENTE`.
4. Escanear el QR: debe permitir el ingreso una vez.
5. Escanear el mismo QR de nuevo: debe rechazarlo ("ticket ya utilizado").
6. Crear y desactivar un evento desde el panel admin, verificar que
   desaparece de la landing pero sigue visible para staff/admin.
7. Intentar entrar a una ruta `/api/admin/...` sin sesión o con una cuenta
   `cliente`: debe rechazar con 401/403.

## Fuera de alcance de este documento

- Rediseño visual completo (sub-proyecto siguiente, usa `/design`).
- Cobro automático de PayPal (queda igual: referencia + confirmación
  manual).
- Pantalla para cancelar/reembolsar una entrada (el estado `CANCELADO`
  queda preparado en la base, pero no se construye la función todavía).
