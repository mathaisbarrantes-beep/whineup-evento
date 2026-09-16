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

-- Va después de rol_actual() porque la usa. Consultar public.perfiles desde
-- una política SOBRE public.perfiles provoca 42P17 ("infinite recursion
-- detected in policy for relation"); rol_actual() es security definer y por
-- eso no vuelve a disparar RLS.
create policy "perfiles_select" on public.perfiles
  for select using (
    auth.uid() = id
    or public.rol_actual() in ('staff','admin')
  );

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
  -- Ruta dentro del bucket "eventos" (abajo). La URL pública la arma el servidor.
  banner_path text,
  creado_por uuid references auth.users(id),
  creado_en timestamptz not null default now()
);

alter table public.eventos enable row level security;

create policy "eventos_lectura_publica" on public.eventos
  for select using (activo = true or public.rol_actual() in ('staff','admin'));

create policy "eventos_admin_escritura" on public.eventos
  for all using (public.rol_actual() = 'admin') with check (public.rol_actual() = 'admin');

-- ========== BANNERS DE EVENTOS (Storage) ==========
--
-- Público porque la portada los muestra sin sesión. No hay políticas sobre
-- storage.objects a propósito: sin ellas nadie puede subir, borrar ni listar
-- desde el navegador, y el servidor lo hace con la service role key. Los
-- límites repiten los del servidor como segunda barrera.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('eventos', 'eventos', true, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

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
  metodo_pago text check (metodo_pago in ('sinpe')),
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

  -- Calificada a propósito: las columnas del "returns table" también son
  -- variables aquí dentro, y un "nombre" suelto choca con eventos.nombre
  -- (42702, "column reference is ambiguous"). Postgres no lo detecta al crear
  -- la función sino al llegar a esta línea, y solo llegan los tickets pagados.
  select e.nombre into v_evento_nombre from public.eventos e where e.id = v_entrada.evento_id;

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

-- "from public" no alcanza en Supabase: anon y authenticated reciben EXECUTE
-- por privilegios por defecto, y con eso cualquiera con la clave anon podría
-- marcar una entrada como usada por /rest/v1/rpc/validar_entrada sin pasar por
-- el staff. Solo el servidor (service_role) la llama.
revoke all on function public.validar_entrada(uuid) from public, anon, authenticated;
grant execute on function public.validar_entrada(uuid) to service_role;

-- ========== PRIMER EVENTO (ejemplo, comentado a propósito) ==========
--
-- Sin al menos un evento activo, la portada y el generador de QR no muestran
-- nada. Descomenta y ajusta este insert, o crea el evento desde el panel de
-- administración (POST /api/admin/eventos).
--
-- "categoria" debe ser 'General' o 'VIP': al comprar se copia a
-- entradas.tipo_entrada, que tiene ese CHECK.
--
-- insert into public.eventos (nombre, fecha, lugar, precio, categoria, descripcion)
-- values (
--   'HALLOWEEN PARTY',
--   '2026-10-31 21:00:00-06',
--   'WhineUp CR, San José',
--   15000,
--   'General',
--   'La fiesta de Halloween de WhineUp CR.'
-- );
