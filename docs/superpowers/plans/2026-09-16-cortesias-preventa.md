# Cortesías de preventa — plan de implementación

> **Para agentes:** SUB-SKILL REQUERIDA: usar superpowers:subagent-driven-development (recomendado) o superpowers:executing-plans para ejecutar este plan tarea por tarea. Los pasos usan casillas (`- [ ]`) para el seguimiento.

**Objetivo:** que las entradas creadas antes de una fecha límite traigan una cortesía (p. ej. «1 shot gratis») que se promete en la portada y en los correos, se canjea en la barra escaneando el mismo QR y se administra desde el panel.

**Arquitectura:** la cortesía se copia a cada entrada al crearla (`entradas.cortesia`) según la regla del evento (`eventos.cortesia` + `eventos.cortesia_hasta`). El canje es una función SQL atómica (`canjear_cortesia`), como `validar_entrada`, que solo el servidor puede ejecutar. El escáner del teléfono suma un modo Cortesía que llama a esa función por una ruta nueva.

**Stack:** Node 22+/Express 4 en Vercel, Supabase (Postgres + Auth, `@supabase/supabase-js` 2.116), páginas HTML con JS en línea, EmailJS, tests con `node --test` y `supertest`.

**Spec:** `docs/superpowers/specs/2026-09-16-cortesias-preventa-design.md`

## Restricciones globales

- En la interfaz, lo nuevo se llama **cortesía**; las entradas gratis del panel se llaman **invitación**.
- Texto de cortesía: de 1 a 60 caracteres. Fecha límite inclusiva (`ahora <= cortesia_hasta`).
- La hora que decide es la de **creación de la entrada** (el comprobante), nunca la de confirmación del pago.
- Las invitaciones reciben la cortesía con la misma regla que las compras.
- Una cortesía por evento y una por entrada. Se canjea una sola vez y solo si la entrada está `INGRESADO`.
- Dar o quitar cortesía a mano: **solo admin**. Canjear: staff y admin.
- Toda columna dentro de funciones PL/pgSQL se escribe con su tabla (evita el error 42702).
- Funciones SQL nuevas: `revoke all … from public, anon, authenticated` + `grant execute … to service_role`.
- Para la base usar **solo** las herramientas `mcp__supabase-whineup__*` (el MCP `supabase` sin sufijo es otro proyecto). Antes de escribir, `get_project_url` debe devolver `orgbeuxvwgmrmnvkmyah`.
- Nunca borrar datos de producción.
- Commits locales al final de cada tarea. **`git push` solo en la Tarea 9 y solo con el «sí» explícito del usuario:** `main` se despliega solo a producción.
- Mensajes de commit: asunto en inglés (`feat:`/`fix:`), cuerpo en español sin tildes, y al final `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Textos de la interfaz en voseo costarricense (como el resto del sitio).

---

### Tarea 1: Base de datos (columnas, reglas y función de canje)

**Archivos:**
- Modificar: `supabase/schema.sql` (tabla `eventos`, tabla `entradas`, nueva sección de canje)
- Migración en Supabase: `cortesias_de_preventa`

**Interfaces:**
- Produce: columnas `eventos.cortesia`, `eventos.cortesia_hasta`, `entradas.cortesia`, `entradas.cortesia_entregada_en`, `entradas.cortesia_entregada_por`; función `public.canjear_cortesia(p_entrada_id uuid, p_staff_id uuid)` → `table(permitido boolean, motivo text, nombre text, evento text, cortesia text, entregada_en timestamptz)` con `motivo` ∈ `ENTREGAR | YA_ENTREGADA | SIN_CORTESIA | NO_INGRESO | NO_ENCONTRADA`.

- [ ] **Paso 1: Confirmar el proyecto**

Llamar `mcp__supabase-whineup__get_project_url`. Esperado: `https://orgbeuxvwgmrmnvkmyah.supabase.co`. Si el conector no está conectado, parar y pedirle al usuario que lo reconecte desde `/mcp`.

- [ ] **Paso 2: Prueba que falla (la función no existe)**

`mcp__supabase-whineup__execute_sql`:

```sql
select p.oid::regprocedure as firma from pg_proc p where p.proname = 'canjear_cortesia';
```

Esperado: cero filas.

- [ ] **Paso 3: Aplicar la migración**

`mcp__supabase-whineup__apply_migration` con nombre `cortesias_de_preventa`:

```sql
alter table public.eventos
  add column if not exists cortesia text,
  add column if not exists cortesia_hasta timestamptz;

alter table public.eventos
  add constraint eventos_cortesia_completa
    check ((cortesia is null) = (cortesia_hasta is null)),
  add constraint eventos_cortesia_largo
    check (cortesia is null or char_length(cortesia) between 1 and 60);

alter table public.entradas
  add column if not exists cortesia text,
  add column if not exists cortesia_entregada_en timestamptz,
  add column if not exists cortesia_entregada_por uuid references auth.users(id);

alter table public.entradas
  add constraint entradas_cortesia_entregada
    check (cortesia_entregada_en is null or cortesia is not null);

-- Canje atómico, igual que validar_entrada: "for update" hace esperar al
-- segundo escaneo simultáneo, que ya ve la cortesía entregada. Toda columna
-- va con su tabla: las columnas de salida (nombre, evento, cortesia,
-- entregada_en) son variables aquí dentro y un nombre suelto da 42702.
create or replace function public.canjear_cortesia(p_entrada_id uuid, p_staff_id uuid)
returns table (
  permitido boolean,
  motivo text,
  nombre text,
  evento text,
  cortesia text,
  entregada_en timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entrada public.entradas%rowtype;
  v_evento text;
  v_ahora timestamptz := now();
begin
  select * into v_entrada from public.entradas as e where e.id = p_entrada_id for update;

  if not found then
    return query select false, 'NO_ENCONTRADA'::text, null::text, null::text, null::text, null::timestamptz;
    return;
  end if;

  select ev.nombre into v_evento from public.eventos as ev where ev.id = v_entrada.evento_id;

  if v_entrada.cortesia is null then
    return query select false, 'SIN_CORTESIA'::text, v_entrada.nombre, v_evento, null::text, null::timestamptz;
    return;
  end if;

  if v_entrada.estado <> 'INGRESADO' then
    return query select false, 'NO_INGRESO'::text, v_entrada.nombre, v_evento, v_entrada.cortesia, null::timestamptz;
    return;
  end if;

  if v_entrada.cortesia_entregada_en is not null then
    return query select false, 'YA_ENTREGADA'::text, v_entrada.nombre, v_evento, v_entrada.cortesia, v_entrada.cortesia_entregada_en;
    return;
  end if;

  update public.entradas as e
    set cortesia_entregada_en = v_ahora, cortesia_entregada_por = p_staff_id
    where e.id = p_entrada_id;

  return query select true, 'ENTREGAR'::text, v_entrada.nombre, v_evento, v_entrada.cortesia, v_ahora;
end;
$$;

revoke all on function public.canjear_cortesia(uuid, uuid) from public, anon, authenticated;
grant execute on function public.canjear_cortesia(uuid, uuid) to service_role;
```

- [ ] **Paso 4: Probar los cinco motivos sin dejar rastro**

`mcp__supabase-whineup__execute_sql`. El `raise` final revierte todo, incluida la entrada temporal:

```sql
do $$
declare
  v_evento uuid := (select ev.id from public.eventos as ev order by ev.creado_en limit 1);
  v_staff uuid := (select p.id from public.perfiles as p where p.rol = 'admin' limit 1);
  v_id uuid;
  r record;
  salida text := '';
begin
  insert into public.entradas (evento_id, nombre, correo, precio, pagado, estado)
  values (v_evento, 'Prueba', 'prueba@ejemplo.com', 0, true, 'PENDIENTE')
  returning id into v_id;

  select * into r from public.canjear_cortesia(gen_random_uuid(), v_staff);
  salida := salida || ' | inexistente=' || r.motivo;
  select * into r from public.canjear_cortesia(v_id, v_staff);
  salida := salida || ' | sin_cortesia=' || r.motivo;
  update public.entradas as e set cortesia = '1 shot gratis' where e.id = v_id;
  select * into r from public.canjear_cortesia(v_id, v_staff);
  salida := salida || ' | sin_entrar=' || r.motivo;
  update public.entradas as e set estado = 'INGRESADO', ingresado_en = now() where e.id = v_id;
  select * into r from public.canjear_cortesia(v_id, v_staff);
  salida := salida || ' | primera=' || r.motivo || '/' || r.permitido || '/' || r.cortesia || '/' || coalesce(r.evento, '?');
  select * into r from public.canjear_cortesia(v_id, v_staff);
  salida := salida || ' | segunda=' || r.motivo || '/' || r.permitido || '/' || (r.entregada_en is not null);
  raise exception 'REVERTIDO%', salida;
end $$;
```

Esperado (como error P0001): `REVERTIDO | inexistente=NO_ENCONTRADA | sin_cortesia=SIN_CORTESIA | sin_entrar=NO_INGRESO | primera=ENTREGAR/t/1 shot gratis/<nombre del evento> | segunda=YA_ENTREGADA/f/true`.

- [ ] **Paso 5: Probar permisos y que no quedó nada**

```sql
do $$
declare r record; msg text;
begin
  perform set_config('role', 'service_role', true);
  select * into r from public.canjear_cortesia(gen_random_uuid(), null);
  begin
    perform set_config('role', 'anon', true);
    perform public.canjear_cortesia(gen_random_uuid(), null);
    msg := 'anon PUDO ejecutarla';
  exception when insufficient_privilege then
    msg := 'anon rechazado con ' || sqlstate;
  end;
  raise exception 'REVERTIDO | service_role=% | %', r.motivo, msg;
end $$;
```

Esperado: `REVERTIDO | service_role=NO_ENCONTRADA | anon rechazado con 42501`.

Después:

```sql
select count(*) filter (where e.nombre = 'Prueba' and e.correo = 'prueba@ejemplo.com') as temporales,
       count(*) filter (where e.cortesia is not null) as con_cortesia
from public.entradas as e;
```

Esperado: `temporales = 0`, `con_cortesia = 0`. Revisar también `mcp__supabase-whineup__get_advisors` (`security`): no debe aparecer `canjear_cortesia`.

- [ ] **Paso 6: Reflejar la migración en `supabase/schema.sql`**

En `create table public.eventos`, después de `banner_path text,`:

```sql
  -- Cortesía de preventa: texto y fecha límite van juntos o no van.
  cortesia text,
  cortesia_hasta timestamptz,
```

y después del cierre de esa tabla (antes de `alter table public.eventos enable row level security;`):

```sql
alter table public.eventos
  add constraint eventos_cortesia_completa
    check ((cortesia is null) = (cortesia_hasta is null)),
  add constraint eventos_cortesia_largo
    check (cortesia is null or char_length(cortesia) between 1 and 60);
```

En `create table public.entradas`, después de `generado_por uuid references auth.users(id),`:

```sql
  -- Copia fija de la cortesía que le tocó al crearse; cambiar el evento
  -- después no altera lo que ya se prometió.
  cortesia text,
  cortesia_entregada_en timestamptz,
  cortesia_entregada_por uuid references auth.users(id),
```

y después del cierre de esa tabla:

```sql
alter table public.entradas
  add constraint entradas_cortesia_entregada
    check (cortesia_entregada_en is null or cortesia is not null);
```

Al final de la sección `INVALIDAR QR AL ESCANEAR`, después del `grant` de `validar_entrada`, agregar la sección `-- ========== CANJEAR CORTESÍA (atómico) ==========` con el mismo `create or replace function public.canjear_cortesia …`, `revoke` y `grant` del Paso 3.

- [ ] **Paso 7: Commit**

```bash
git add supabase/schema.sql
git commit -F - <<'EOF'
feat: add early-bird courtesy columns and atomic redemption

Cortesia de preventa en la base: texto y fecha limite por evento, copia fija
en cada entrada, y canjear_cortesia para entregarla una sola vez y solo a
quien ya entro. Solo service_role puede ejecutarla.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Tarea 2: Reglas de cortesía del evento (`lib/eventos.js`)

**Archivos:**
- Modificar: `lib/eventos.js`
- Test: `tests/lib/eventos.test.js`

**Interfaces:**
- Produce:
  - `cortesiaVigente(evento: { cortesia, cortesiaHasta }, ahora: Date) → string | null`
  - `cortesiaDesdeFormulario(texto, hasta) → { cortesia: string|null, cortesia_hasta: string|null }`, que lanza `{ error: 'CORTESIA_INCOMPLETA' | 'CORTESIA_LARGA' | 'CORTESIA_FECHA' }`.
  - `mapEventoRow` suma `cortesia` y `cortesiaHasta`.
  - `createEventosRepo({ supabase, supabaseConfigured, reloj })`, donde `reloj` es `() => Date` y por defecto `() => new Date()`. `listarPublicos` pone en `null` las cortesías vencidas; `listarTodos` y `obtenerPorId` las devuelven siempre.

- [ ] **Paso 1: Escribir las pruebas que fallan**

En `tests/lib/eventos.test.js`, cambiar el `require` del principio a:

```js
const { createEventosRepo, cortesiaVigente, cortesiaDesdeFormulario } = require('../../lib/eventos');
```

En el test `mapEventoRow maps snake_case columns…`, el `deepEqual` esperado pasa a terminar en:

```js
    activo: true,
    bannerUrl: null,
    cortesia: null,
    cortesiaHasta: null
```

Y agregar al final del archivo:

```js
/* -------------------------------------------------------------- cortesías */

const LIMITE = '2026-09-22T05:59:00.000Z';
const EVENTO_CON_CORTESIA = { cortesia: '1 shot gratis', cortesiaHasta: LIMITE };

// El límite es inclusivo: quien manda el comprobante en el último minuto la gana.
test('cortesiaVigente returns the courtesy up to and including the deadline', () => {
  assert.equal(cortesiaVigente(EVENTO_CON_CORTESIA, new Date('2026-09-22T05:58:59.999Z')), '1 shot gratis');
  assert.equal(cortesiaVigente(EVENTO_CON_CORTESIA, new Date(LIMITE)), '1 shot gratis');
  assert.equal(cortesiaVigente(EVENTO_CON_CORTESIA, new Date('2026-09-22T05:59:00.001Z')), null);
});

test('cortesiaVigente returns null without a complete, valid courtesy', () => {
  const ahora = new Date('2026-09-20T00:00:00Z');
  assert.equal(cortesiaVigente({ cortesia: null, cortesiaHasta: null }, ahora), null);
  assert.equal(cortesiaVigente({ cortesia: '1 shot gratis', cortesiaHasta: null }, ahora), null);
  assert.equal(cortesiaVigente({ cortesia: '1 shot gratis', cortesiaHasta: 'mañana' }, ahora), null);
  assert.equal(cortesiaVigente(null, ahora), null);
});

test('cortesiaDesdeFormulario clears the courtesy when both fields are empty', () => {
  assert.deepEqual(cortesiaDesdeFormulario('  ', ''), { cortesia: null, cortesia_hasta: null });
  assert.deepEqual(cortesiaDesdeFormulario(undefined, null), { cortesia: null, cortesia_hasta: null });
});

test('cortesiaDesdeFormulario trims the text and normalizes the deadline to ISO', () => {
  assert.deepEqual(
    cortesiaDesdeFormulario('  1 shot gratis ', '2026-09-22T05:59:00Z'),
    { cortesia: '1 shot gratis', cortesia_hasta: '2026-09-22T05:59:00.000Z' }
  );
});

test('cortesiaDesdeFormulario rejects half a courtesy, long text and bad dates', () => {
  assert.throws(() => cortesiaDesdeFormulario('1 shot gratis', ''), (err) => err.error === 'CORTESIA_INCOMPLETA');
  assert.throws(() => cortesiaDesdeFormulario('', '2026-09-22T05:59:00Z'), (err) => err.error === 'CORTESIA_INCOMPLETA');
  assert.throws(() => cortesiaDesdeFormulario('x'.repeat(61), '2026-09-22T05:59:00Z'), (err) => err.error === 'CORTESIA_LARGA');
  assert.throws(() => cortesiaDesdeFormulario('1 shot gratis', 'el 22'), (err) => err.error === 'CORTESIA_FECHA');
  assert.deepEqual(cortesiaDesdeFormulario('x'.repeat(60), LIMITE).cortesia, 'x'.repeat(60));
});

function filaConCortesia(hasta) {
  return filaEvento({ cortesia: '1 shot gratis', cortesia_hasta: hasta });
}

// La portada no debe prometer una cortesía vencida, aunque el reloj del
// visitante esté mal: la decide la hora del servidor.
test('listarPublicos hides an expired courtesy and keeps an active one', async () => {
  const reloj = () => new Date('2026-09-22T06:00:00Z');
  const vencida = createEventosRepo({ supabase: fakeEventos({ filas: [filaConCortesia(LIMITE)] }).supabase, supabaseConfigured: true, reloj });
  const [ev1] = await vencida.listarPublicos();
  assert.deepEqual({ cortesia: ev1.cortesia, cortesiaHasta: ev1.cortesiaHasta }, { cortesia: null, cortesiaHasta: null });

  const vigente = createEventosRepo({ supabase: fakeEventos({ filas: [filaConCortesia('2026-09-30T05:59:00+00:00')] }).supabase, supabaseConfigured: true, reloj });
  const [ev2] = await vigente.listarPublicos();
  assert.deepEqual({ cortesia: ev2.cortesia, cortesiaHasta: ev2.cortesiaHasta }, { cortesia: '1 shot gratis', cortesiaHasta: '2026-09-30T05:59:00+00:00' });
});

// El panel y la creación de entradas necesitan el valor real, vencido o no.
test('obtenerPorId keeps an expired courtesy', async () => {
  const reloj = () => new Date('2027-01-01T00:00:00Z');
  const repo = createEventosRepo({ supabase: fakeEventos({ filas: [filaConCortesia(LIMITE)] }).supabase, supabaseConfigured: true, reloj });
  const evento = await repo.obtenerPorId(ID);
  assert.deepEqual({ cortesia: evento.cortesia, cortesiaHasta: evento.cortesiaHasta }, { cortesia: '1 shot gratis', cortesiaHasta: LIMITE });
});
```

- [ ] **Paso 2: Verificar que fallan**

Run: `node --test tests/lib/eventos.test.js`
Esperado: fallan los tests nuevos (`cortesiaVigente is not a function`) y el de `mapEventoRow` (faltan `cortesia` y `cortesiaHasta`).

- [ ] **Paso 3: Implementar**

En `lib/eventos.js`:

1. Debajo de `const FIRMA_PNG = …` agregar:

```js
const MAX_CORTESIA = 60;

// La hora que cuenta es la de creación de la entrada: quien manda el
// comprobante antes del límite la gana aunque el pago se confirme después.
// El límite es inclusivo.
function cortesiaVigente(evento, ahora) {
  if (!evento || !evento.cortesia || !evento.cortesiaHasta) return null;
  const limite = new Date(evento.cortesiaHasta).getTime();
  if (Number.isNaN(limite)) return null;
  return ahora.getTime() <= limite ? evento.cortesia : null;
}

// Lo que manda el formulario del panel. Los dos vacíos quitan la cortesía;
// uno solo es un error, igual que el CHECK de la tabla.
function cortesiaDesdeFormulario(texto, hasta) {
  const limpio = String(texto == null ? '' : texto).trim();
  const fecha = String(hasta == null ? '' : hasta).trim();
  if (!limpio && !fecha) return { cortesia: null, cortesia_hasta: null };
  if (!limpio || !fecha) throw { error: 'CORTESIA_INCOMPLETA' };
  if (limpio.length > MAX_CORTESIA) throw { error: 'CORTESIA_LARGA' };
  const limite = new Date(fecha);
  if (Number.isNaN(limite.getTime())) throw { error: 'CORTESIA_FECHA' };
  return { cortesia: limpio, cortesia_hasta: limite.toISOString() };
}
```

2. En `mapEventoRow`, después de `bannerUrl: …`:

```js
    bannerUrl: row.banner_path ? urlDeBanner(row.banner_path) : null,
    cortesia: row.cortesia || null,
    cortesiaHasta: row.cortesia_hasta || null
```

3. Cambiar la firma del repo y `listarPublicos`:

```js
function createEventosRepo({ supabase, supabaseConfigured, reloj = () => new Date() }) {
```

```js
  async function listarPublicos() {
    assertConfigured();
    const { data, error } = await supabase
      .from('eventos').select('*').eq('activo', true).order('fecha', { ascending: true });
    if (error) throw error;
    const ahora = reloj();
    // La portada solo promete lo que todavía se puede ganar.
    return (data || []).map(mapear).map((evento) => (
      cortesiaVigente(evento, ahora) ? evento : { ...evento, cortesia: null, cortesiaHasta: null }
    ));
  }
```

4. El `module.exports` pasa a:

```js
module.exports = {
  createEventosRepo, mapEventoRow, cortesiaVigente, cortesiaDesdeFormulario,
  NO_CONFIGURADO, MAX_BANNER_BYTES
};
```

- [ ] **Paso 4: Verificar que pasan**

Run: `node --test tests/lib/eventos.test.js` → todo en verde. Después `npm test` → todo en verde.

- [ ] **Paso 5: Commit**

```bash
git add lib/eventos.js tests/lib/eventos.test.js
git commit -F - <<'EOF'
feat: decide when an event courtesy applies

cortesiaVigente decide con la hora de creacion de la entrada y el limite es
inclusivo. cortesiaDesdeFormulario valida lo que manda el panel. La portada
solo recibe cortesias vigentes segun la hora del servidor; el panel y la
creacion de entradas ven siempre el valor real.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Tarea 3: Cortesía en las entradas (`lib/entradas.js`)

**Archivos:**
- Modificar: `lib/entradas.js`
- Test: `tests/lib/entradas.test.js`

**Interfaces:**
- Consume: la función SQL `canjear_cortesia` (Tarea 1).
- Produce:
  - `mapEntradaRow` suma `cortesia`, `cortesiaEntregadaEn` y `eventoCortesia` (la cortesía **actual** del evento, que llega por el join).
  - `repo.contarCortesias(eventoId) → { asignadas: number, entregadas: number }`.
  - `repo.ponerCortesia(id, dar: boolean) → entrada mapeada`, que lanza `{ error: 'ENTRADA_NO_ENCONTRADA' | 'EVENTO_SIN_CORTESIA' | 'YA_TIENE_CORTESIA' | 'CORTESIA_ENTREGADA' }`.
  - `repo.canjearCortesia(id, staffId) → { permitido, motivo, mensaje, nombre, evento, cortesia, entregadaEn }`.

- [ ] **Paso 1: Escribir las pruebas que fallan**

En `tests/lib/entradas.test.js`, el test `mapEntradaRow maps snake_case columns…` cambia su fila a `eventos: { nombre: 'HALLOWEEN PARTY', fecha: '2026-10-31T21:00:00Z', lugar: 'WhineUp CR', cortesia: '1 shot gratis' }`, y el objeto esperado termina en:

```js
    generadoPor: null, creadoEn: '2026-01-01T00:00:00Z',
    cortesia: null, cortesiaEntregadaEn: null, eventoCortesia: '1 shot gratis'
```

Agregar al final:

```js
/* -------------------------------------------------------------- cortesías */

const STAFF_ID = '9b1d2c3e-4f50-4a6b-8c7d-0e1f2a3b4c5d';

// Imita el builder de supabase-js: los filtros se acumulan y el pedido se
// resuelve al esperarlo.
function fakeConteos(filas) {
  return {
    from(tabla) {
      assert.equal(tabla, 'entradas');
      return {
        select(_columnas, opciones) {
          assert.deepEqual(opciones, { count: 'exact', head: true });
          const filtros = [];
          const consulta = {
            eq(columna, valor) { filtros.push((f) => f[columna] === valor); return consulta; },
            not(columna, operador, valor) {
              assert.equal(operador, 'is');
              assert.equal(valor, null);
              filtros.push((f) => f[columna] != null);
              return consulta;
            },
            then(resolver, rechazar) {
              const count = filas.filter((f) => filtros.every((cumple) => cumple(f))).length;
              return Promise.resolve({ count, error: null }).then(resolver, rechazar);
            }
          };
          return consulta;
        }
      };
    }
  };
}

test('contarCortesias counts assigned and delivered courtesies of one event', async () => {
  const filas = [
    { evento_id: 'e1', cortesia: '1 shot gratis', cortesia_entregada_en: '2026-10-05T03:00:00Z' },
    { evento_id: 'e1', cortesia: '1 shot gratis', cortesia_entregada_en: null },
    { evento_id: 'e1', cortesia: null, cortesia_entregada_en: null },
    { evento_id: 'e2', cortesia: '1 shot gratis', cortesia_entregada_en: '2026-10-05T03:00:00Z' }
  ];
  const repo = createEntradasRepo({ supabase: fakeConteos(filas), supabaseConfigured: true });
  assert.deepEqual(await repo.contarCortesias('e1'), { asignadas: 2, entregadas: 1 });
});

function filaEntrada(extra = {}) {
  return {
    id: UUID_VALIDO, evento_id: 'e1', usuario_id: 'u1', nombre: 'Ana', correo: 'ana@x.com',
    telefono: '8888-0000', tipo_entrada: 'General', precio: 3500, metodo_pago: 'sinpe',
    referencia_pago: 'REF1', pagado: true, estado: 'PENDIENTE', pago_confirmado_por: null,
    pago_confirmado_en: null, ingresado_en: null, generado_por: null,
    creado_en: '2026-09-23T15:00:00Z', cortesia: null, cortesia_entregada_en: null,
    cortesia_entregada_por: null,
    ...extra
  };
}

// Lectura por id con el join del evento, y update condicionado. `antes` corre
// entre la lectura y el update para simular otro admin tocando la misma fila.
function fakeCortesiaManual(fila, { eventoCortesia = '1 shot gratis', antes = () => {} } = {}) {
  const updates = [];
  const conEvento = () => ({ ...fila, eventos: { nombre: 'HALLOWEEN PARTY', fecha: '2026-10-05T01:00:00Z', lugar: 'WhineUp CR', cortesia: eventoCortesia } });
  const supabase = {
    from(tabla) {
      assert.equal(tabla, 'entradas');
      return {
        select() {
          return { eq(_c, id) { return { maybeSingle: async () => ({ data: fila && fila.id === id ? conEvento() : null, error: null }) }; } };
        },
        update(cambios) {
          const condiciones = [];
          const consulta = {
            eq(columna, valor) { condiciones.push([columna, valor]); return consulta; },
            is(columna, valor) { condiciones.push([columna, valor]); return consulta; },
            select() {
              return {
                maybeSingle: async () => {
                  antes();
                  updates.push({ cambios, condiciones: [...condiciones] });
                  const cumple = condiciones.every(([columna, valor]) => (valor === null ? fila[columna] == null : fila[columna] === valor));
                  if (!cumple) return { data: null, error: null };
                  Object.assign(fila, cambios);
                  return { data: conEvento(), error: null };
                }
              };
            }
          };
          return consulta;
        }
      };
    }
  };
  return { supabase, updates };
}

test('ponerCortesia gives a ticket the event courtesy only if it still has none', async () => {
  const fake = fakeCortesiaManual(filaEntrada());
  const repo = createEntradasRepo({ supabase: fake.supabase, supabaseConfigured: true });
  const entrada = await repo.ponerCortesia(UUID_VALIDO, true);
  assert.equal(entrada.cortesia, '1 shot gratis');
  assert.deepEqual(fake.updates, [{ cambios: { cortesia: '1 shot gratis' }, condiciones: [['id', UUID_VALIDO], ['cortesia', null]] }]);
});

test('ponerCortesia refuses to give a courtesy the event does not have', async () => {
  const fake = fakeCortesiaManual(filaEntrada(), { eventoCortesia: null });
  const repo = createEntradasRepo({ supabase: fake.supabase, supabaseConfigured: true });
  await assert.rejects(() => repo.ponerCortesia(UUID_VALIDO, true), (err) => err.error === 'EVENTO_SIN_CORTESIA');
  assert.deepEqual(fake.updates, []);
});

test('ponerCortesia refuses to give a second courtesy', async () => {
  const fake = fakeCortesiaManual(filaEntrada({ cortesia: 'otra cosa' }));
  const repo = createEntradasRepo({ supabase: fake.supabase, supabaseConfigured: true });
  await assert.rejects(() => repo.ponerCortesia(UUID_VALIDO, true), (err) => err.error === 'YA_TIENE_CORTESIA');
  assert.deepEqual(fake.updates, []);
});

test('ponerCortesia reports a courtesy given by someone else in between', async () => {
  const fila = filaEntrada();
  const fake = fakeCortesiaManual(fila, { antes: () => { fila.cortesia = '1 shot gratis'; } });
  const repo = createEntradasRepo({ supabase: fake.supabase, supabaseConfigured: true });
  await assert.rejects(() => repo.ponerCortesia(UUID_VALIDO, true), (err) => err.error === 'YA_TIENE_CORTESIA');
});

test('ponerCortesia removes an undelivered courtesy, guarded against a delivery in between', async () => {
  const fake = fakeCortesiaManual(filaEntrada({ cortesia: '1 shot gratis' }));
  const repo = createEntradasRepo({ supabase: fake.supabase, supabaseConfigured: true });
  const entrada = await repo.ponerCortesia(UUID_VALIDO, false);
  assert.equal(entrada.cortesia, null);
  assert.deepEqual(fake.updates, [{ cambios: { cortesia: null }, condiciones: [['id', UUID_VALIDO], ['cortesia_entregada_en', null]] }]);
});

test('ponerCortesia never removes a delivered courtesy', async () => {
  const entregada = fakeCortesiaManual(filaEntrada({ cortesia: '1 shot gratis', cortesia_entregada_en: '2026-10-05T03:00:00Z' }));
  const repo = createEntradasRepo({ supabase: entregada.supabase, supabaseConfigured: true });
  await assert.rejects(() => repo.ponerCortesia(UUID_VALIDO, false), (err) => err.error === 'CORTESIA_ENTREGADA');
  assert.deepEqual(entregada.updates, []);

  const fila = filaEntrada({ cortesia: '1 shot gratis' });
  const carrera = fakeCortesiaManual(fila, { antes: () => { fila.cortesia_entregada_en = '2026-10-05T03:00:00Z'; } });
  const repo2 = createEntradasRepo({ supabase: carrera.supabase, supabaseConfigured: true });
  await assert.rejects(() => repo2.ponerCortesia(UUID_VALIDO, false), (err) => err.error === 'CORTESIA_ENTREGADA');
});

test('ponerCortesia leaves a ticket without courtesy untouched when removing', async () => {
  const fake = fakeCortesiaManual(filaEntrada());
  const repo = createEntradasRepo({ supabase: fake.supabase, supabaseConfigured: true });
  const entrada = await repo.ponerCortesia(UUID_VALIDO, false);
  assert.equal(entrada.cortesia, null);
  assert.deepEqual(fake.updates, []);
});

test('ponerCortesia reports an unknown or malformed ticket', async () => {
  const sinDatos = createEntradasRepo({ supabase: supabaseProhibido, supabaseConfigured: true });
  await assert.rejects(() => sinDatos.ponerCortesia('no-es-uuid', true), (err) => err.error === 'ENTRADA_NO_ENCONTRADA');
  const otro = fakeCortesiaManual(filaEntrada({ id: '00000000-0000-4000-8000-000000000000' }));
  const repo = createEntradasRepo({ supabase: otro.supabase, supabaseConfigured: true });
  await assert.rejects(() => repo.ponerCortesia(UUID_VALIDO, true), (err) => err.error === 'ENTRADA_NO_ENCONTRADA');
});

test('canjearCortesia passes the staff member to the atomic function', async () => {
  let recibido = null;
  const supabase = {
    rpc(fn, args) {
      recibido = { fn, args };
      return Promise.resolve({ data: [{ permitido: true, motivo: 'ENTREGAR', nombre: 'Ana', evento: 'HALLOWEEN PARTY', cortesia: '1 shot gratis', entregada_en: '2026-10-05T03:00:00Z' }], error: null });
    }
  };
  const repo = createEntradasRepo({ supabase, supabaseConfigured: true });
  const resultado = await repo.canjearCortesia(UUID_VALIDO, STAFF_ID);
  assert.deepEqual(recibido, { fn: 'canjear_cortesia', args: { p_entrada_id: UUID_VALIDO, p_staff_id: STAFF_ID } });
  assert.deepEqual(resultado, {
    permitido: true, motivo: 'ENTREGAR', mensaje: 'Entregar la cortesía.',
    nombre: 'Ana', evento: 'HALLOWEEN PARTY', cortesia: '1 shot gratis', entregadaEn: '2026-10-05T03:00:00Z'
  });
});

test('canjearCortesia explains every refusal', async () => {
  const casos = [
    ['YA_ENTREGADA', 'Esta cortesía ya se entregó.'],
    ['SIN_CORTESIA', 'Esta entrada no trae cortesía.'],
    ['NO_INGRESO', 'Primero tiene que pasar por la puerta.'],
    ['NO_ENCONTRADA', 'Ticket no encontrado.']
  ];
  for (const [motivo, mensaje] of casos) {
    const supabase = { rpc: () => Promise.resolve({ data: [{ permitido: false, motivo, nombre: null, evento: null, cortesia: null, entregada_en: null }], error: null }) };
    const resultado = await createEntradasRepo({ supabase, supabaseConfigured: true }).canjearCortesia(UUID_VALIDO, STAFF_ID);
    assert.deepEqual({ permitido: resultado.permitido, motivo: resultado.motivo, mensaje: resultado.mensaje }, { permitido: false, motivo, mensaje });
  }
});

test('canjearCortesia treats a foreign QR as not found without querying Supabase', async () => {
  const repo = createEntradasRepo({ supabase: supabaseProhibido, supabaseConfigured: true });
  const resultado = await repo.canjearCortesia('https://wa.me/50600000000', STAFF_ID);
  assert.deepEqual({ permitido: resultado.permitido, motivo: resultado.motivo }, { permitido: false, motivo: 'NO_ENCONTRADA' });
});

test('canjearCortesia lets a database failure through', async () => {
  const fallo = { message: 'permission denied for function canjear_cortesia', code: '42501' };
  const supabase = { rpc: () => Promise.resolve({ data: null, error: fallo }) };
  await assert.rejects(() => createEntradasRepo({ supabase, supabaseConfigured: true }).canjearCortesia(UUID_VALIDO, STAFF_ID), (err) => err === fallo);
});
```

- [ ] **Paso 2: Verificar que fallan**

Run: `node --test tests/lib/entradas.test.js`
Esperado: fallan los nuevos (`repo.contarCortesias is not a function`, etc.) y el de `mapEntradaRow`.

- [ ] **Paso 3: Implementar**

En `lib/entradas.js`:

1. Cambiar el join:

```js
const SELECT_CON_EVENTO = '*, eventos(nombre, fecha, lugar, cortesia)';
```

2. Debajo de `NO_ENCONTRADO` agregar:

```js
const MENSAJES_CANJE = {
  ENTREGAR: 'Entregar la cortesía.',
  YA_ENTREGADA: 'Esta cortesía ya se entregó.',
  SIN_CORTESIA: 'Esta entrada no trae cortesía.',
  NO_INGRESO: 'Primero tiene que pasar por la puerta.',
  NO_ENCONTRADA: 'Ticket no encontrado.'
};

function resultadoCanje(row) {
  return {
    permitido: Boolean(row.permitido),
    motivo: row.motivo,
    mensaje: MENSAJES_CANJE[row.motivo] || 'No se pudo canjear la cortesía.',
    nombre: row.nombre || null,
    evento: row.evento || null,
    cortesia: row.cortesia || null,
    entregadaEn: row.entregada_en || null
  };
}
```

3. En `mapEntradaRow`, después de `creadoEn: row.creado_en`:

```js
    creadoEn: row.creado_en,
    cortesia: row.cortesia || null,
    cortesiaEntregadaEn: row.cortesia_entregada_en || null,
    // La cortesía que el evento tiene configurada hoy: el panel la usa para
    // saber si puede ofrecer "Dar cortesía".
    eventoCortesia: row.eventos ? (row.eventos.cortesia || null) : null
```

4. Dentro de `createEntradasRepo`, antes del `return`:

```js
  // Dos conteos exactos: contar filas en JavaScript quedaría cortado en las
  // 1000 que devuelve Supabase por pedido.
  async function contarCortesias(eventoId) {
    assertConfigured();
    const base = () => supabase
      .from('entradas').select('id', { count: 'exact', head: true })
      .eq('evento_id', eventoId).not('cortesia', 'is', null);
    const [asignadas, entregadas] = await Promise.all([
      base(),
      base().not('cortesia_entregada_en', 'is', null)
    ]);
    if (asignadas.error) throw asignadas.error;
    if (entregadas.error) throw entregadas.error;
    return { asignadas: asignadas.count || 0, entregadas: entregadas.count || 0 };
  }

  // Los updates van condicionados: si otro admin la dio, o la barra la
  // entregó entre la lectura y el cambio, no se pisa nada.
  async function ponerCortesia(id, dar) {
    assertConfigured();
    if (!isUuid(id)) throw { error: 'ENTRADA_NO_ENCONTRADA' };
    const actual = await obtenerPorId(id);
    if (!actual) throw { error: 'ENTRADA_NO_ENCONTRADA' };

    if (dar) {
      if (actual.cortesia) throw { error: 'YA_TIENE_CORTESIA' };
      if (!actual.eventoCortesia) throw { error: 'EVENTO_SIN_CORTESIA' };
      const { data, error } = await supabase
        .from('entradas').update({ cortesia: actual.eventoCortesia })
        .eq('id', id).is('cortesia', null)
        .select(SELECT_CON_EVENTO).maybeSingle();
      if (error) throw error;
      if (!data) throw { error: 'YA_TIENE_CORTESIA' };
      return mapEntradaRow(data);
    }

    if (!actual.cortesia) return actual;
    if (actual.cortesiaEntregadaEn) throw { error: 'CORTESIA_ENTREGADA' };
    const { data, error } = await supabase
      .from('entradas').update({ cortesia: null })
      .eq('id', id).is('cortesia_entregada_en', null)
      .select(SELECT_CON_EVENTO).maybeSingle();
    if (error) throw error;
    if (!data) throw { error: 'CORTESIA_ENTREGADA' };
    return mapEntradaRow(data);
  }

  async function canjearCortesia(id, staffId) {
    assertConfigured();
    if (!isUuid(id)) return resultadoCanje({ permitido: false, motivo: 'NO_ENCONTRADA' });
    const { data, error } = await supabase.rpc('canjear_cortesia', { p_entrada_id: id, p_staff_id: staffId });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return resultadoCanje(row || { permitido: false, motivo: 'NO_ENCONTRADA' });
  }
```

5. El `return` del repo pasa a:

```js
  return {
    NO_CONFIGURADO, crear, obtenerPorId, confirmarPago, pagosPendientes,
    generadas, misEntradas, crearGenerada, validar, contarTotal,
    contarCortesias, ponerCortesia, canjearCortesia
  };
```

- [ ] **Paso 4: Verificar que pasan**

Run: `node --test tests/lib/entradas.test.js` → verde. `npm test` → verde.

- [ ] **Paso 5: Commit**

```bash
git add lib/entradas.js tests/lib/entradas.test.js
git commit -F - <<'EOF'
feat: count, give, remove and redeem ticket courtesies

El repo de entradas cuenta cortesias por evento con conteos exactos, deja al
admin darlas o quitarlas con updates condicionados (sin pisar una entrega
que ocurra en el medio) y canjea con canjear_cortesia. Un QR ajeno no llega
a la base.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Tarea 4: Correos con cortesía y asignación al crear entradas

**Archivos:**
- Crear: `lib/correoTicket.js`
- Crear: `tests/lib/correoTicket.test.js`
- Modificar: `server.js` (función `paramsDeTicket` → módulo; rutas `crear-ticket`, `admin/crear-qr`, `admin/confirmar-pago`; renombre a invitación)

**Interfaces:**
- Consume: `cortesiaVigente` (Tarea 2); `ticket.cortesia` de `mapEntradaRow` (Tarea 3).
- Produce: `paramsDeTicket(ticket, { asunto, mensaje }, { qrUrl, ticketUrl }) → params de EmailJS`, con `cortesia` (string, `''` si no hay) y `mensaje` extendido.

- [ ] **Paso 1: Escribir las pruebas que fallan**

Crear `tests/lib/correoTicket.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { paramsDeTicket } = require('../../lib/correoTicket');

const URLS = {
  qrUrl: 'https://whineup-evento.vercel.app/api/ticket/7c4b5944-0000-4000-8000-000000000001/qr.png',
  ticketUrl: 'https://whineup-evento.vercel.app/ticket?ticketId=7c4b5944-0000-4000-8000-000000000001'
};

function ticket(extra = {}) {
  return {
    id: '7c4b5944-0000-4000-8000-000000000001', correo: 'ana@x.com', nombre: 'Ana',
    evento: 'HALLOWEEN PARTY', tipoEntrada: 'General', cortesia: null,
    ...extra
  };
}

// Los nombres son el contrato con las plantillas de EmailJS.
test('paramsDeTicket keeps the EmailJS contract when there is no courtesy', () => {
  assert.deepEqual(paramsDeTicket(ticket(), { asunto: 'Tu entrada', mensaje: 'Confirmamos tu pago.' }, URLS), {
    to_email: 'ana@x.com',
    to_name: 'Ana',
    subject: 'Tu entrada',
    mensaje: 'Confirmamos tu pago.',
    cortesia: '',
    evento: 'HALLOWEEN PARTY',
    tipo_entrada: 'General',
    qr_url: URLS.qrUrl,
    ticket_url: URLS.ticketUrl,
    referencia_corta: '7C4B5944'
  });
});

// Va dentro de "mensaje" porque todas las plantillas ya lo imprimen.
test('paramsDeTicket announces the courtesy inside the message and on its own', () => {
  const params = paramsDeTicket(ticket({ cortesia: '1 shot gratis' }), { asunto: 'Tu entrada', mensaje: 'Confirmamos tu pago.' }, URLS);
  assert.equal(params.mensaje, 'Confirmamos tu pago. Tu entrada incluye una cortesía: 1 shot gratis. La reclamás en la barra mostrando este mismo QR, después de entrar.');
  assert.equal(params.cortesia, '1 shot gratis');
});

test('paramsDeTicket falls back to generic event and ticket type', () => {
  const params = paramsDeTicket(ticket({ evento: null, tipoEntrada: null }), { asunto: 'x', mensaje: 'y' }, URLS);
  assert.equal(params.evento, 'tu evento');
  assert.equal(params.tipo_entrada, 'General');
});
```

- [ ] **Paso 2: Verificar que fallan**

Run: `node --test tests/lib/correoTicket.test.js`
Esperado: FAIL con `Cannot find module '../../lib/correoTicket'`.

- [ ] **Paso 3: Crear el módulo**

`lib/correoTicket.js`:

```js
// lib/correoTicket.js

// Los nombres de estos campos son el contrato con las plantillas de EmailJS:
// si aquí se renombra uno, la plantilla lo imprime vacío y EmailJS no avisa.
function paramsDeTicket(ticket, { asunto, mensaje }, { qrUrl, ticketUrl }) {
  const cortesia = ticket.cortesia || '';
  return {
    to_email: ticket.correo,
    to_name: ticket.nombre,
    subject: asunto,
    // La cortesía va dentro del mensaje porque todas las plantillas ya lo
    // imprimen: así se ve sin tocar nada en EmailJS. También va sola, por si
    // alguna plantilla la quiere destacar.
    mensaje: cortesia
      ? `${mensaje} Tu entrada incluye una cortesía: ${cortesia}. La reclamás en la barra mostrando este mismo QR, después de entrar.`
      : mensaje,
    cortesia,
    evento: ticket.evento || 'tu evento',
    tipo_entrada: ticket.tipoEntrada || 'General',
    qr_url: qrUrl,
    ticket_url: ticketUrl,
    // El uuid completo ya va dentro del QR y del enlace; para soporte basta el
    // fragmento, y así no queda un id entero suelto en la bandeja de entrada.
    referencia_corta: String(ticket.id).slice(0, 8).toUpperCase()
  };
}

module.exports = { paramsDeTicket };
```

- [ ] **Paso 4: Verificar que pasan**

Run: `node --test tests/lib/correoTicket.test.js` → verde.

- [ ] **Paso 5: Conectar en `server.js`**

1. Imports (arriba):

```js
const { createEventosRepo, cortesiaVigente, cortesiaDesdeFormulario } = require("./lib/eventos");
const { paramsDeTicket } = require("./lib/correoTicket");
```

(`cortesiaDesdeFormulario` se usa en la Tarea 5).

2. Borrar la función local `paramsDeTicket` y su comentario. Las tres llamadas pasan las URLs como tercer argumento y quedan así:

En `POST /api/crear-ticket`:

```js
      params: paramsDeTicket(ticket, {
        asunto: `Recibimos tu solicitud para ${evento.nombre}`,
        mensaje: `Recibimos tu referencia de pago para ${evento.nombre}. Tu entrada queda reservada y el código QR se activa en cuanto confirmemos el pago. Te avisamos por este mismo correo.`
      }, emailer.urlsDeTicket(ticket.id))
```

En `POST /api/admin/confirmar-pago/:ticketId`:

```js
      params: paramsDeTicket(updated, {
        asunto: `Tu entrada para ${updated.evento} ya está activa`,
        mensaje: "Confirmamos tu pago. Tu código QR ya está activo: preséntalo en la entrada del evento. Es personal y de un solo uso."
      }, emailer.urlsDeTicket(updated.id))
```

En `POST /api/admin/crear-qr`:

```js
        params: paramsDeTicket(ticket, {
          asunto: `Tu entrada para ${evento.nombre}`,
          mensaje: `Tu entrada ${tipoEntrada} para ${evento.nombre} ya está lista y activa. Presenta el código QR en la entrada del evento.`
        }, emailer.urlsDeTicket(ticket.id))
```

3. En `POST /api/crear-ticket`, dentro del objeto de `entradasRepo.crear({ … })`, después de `estado: "PENDIENTE_PAGO"`:

```js
      estado: "PENDIENTE_PAGO",
      // Cuenta el momento del comprobante, no el de la confirmación del pago.
      cortesia: cortesiaVigente(evento, new Date())
```

4. En `POST /api/admin/crear-qr`, antes del `for`:

```js
    // Una sola decisión para toda la tanda: todas las invitaciones de un mismo
    // pedido traen lo mismo.
    const cortesia = cortesiaVigente(evento, new Date());
```

y en `entradasRepo.crearGenerada({ … })`, después de `generado_por: req.usuario.id`:

```js
        generado_por: req.usuario.id,
        cortesia
```

5. Renombre a invitación: `MAX_CORTESIAS` → `MAX_INVITACIONES` (declaración y los dos usos). El comentario de arriba empieza «Cada invitación es una inserción…». En la respuesta de `crear-qr`, los dos mensajes dicen `invitación(es)` en lugar de `QR`:

```js
        ? `Se generaron ${generated.length} invitación(es), pero ${fallidos.length} correo(s) no salieron (${fallidos[0].error}). Las entradas son válidas igual: podés pasarlas desde el listado.`
        : `Se generaron ${generated.length} invitación(es) y se enviaron ${enviados} correo(s) a ${correo}.`,
```

y el mensaje del `catch`: `"No se pudieron generar las invitaciones."`.

- [ ] **Paso 6: Verificar**

Run: `npm test` → todo en verde. Run: `node -e "require('./server')"` → sin errores.

- [ ] **Paso 7: Commit**

```bash
git add lib/correoTicket.js tests/lib/correoTicket.test.js server.js
git commit -F - <<'EOF'
feat: attach the early-bird courtesy to new tickets and their emails

Las compras y las invitaciones creadas antes del limite guardan la cortesia
vigente. Los tres correos la anuncian dentro de "mensaje", que las
plantillas ya imprimen, y en una variable propia. paramsDeTicket pasa a su
propio modulo para poder probarlo. Las entradas gratis del panel pasan a
llamarse invitaciones.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Tarea 5: Rutas de configuración, canje y consulta

**Archivos:**
- Modificar: `server.js` (rutas de eventos, `admin/entradas/:id/cortesia`, `canjear-cortesia`, `validar-ticket`, `ticket/:ticketId`)
- Test: `tests/server.test.js`

**Interfaces:**
- Consume: `cortesiaDesdeFormulario` (Tarea 2); `contarCortesias`, `ponerCortesia`, `canjearCortesia`, `obtenerPorId` (Tarea 3).
- Produce (lo que usan las Tareas 6 a 8):
  - `POST /api/canjear-cortesia` `{ ticketId }` → `{ ok: true, permitido, motivo, mensaje, nombre, evento, cortesia, entregadaEn }` (200 si permitido, 403 si no) o `{ ok: false, mensaje }` (400/500).
  - `PUT /api/admin/entradas/:id/cortesia` `{ dar: boolean }` → `{ ok: true, ticket, mensaje }`.
  - `POST /api/validar-ticket` suma `cortesia` (string o null).
  - `GET /api/ticket/:id` suma `cortesia` y `cortesiaEntregada`.
  - `GET /api/admin/eventos` suma `cortesias: { asignadas, entregadas }` por evento.
  - `POST` y `PUT /api/admin/eventos` aceptan `cortesia` y `cortesiaHasta`.

- [ ] **Paso 1: Escribir las pruebas que fallan**

En `tests/server.test.js`, antes de `test('POST /api/admin/usuarios/invitar returns 401 without a token'…`:

```js
test('POST /api/canjear-cortesia returns 401 without a token', async () => {
  const res = await request(app).post('/api/canjear-cortesia').send({ ticketId: 'x' });
  assert.equal(res.status, 401);
  assert.equal(res.body.ok, false);
});

test('POST /api/canjear-cortesia returns 503 with a token when unconfigured', async () => {
  const res = await request(app).post('/api/canjear-cortesia').set('Authorization', 'Bearer fake').send({ ticketId: 'x' });
  assert.equal(res.status, 503);
});

test('PUT /api/admin/entradas/:id/cortesia returns 401 without a token', async () => {
  const res = await request(app)
    .put('/api/admin/entradas/3f7c1b2e-9a4d-4f01-8b7e-2c5d6a8f1e40/cortesia')
    .send({ dar: true });
  assert.equal(res.status, 401);
  assert.equal(res.body.ok, false);
});
```

- [ ] **Paso 2: Verificar que fallan**

Run: `node --test tests/server.test.js`
Esperado: los tres nuevos fallan con `404`.

- [ ] **Paso 3: Implementar**

En `server.js`:

1. Debajo de `const MAX_INVITACIONES = 20;`:

```js
const ERRORES_CORTESIA = {
  ENTRADA_NO_ENCONTRADA: [404, "Entrada no encontrada."],
  EVENTO_SIN_CORTESIA: [400, "El evento de esta entrada no tiene cortesía configurada."],
  YA_TIENE_CORTESIA: [409, "Esta entrada ya tiene cortesía."],
  CORTESIA_ENTREGADA: [409, "La cortesía ya se entregó: no se puede quitar."],
  CORTESIA_INCOMPLETA: [400, "Para la cortesía hacen falta el texto y la fecha límite, o ninguno de los dos."],
  CORTESIA_LARGA: [400, "La cortesía puede tener hasta 60 caracteres."],
  CORTESIA_FECHA: [400, "La fecha límite de la cortesía no es válida."]
};

// Responde un error conocido de cortesía. Devuelve false si no lo es, para
// que la ruta siga con su 500.
function responderErrorCortesia(res, error) {
  const conocido = error && ERRORES_CORTESIA[error.error];
  if (!conocido) return false;
  res.status(conocido[0]).json({ ok: false, mensaje: conocido[1] });
  return true;
}
```

2. `GET /api/admin/eventos`:

```js
app.get("/api/admin/eventos", requireRole("admin"), async (req, res) => {
  try {
    const eventos = await eventosRepo.listarTodos();
    const conteos = await Promise.all(eventos.map((ev) => entradasRepo.contarCortesias(ev.id)));
    res.json({ ok: true, eventos: eventos.map((ev, i) => ({ ...ev, cortesias: conteos[i] })) });
  } catch (error) {
    console.error("Error al consultar eventos del panel:", error);
    res.status(500).json({ ok: false, mensaje: "No se pudieron consultar los eventos." });
  }
});
```

3. `POST /api/admin/eventos`: dentro del `eventosRepo.crear({ … })`, después de `creado_por: req.usuario.id`:

```js
      creado_por: req.usuario.id,
      ...cortesiaDesdeFormulario(req.body.cortesia, req.body.cortesiaHasta)
```

y en su `catch`, antes del `console.error`:

```js
    if (responderErrorCortesia(res, error)) return;
```

4. `PUT /api/admin/eventos/:id`: después de la línea de `activo`:

```js
    if (req.body.cortesia !== undefined || req.body.cortesiaHasta !== undefined) {
      Object.assign(cambios, cortesiaDesdeFormulario(req.body.cortesia, req.body.cortesiaHasta));
    }
```

y en su `catch`, antes del `console.error`:

```js
    if (responderErrorCortesia(res, error)) return;
```

5. Después de `GET /api/admin/entradas`:

```js
// Dar o quitar la cortesía de una entrada puntual. Es una decisión de
// negocio, así que solo el admin.
app.put("/api/admin/entradas/:id/cortesia", requireRole("admin"), async (req, res) => {
  try {
    const dar = req.body.dar === true;
    const ticket = await entradasRepo.ponerCortesia(String(req.params.id || ""), dar);
    res.json({ ok: true, ticket, mensaje: dar ? `Cortesía dada: ${ticket.cortesia}.` : "Cortesía quitada." });
  } catch (error) {
    if (responderErrorCortesia(res, error)) return;
    console.error("Error al cambiar la cortesía:", error);
    res.status(500).json({ ok: false, mensaje: "No se pudo cambiar la cortesía." });
  }
});
```

6. `GET /api/ticket/:ticketId`: en el objeto `ticket` de la respuesta, después de `pagado: ticket.pagado`:

```js
        pagado: ticket.pagado,
        cortesia: ticket.cortesia,
        cortesiaEntregada: Boolean(ticket.cortesiaEntregadaEn)
```

7. `POST /api/validar-ticket` completo:

```js
app.post("/api/validar-ticket", requireRole("staff", "admin"), async (req, res) => {
  try {
    const ticketId = String(req.body.ticketId || "").trim();
    if (!ticketId) {
      return res.status(400).json({ ok: false, permitido: false, mensaje: "QR no válido." });
    }

    const resultado = await entradasRepo.validar(ticketId);
    const cortesia = resultado.permitido ? await cortesiaPendiente(ticketId) : null;
    res.status(resultado.permitido ? 200 : 403).json({ ok: true, ...resultado, cortesia });
  } catch (error) {
    console.error("Error al validar ticket:", error);
    res.status(500).json({ ok: false, permitido: false, mensaje: "No se pudo validar el ticket." });
  }
});

// Solo informa. La entrada ya quedó marcada: si esta lectura falla, responder
// 500 haría que el siguiente escaneo diga "ya utilizado" a alguien que nunca
// vio el "Adelante".
async function cortesiaPendiente(ticketId) {
  try {
    const ticket = await entradasRepo.obtenerPorId(ticketId);
    return ticket && ticket.cortesia && !ticket.cortesiaEntregadaEn ? ticket.cortesia : null;
  } catch (error) {
    console.error("No se pudo leer la cortesía tras validar:", error);
    return null;
  }
}

app.post("/api/canjear-cortesia", requireRole("staff", "admin"), async (req, res) => {
  try {
    const ticketId = String(req.body.ticketId || "").trim();
    if (!ticketId) {
      return res.status(400).json({ ok: false, permitido: false, mensaje: "QR no válido." });
    }

    const resultado = await entradasRepo.canjearCortesia(ticketId, req.usuario.id);
    res.status(resultado.permitido ? 200 : 403).json({ ok: true, ...resultado });
  } catch (error) {
    console.error("Error al canjear cortesía:", error);
    res.status(500).json({ ok: false, permitido: false, mensaje: "No se pudo canjear la cortesía." });
  }
});
```

- [ ] **Paso 4: Verificar que pasan**

Run: `npm test` → todo en verde (los tres nuevos incluidos).

- [ ] **Paso 5: Commit**

```bash
git add server.js tests/server.test.js
git commit -F - <<'EOF'
feat: expose courtesy configuration, redemption and status in the API

Los eventos aceptan cortesia y fecha limite, y el panel recibe el conteo
por evento. Rutas nuevas para canjear (staff y admin) y para dar o quitar a
mano (solo admin). Validar una entrada informa si trae cortesia, sin que
esa lectura pueda tumbar una entrada ya marcada.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Tarea 6: Escáner del teléfono con modo Cortesía (`public/scanner.html`)

**Archivos:**
- Modificar: `public/scanner.html`

**Interfaces:**
- Consume: `POST /api/validar-ticket` (con `cortesia`) y `POST /api/canjear-cortesia` (Tarea 5).
- Produce: funciones globales `ponerModo(modo)`, `alLeer(texto)` y `mostrarResultado(tipo, titulo, detalle, extra)`, más la variable `modoEscaner`. Las pruebas de navegador las usan.

- [ ] **Paso 0: Servidor estático para probar el frontend**

Con el servidor Express local, `/scanner` y el panel redirigen a `/login#staff` porque no hay Supabase. Abiertos como archivo, Chrome los convierte en `data:` y bloquea `localStorage`. Un servidor que solo sirve `public/` evita las dos cosas: `/api/config` da 404, las páginas no redirigen y el origen es `http`.

Crear `.claude/servidor-estatico.js` (la carpeta `.claude/` no se sube al repo):

```js
// Sirve public/ sin la API: las páginas no pueden leer /api/config, no
// redirigen al login y se pueden probar con dobles de fetch.
const http = require('http');
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..', 'public');
const tipos = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.js': 'text/javascript', '.css': 'text/css' };

http.createServer((req, res) => {
  const ruta = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const archivo = path.join(raiz, ruta === '/' ? 'index.html' : ruta);
  if (!archivo.startsWith(raiz)) { res.writeHead(403); res.end(); return; }
  fs.readFile(archivo, (error, datos) => {
    if (error) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('no existe'); return; }
    res.writeHead(200, { 'Content-Type': tipos[path.extname(archivo)] || 'application/octet-stream' });
    res.end(datos);
  });
}).listen(3100);
```

Agregar en `.claude/launch.json`, dentro de `configurations`:

```json
    {
      "name": "whineup-estatico",
      "runtimeExecutable": "node",
      "runtimeArgs": [".claude/servidor-estatico.js"],
      "port": 3100
    }
```

`preview_start` con `whineup-estatico`.

- [ ] **Paso 1: Escribir la prueba de navegador que falla**

Navegar a `http://localhost:3100/scanner.html` (queda el aviso «Sin acceso a la cámara», que el script oculta). `javascript_tool`:

```js
await (async () => {
  const q = (s) => document.querySelector(s);
  document.querySelector('#aviso').hidden = true;
  const respuestas = [];
  window.fetch = async (url) => {
    const [status, body] = respuestas.shift();
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  const leer = () => ({ clase: q('#resultado').className, titulo: q('#resTitulo').textContent, detalle: q('#resDetalle').textContent, extra: q('#resExtra') && !q('#resExtra').hidden ? q('#resExtra').textContent : null });
  const escanear = async (codigo, status, body) => { respuestas.push([status, body]); procesando = false; ultimoCodigo = null; await alLeer(codigo); return leer(); };
  const r = { hayModos: !!q('#modoCortesia') };
  if (!r.hayModos) return 'SIN MODOS: ' + JSON.stringify(r);
  ponerModo('entrada');
  r.entradaConCortesia = await escanear('a', 200, { ok: true, permitido: true, nombre: 'Ana', tipoEntrada: 'General', cortesia: '1 shot gratis' });
  ponerModo('cortesia');
  r.recordado = localStorage.getItem('whineup.escaner.modo');
  r.claseApp = q('.app').className;
  r.entregar = await escanear('b', 200, { ok: true, permitido: true, motivo: 'ENTREGAR', nombre: 'Ana', cortesia: '1 shot gratis', entregadaEn: '2026-10-05T04:14:00Z' });
  r.yaEntregada = await escanear('c', 403, { ok: true, permitido: false, motivo: 'YA_ENTREGADA', entregadaEn: '2026-10-05T04:14:00Z' });
  r.sinCortesia = await escanear('d', 403, { ok: true, permitido: false, motivo: 'SIN_CORTESIA' });
  r.noIngreso = await escanear('e', 403, { ok: true, permitido: false, motivo: 'NO_INGRESO' });
  r.noEncontrada = await escanear('f', 403, { ok: true, permitido: false, motivo: 'NO_ENCONTRADA' });
  r.error = await escanear('g', 500, { ok: false, permitido: false, mensaje: 'No se pudo canjear la cortesía.' });
  ponerModo('entrada');
  return JSON.stringify(r, null, 1);
})()
```

Esperado ahora: `SIN MODOS: {"hayModos":false}`.

Esperado al terminar:
- `entradaConCortesia`: clase `resultado ok`, título `Adelante`, extra `Trae cortesía: 1 shot gratis`.
- `recordado`: `cortesia`, y `claseApp` contiene `modo-cortesia`.
- `entregar`: `resultado ok` · `Entregar` · `1 shot gratis · Ana`.
- `yaEntregada`: `resultado mal` · `Ya se entregó` · detalle que empieza con `Se entregó a las`.
- `sinCortesia`: `resultado mal` · `Sin cortesía`.
- `noIngreso`: `resultado mal` · `Todavía no entró` · detalle que termina en `¿Estás en modo Cortesía?`.
- `noEncontrada`: `resultado mal` · `Ticket no encontrado`.
- `error`: `resultado error` · `Sin validar`.

- [ ] **Paso 2: Implementar**

En `public/scanner.html`:

1. CSS: en `:root` agregar `--cortesia:oklch(72% .16 300);`, y después de `.salir{…}`:

```css
      .modos{display:flex;gap:8px;padding:10px 16px;background:oklch(0% 0 0 / 70%);border-bottom:1px solid var(--border);z-index:3;}
      .modo{flex:1;min-height:44px;border:1px solid var(--border-strong);border-radius:999px;background:transparent;font-size:14px;font-weight:700;}
      .modo[aria-checked="true"]{background:#fff;color:#0a0a0a;border-color:#fff;}
      /* El modo Cortesía no deja pasar a nadie: tiene que notarse de lejos. */
      .app.modo-cortesia .modo[aria-checked="true"]{background:var(--cortesia);border-color:var(--cortesia);}
      .app.modo-cortesia .barra{box-shadow:inset 0 -3px 0 var(--cortesia);}
      .resultado .extra{font-size:15px;font-weight:700;border-top:1px solid currentColor;padding-top:10px;max-width:28ch;}
```

2. HTML: después del cierre de `.barra`:

```html
      <div class="modos" role="radiogroup" aria-label="Modo del escáner">
        <button type="button" class="modo" id="modoEntrada" role="radio" aria-checked="true">Entrada</button>
        <button type="button" class="modo" id="modoCortesia" role="radio" aria-checked="false">Cortesía</button>
      </div>
```

Dentro de `#resultado`, después de `#resDetalle`:

```html
          <p class="extra" id="resExtra" hidden></p>
```

3. JS: después de `let wakeLock = null;`:

```js
      // En la barra el teléfono se queda en Cortesía: se recuerda por equipo.
      const CLAVE_MODO = 'whineup.escaner.modo';
      let modoEscaner = 'entrada';
      try { if (localStorage.getItem(CLAVE_MODO) === 'cortesia') modoEscaner = 'cortesia'; } catch (e) { /* sin almacenamiento arranca en Entrada */ }
```

4. `mostrarResultado` pasa a:

```js
      function mostrarResultado(tipo, titulo, detalle, extra) {
        const caja = $('#resultado');
        caja.className = `resultado ${tipo}`;
        $('#resIcono').textContent = RESULTADOS[tipo].icono;
        $('#resTitulo').textContent = titulo;
        $('#resDetalle').textContent = detalle;
        $('#resExtra').textContent = extra || '';
        $('#resExtra').hidden = !extra;
        caja.hidden = false;
        vibrar(RESULTADOS[tipo].vibracion);
      }
```

5. Reemplazar el bloque `try { const response = await authFetch('/api/validar-ticket' … } catch (error) { … Sin conexión … }` dentro de `alLeer` por:

```js
        try {
          if (modoEscaner === 'cortesia') {
            await canjearCortesia(codigo);
          } else {
            await validarEntrada(codigo);
          }
        } catch (error) {
          mostrarResultado('error', 'Sin conexión', 'No se pudo validar. Revisá la señal e intentá de nuevo.');
        }
```

6. Antes de `async function alLeer`, agregar:

```js
      async function validarEntrada(codigo) {
        const response = await authFetch('/api/validar-ticket', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticketId: codigo })
        });
        const data = await response.json();

        if (data.permitido) {
          const partes = [data.nombre, data.tipoEntrada].filter(Boolean).join(' · ');
          mostrarResultado('ok', 'Adelante', partes || 'Entrada válida', data.cortesia ? `Trae cortesía: ${data.cortesia}` : '');
        } else if (data.ok) {
          mostrarResultado('mal', 'Denegado', data.mensaje || 'Entrada no válida');
        } else {
          // La ruta responde ok:false cuando no pudo revisar el ticket.
          mostrarResultado('error', 'Sin validar', data.mensaje || 'No se pudo validar. Intentá de nuevo.');
        }
      }

      const TITULOS_CANJE = {
        ENTREGAR: 'Entregar',
        YA_ENTREGADA: 'Ya se entregó',
        SIN_CORTESIA: 'Sin cortesía',
        NO_INGRESO: 'Todavía no entró',
        NO_ENCONTRADA: 'Ticket no encontrado'
      };

      function horaCorta(iso) {
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat('es-CR', { hour: 'numeric', minute: '2-digit' }).format(d);
      }

      async function canjearCortesia(codigo) {
        const response = await authFetch('/api/canjear-cortesia', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticketId: codigo })
        });
        const data = await response.json();

        if (!data.ok) {
          mostrarResultado('error', 'Sin validar', data.mensaje || 'No se pudo canjear. Intentá de nuevo.');
          return;
        }
        const titulo = TITULOS_CANJE[data.motivo] || 'No se pudo canjear';
        if (data.permitido) {
          mostrarResultado('ok', titulo, [data.cortesia, data.nombre].filter(Boolean).join(' · '));
          return;
        }
        const detalles = {
          YA_ENTREGADA: data.entregadaEn ? `Se entregó a las ${horaCorta(data.entregadaEn)}.` : 'Ya se había entregado.',
          SIN_CORTESIA: 'Esta entrada no trae cortesía.',
          NO_INGRESO: 'Primero tiene que pasar por la puerta. ¿Estás en modo Cortesía?',
          NO_ENCONTRADA: 'Este QR no es de una entrada de WhineUp.'
        };
        mostrarResultado('mal', titulo, detalles[data.motivo] || data.mensaje || 'No se pudo canjear.');
      }

      function ponerModo(nuevo) {
        modoEscaner = nuevo === 'cortesia' ? 'cortesia' : 'entrada';
        try { localStorage.setItem(CLAVE_MODO, modoEscaner); } catch (e) { /* queda solo en memoria */ }
        const esCortesia = modoEscaner === 'cortesia';
        $('.app').classList.toggle('modo-cortesia', esCortesia);
        $('#modoEntrada').setAttribute('aria-checked', String(!esCortesia));
        $('#modoCortesia').setAttribute('aria-checked', String(esCortesia));
        $('#pista').textContent = esCortesia ? 'Apuntá al QR para entregar la cortesía' : 'Apuntá al código QR de la entrada';
        // La espera por código es por modo: el mismo QR recién leído en la
        // puerta se puede leer enseguida en Cortesía.
        ultimoCodigo = null;
      }

      $('#modoEntrada').addEventListener('click', () => ponerModo('entrada'));
      $('#modoCortesia').addEventListener('click', () => ponerModo('cortesia'));
      ponerModo(modoEscaner);
```

- [ ] **Paso 3: Verificar**

Recargar `http://localhost:3100/scanner.html` y repetir el script del Paso 1: todos los valores deben coincidir con lo esperado. Después, sin tocar nada, recargar otra vez y comprobar con `javascript_tool` que el modo quedó recordado:

```js
JSON.stringify({ modo: modoEscaner, claseApp: document.querySelector('.app').className, pista: document.querySelector('#pista').textContent })
```

Esperado (el script terminó en Entrada): `modo: 'entrada'`, `claseApp` sin `modo-cortesia`. Llamar `ponerModo('cortesia')`, recargar y repetir: `modo: 'cortesia'`, `claseApp` con `modo-cortesia`, pista `Apuntá al QR para entregar la cortesía`. Dejarlo en Entrada con `ponerModo('entrada')`.

Captura en tamaño de teléfono (`resize_window` con `mobile`) de los dos modos y de «Entregar»; después, `resize_window` con `desktop`. `read_console_messages` con `onlyErrors`: solo el 404 esperable de `/api/config`.

- [ ] **Paso 4: Commit**

```bash
git add public/scanner.html
git commit -F - <<'EOF'
feat: add a courtesy mode to the phone scanner

El escaner del telefono tiene modos Entrada y Cortesia, recordados por
equipo y bien visibles: en Cortesia no pasa nadie por la puerta. En Entrada
avisa si el QR trae cortesia; en Cortesia la entrega y explica cada rechazo.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Tarea 7: Panel (`public/scanner-dashboard.html`)

**Archivos:**
- Modificar: `public/scanner-dashboard.html`

**Interfaces:**
- Consume: `GET /api/admin/eventos` (`cortesia`, `cortesiaHasta`, `cortesias`), `POST`/`PUT /api/admin/eventos` (`cortesia`, `cortesiaHasta`), `GET /api/admin/entradas` (`cortesia`, `cortesiaEntregadaEn`, `eventoCortesia`), `PUT /api/admin/entradas/:id/cortesia`, `POST /api/validar-ticket` (`cortesia`).
- Produce: variable global `esAdminActual` y funciones `renderEventos(lista)`, `renderGeneratedTickets(tickets)`, `editarEvento(id)`, `cambiarCortesia(id, dar, boton)` y `validateTicket(id)`. Las pruebas de navegador las usan.

- [ ] **Paso 1: Escribir la prueba de navegador que falla**

Con `whineup-estatico` corriendo (Tarea 6, Paso 0), navegar a `http://localhost:3100/scanner-dashboard.html` (no redirige). `javascript_tool`:

```js
await (async () => {
  const q = (s) => document.querySelector(s);
  const pedidas = [];
  const EV = { id: 'e1', nombre: 'HALLOWEEN PARTY', fecha: '2026-10-05T01:00:00Z', lugar: 'WhineUp CR', precio: 3500, categoria: 'General', descripcion: null, cupoMaximo: 200, activo: true, bannerUrl: null, cortesia: '1 shot gratis', cortesiaHasta: '2026-09-22T05:59:00Z', cortesias: { asignadas: 12, entregadas: 5 } };
  window.fetch = async (url, opts = {}) => {
    pedidas.push(`${opts.method || 'GET'} ${url} ${opts.body || ''}`.trim());
    const cuerpo = url === '/api/admin/eventos' && !opts.method ? { ok: true, eventos: [EV] } : { ok: true, mensaje: 'Cortesía dada: 1 shot gratis.', tickets: [] };
    return new Response(JSON.stringify(cuerpo), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const r = {};
  renderEventos([EV]);
  r.lineasEvento = [...q('#eventosList .row-card').querySelectorAll('.meta')].map((m) => m.textContent.trim());
  r.hayCamposCortesia = !!q('#eventoCortesia') && !!q('#eventoCortesiaHasta');
  if (!r.hayCamposCortesia) return 'SIN CAMPOS: ' + JSON.stringify(r);
  editarEvento('e1');
  r.formEditado = { cortesia: q('#eventoCortesia').value, hasta: q('#eventoCortesiaHasta').value !== '' };
  q('#eventoCortesiaHasta').value = '';
  q('#eventoForm').requestSubmit();
  await new Promise((res) => setTimeout(res, 50));
  r.incompleta = { aviso: q('#eventoResult').textContent, pedidas: pedidas.filter((p) => p.startsWith('PUT')).length };
  const tickets = [
    { id: 't1', nombre: 'Ana', evento: 'HALLOWEEN PARTY', tipoEntrada: 'General', estado: 'PENDIENTE', generadoPor: null, cortesia: null, cortesiaEntregadaEn: null, eventoCortesia: '1 shot gratis' },
    { id: 't2', nombre: 'Beto', evento: 'HALLOWEEN PARTY', tipoEntrada: 'General', estado: 'INGRESADO', generadoPor: 'u1', cortesia: '1 shot gratis', cortesiaEntregadaEn: null, eventoCortesia: '1 shot gratis' },
    { id: 't3', nombre: 'Caro', evento: 'HALLOWEEN PARTY', tipoEntrada: 'VIP', estado: 'INGRESADO', generadoPor: null, cortesia: '1 shot gratis', cortesiaEntregadaEn: '2026-10-05T04:14:00Z', eventoCortesia: '1 shot gratis' }
  ];
  const filas = () => [...q('#generatedTickets').querySelectorAll('.row-card')].map((c) => ({ texto: c.textContent.replace(/\s+/g, ' ').trim(), botones: [...c.querySelectorAll('button')].map((b) => b.textContent.trim()) }));
  esAdminActual = false;
  renderGeneratedTickets(tickets);
  r.comoStaff = filas();
  esAdminActual = true;
  renderGeneratedTickets(tickets);
  r.comoAdmin = filas();
  pedidas.length = 0;
  q('[data-cortesia="t1"]').click();
  await new Promise((res) => setTimeout(res, 50));
  r.dar = { pedidas: [...pedidas], aviso: q('#ticketsResult').textContent };
  r.tituloGenerador = q('#adminGenerator h4').textContent;
  return JSON.stringify(r, null, 1);
})()
```

Esperado ahora: `SIN CAMPOS: …`, y `lineasEvento` sin la línea de cortesía.

Esperado al terminar:
- `lineasEvento` incluye `Cortesía: 1 shot gratis · hasta …` (o `· vencida` si la fecha ya pasó) y `12 con cortesía · 5 entregadas`.
- `formEditado`: `{ cortesia: '1 shot gratis', hasta: true }`.
- `incompleta`: aviso `Para la cortesía hacen falta el texto y la fecha límite, o ninguno de los dos.` y `pedidas: 0`.
- `comoStaff`: Ana sin cortesía y sin botones; Beto con «Invitación», «Cortesía: 1 shot gratis · sin entregar» y sin botones; Caro con «Compra» y «· entregada …».
- `comoAdmin`: Ana con `["Dar cortesía"]`, Beto con `["Quitar cortesía"]`, Caro con `[]`.
- `dar`: `["PUT /api/admin/entradas/t1/cortesia {\"dar\":true}", "GET /api/admin/entradas", "GET /api/admin/eventos"]` (se recargan la lista y el contador) y aviso `Cortesía dada: 1 shot gratis.`
- `tituloGenerador`: `Generar invitaciones`.

- [ ] **Paso 2: Implementar**

En `public/scanner-dashboard.html`:

1. CSS, después de `.banner-mini{…}`:

```css
      .campo-fecha{display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--text-dim);}
```

2. Generador: `<h4>Generar QR de cortesía</h4>` → `<h4>Generar invitaciones</h4>`; el botón `Generar QR` → `Generar invitaciones`, y en su `finally` (`boton.textContent = 'Generar QR';`) el mismo texto. El comentario `// Si las cortesías o las confirmaciones no llegan…` pasa a `// Si las invitaciones o las confirmaciones no llegan…`.

3. Lista de entradas: después de `<div class="list-col" id="generatedTickets"></div>`:

```html
          <div class="aviso" id="ticketsResult" hidden role="status"></div>
```

4. Formulario de evento: después de `<input class="form-full" id="eventoCupo" …>`:

```html
            <input class="form-full" id="eventoCortesia" type="text" maxlength="60" placeholder="Cortesía de preventa (opcional, ej. 1 shot gratis)" autocomplete="off" />
            <label class="form-full campo-fecha" for="eventoCortesiaHasta">
              Cortesía válida para compras hasta
              <input id="eventoCortesiaHasta" type="datetime-local" />
            </label>
```

5. JS, junto a `let eventosCache = [];`:

```js
      let esAdminActual = false;
```

En `checkSession`, después de `const esAdmin = rol === 'admin';`:

```js
          esAdminActual = esAdmin;
```

6. `renderGeneratedTickets` completo:

```js
      function lineaCortesiaEntrada(t) {
        if (!t.cortesia) return '';
        const estado = t.cortesiaEntregadaEn ? `entregada ${formatFecha(t.cortesiaEntregadaEn)}` : 'sin entregar';
        return `<div class="meta">Cortesía: ${esc(t.cortesia)} · ${esc(estado)}</div>`;
      }

      // Dar y quitar es cosa del admin; el staff solo ve el estado.
      function botonCortesia(t) {
        if (!esAdminActual) return '';
        if (!t.cortesia && t.eventoCortesia) {
          return `<button type="button" class="approve" data-cortesia="${esc(t.id)}" data-dar="true">Dar cortesía</button>`;
        }
        if (t.cortesia && !t.cortesiaEntregadaEn) {
          return `<button type="button" class="approve" data-cortesia="${esc(t.id)}" data-dar="false">Quitar cortesía</button>`;
        }
        return '';
      }

      function renderGeneratedTickets(tickets) {
        const caja = $('#generatedTickets');
        if (!tickets.length) {
          caja.innerHTML = '<div class="empty">Todavía no hay entradas generadas.</div>';
          return;
        }
        caja.innerHTML = tickets.map((t) => {
          const boton = botonCortesia(t);
          return `
            <div class="row-card">
              <div class="row-top">
                <div>
                  <b>${esc(t.nombre)}</b>
                  <div class="meta">${esc(t.evento)} · ${esc(t.tipoEntrada)} · ${esc(t.generadoPor ? 'Invitación' : 'Compra')}</div>
                  ${lineaCortesiaEntrada(t)}
                </div>
                <span class="badge ${badgeDe(t.estado)}">${esc(t.estado)}</span>
              </div>
              ${boton ? `<div class="acciones">${boton}</div>` : ''}
            </div>
          `;
        }).join('');

        caja.querySelectorAll('[data-cortesia]').forEach((b) => {
          b.addEventListener('click', () => cambiarCortesia(b.dataset.cortesia, b.dataset.dar === 'true', b));
        });
      }

      async function cambiarCortesia(id, dar, boton) {
        boton.disabled = true;
        try {
          const response = await authFetch(`/api/admin/entradas/${encodeURIComponent(id)}/cortesia`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dar })
          });
          const data = await response.json();
          avisar($('#ticketsResult'), data.mensaje || 'No se pudo cambiar la cortesía.', response.ok);
          if (response.ok) { loadGeneratedTickets(); loadEventos(); }
        } catch (error) {
          avisar($('#ticketsResult'), 'No se pudo conectar con el servidor.', false);
        } finally {
          boton.disabled = false;
        }
      }
```

(`loadEventos()` solo lo usa el admin, y `cambiarCortesia` solo se llama desde botones de admin).

7. `renderEventos`: dentro del template, después de la segunda línea `<div class="meta">…categoria…</div>`:

```js
                ${lineaCortesiaEvento(ev)}
```

y antes de `function renderEventos`:

```js
      function lineaCortesiaEvento(ev) {
        const partes = [];
        if (ev.cortesia) {
          const vencida = new Date(ev.cortesiaHasta).getTime() < Date.now();
          partes.push(`<div class="meta">Cortesía: ${esc(ev.cortesia)} · ${vencida ? 'vencida' : `hasta ${esc(formatFechaEvento(ev.cortesiaHasta))}`}</div>`);
        }
        const conteo = ev.cortesias || { asignadas: 0, entregadas: 0 };
        if (ev.cortesia || conteo.asignadas) {
          partes.push(`<div class="meta">${conteo.asignadas} con cortesía · ${conteo.entregadas} entregadas</div>`);
        }
        return partes.join('');
      }
```

8. `editarEvento`: después de `$('#eventoCupo').value = …`:

```js
        $('#eventoCortesia').value = ev.cortesia || '';
        $('#eventoCortesiaHasta').value = ev.cortesiaHasta ? aDatetimeLocal(ev.cortesiaHasta) : '';
```

9. Submit del evento: después de `if (!fecha) { … }`:

```js
        const cortesia = $('#eventoCortesia').value.trim();
        const hastaLocal = $('#eventoCortesiaHasta').value;
        if (Boolean(cortesia) !== Boolean(hastaLocal)) {
          avisar($('#eventoResult'), 'Para la cortesía hacen falta el texto y la fecha límite, o ninguno de los dos.', false);
          return;
        }
```

y en `cuerpo`, después de `cupoMaximo: …`:

```js
          cupoMaximo: cupo ? Number(cupo) : null,
          cortesia,
          // Igual que la fecha del evento: se convierte con la zona del navegador.
          cortesiaHasta: hastaLocal ? new Date(hastaLocal).toISOString() : ''
```

10. Escáner embebido (`validateTicket`): el cálculo de `detalle` pasa a:

```js
          const cortesia = data.permitido && data.cortesia ? ` · Trae cortesía: ${data.cortesia}` : '';
          const detalle = data.permitido && data.nombre
            ? `${data.nombre} · ${data.evento || ''} · ${data.tipoEntrada || ''}${cortesia}`
            : (data.mensaje || 'No se pudo validar el ticket.');
```

- [ ] **Paso 3: Verificar**

Recargar `http://localhost:3100/scanner-dashboard.html` y repetir el script del Paso 1: todo coincide con lo esperado. Probar el escáner embebido:

```js
await (async () => {
  window.fetch = async () => new Response(JSON.stringify({ ok: true, permitido: true, nombre: 'Ana', evento: 'HALLOWEEN PARTY', tipoEntrada: 'General', cortesia: '1 shot gratis' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  await validateTicket('3f7c1b2e-9a4d-4f01-8b7e-2c5d6a8f1e40');
  const conCortesia = document.querySelector('#resultDetail').textContent;
  window.fetch = async () => new Response(JSON.stringify({ ok: true, permitido: true, nombre: 'Ana', evento: 'HALLOWEEN PARTY', tipoEntrada: 'General', cortesia: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  await validateTicket('3f7c1b2e-9a4d-4f01-8b7e-2c5d6a8f1e40');
  return JSON.stringify({ conCortesia, sinCortesia: document.querySelector('#resultDetail').textContent });
})()
```

Esperado: `conCortesia` = `Ana · HALLOWEEN PARTY · General · Trae cortesía: 1 shot gratis`, `sinCortesia` = `Ana · HALLOWEEN PARTY · General`.

Captura del formulario y de la lista (quitar `hidden` de `#eventosSection` y `#ticketsSection` con `javascript_tool` para verlos). Consola sin errores de JavaScript (solo el 404 de `/api/config`).

- [ ] **Paso 4: Commit**

```bash
git add public/scanner-dashboard.html
git commit -F - <<'EOF'
feat: manage early-bird courtesies from the panel

El evento se configura con texto y fecha limite, y la lista muestra si esta
vigente y cuantas se dieron y entregaron. Cada entrada muestra su cortesia,
y el admin puede darla o quitarla. Las entradas gratis pasan a llamarse
invitaciones.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Tarea 8: Portada y página del ticket

**Archivos:**
- Modificar: `public/index.html`
- Modificar: `public/ticket.html`

**Interfaces:**
- Consume: `GET /api/eventos` (`cortesia` y `cortesiaHasta` solo si están vigentes), `POST /api/crear-ticket` (`ticket.cortesia`), `GET /api/ticket/:id` (`cortesia`, `cortesiaEntregada`).
- Produce: funciones globales `arrancar()`, `abrirModal(evento)`, `cargarEventos()` y `lineaCortesia(ev)` en la portada, y `cargar()` en el ticket.

- [ ] **Paso 1: Escribir la prueba de navegador que falla (portada)**

`preview_start` con `whineup`; navegar a `http://localhost:3000/?c=1`. `javascript_tool`:

```js
await (async () => {
  const q = (s) => document.querySelector(s);
  const base = { fecha: '2026-10-05T01:00:00+00:00', lugar: 'WhineUp CR, San Jose', precio: 3500, categoria: 'General', descripcion: 'Fiesta', cupoMaximo: 200, activo: true, bannerUrl: null };
  const conCortesia = { ...base, id: 'fa3d636f-ffae-4a82-88f4-56c84714665b', nombre: 'HALLOWEEN PARTY', cortesia: '1 shot gratis', cortesiaHasta: '2026-09-22T05:59:00Z' };
  const sinCortesia = { ...base, id: '1a2b3c4d-0000-4000-8000-000000000002', nombre: 'NAVIDAD', cortesia: null, cortesiaHasta: null };
  let eventos = [conCortesia, sinCortesia];
  window.fetch = async (url) => {
    const cuerpos = { '/api/config': { ok: true, supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon', paymentPhone: '+506 8888 8888' }, '/api/eventos': { ok: true, eventos }, '/api/estadisticas-publicas': { ok: true, entradas: 0 } };
    return new Response(JSON.stringify(cuerpos[url] || { ok: false }), { status: cuerpos[url] ? 200 : 404, headers: { 'Content-Type': 'application/json' } });
  };
  window.supabase = { createClient: () => ({ auth: { getSession: async () => ({ data: { session: null }, error: null }), onAuthStateChange: () => ({}), signInWithOAuth: async () => ({}) } }) };
  const texto = (el) => (el && !el.hidden ? el.textContent.replace(/\s+/g, ' ').trim() : null);
  await arrancar();
  const r = {};
  r.hero = texto(q('#heroCortesia'));
  r.tarjetas = [...document.querySelectorAll('#eventCards .card')].map((c) => texto(c.querySelector('.cortesia-linea')));
  document.querySelectorAll('#eventCards .card-btn')[0].click();
  r.modalCon = texto(q('#modalCortesia'));
  cerrarModal();
  document.querySelectorAll('#eventCards .card-btn')[1].click();
  r.modalSin = texto(q('#modalCortesia'));
  cerrarModal();
  eventos = [sinCortesia];
  await cargarEventos();
  r.heroSin = texto(q('#heroCortesia'));
  return JSON.stringify(r, null, 1);
})()
```

Esperado ahora: `hero: null` y `tarjetas: [null, null]` (todavía no existe nada).

Esperado al terminar:
- `hero` y `tarjetas[0]`: `Comprando antes del 21 sept, 11:59 p. m.: 1 shot gratis` (fecha formateada en la zona del navegador).
- `tarjetas[1]`: `null`.
- `modalCon`: el mismo texto. `modalSin`: `null`. `heroSin`: `null`.

- [ ] **Paso 2: Implementar la portada**

En `public/index.html`:

1. CSS, después de `.card-banner{…}`:

```css
      .cortesia-linea{display:flex;align-items:flex-start;gap:8px;margin-top:14px;border:1px solid var(--border-strong);border-radius:12px;padding:10px 12px;font-size:13px;font-weight:600;line-height:1.4;color:var(--white);background:oklch(100% 0 0 / 6%);}
      .cortesia-linea svg{flex-shrink:0;margin-top:1px;}
```

2. HTML: en el destacado, después del `</div>` de `.hero-card-meta`:

```html
              <div class="cortesia-linea" id="heroCortesia" hidden></div>
```

En el modal, después del `</div>` de `.event-mini`:

```html
            <div class="cortesia-linea" id="modalCortesia" hidden></div>
```

En el paso 3, después de `<p class="modal-copy" id="exitoCopy"></p>`:

```html
                <p class="modal-copy" id="okCortesia" hidden></p>
```

3. JS, después de `const ICONO_LUGAR = …`:

```js
      const ICONO_REGALO = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M19 12v9H5v-9M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5"/></svg>';

      function formatFechaHora(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return new Intl.DateTimeFormat('es-CR', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(date);
      }

      // El servidor solo manda cortesías vigentes, así que aquí no se mira la fecha.
      function textoCortesia(ev) {
        return ev && ev.cortesia ? `Comprando antes del ${formatFechaHora(ev.cortesiaHasta)}: ${ev.cortesia}` : '';
      }

      function lineaCortesia(ev) {
        const texto = textoCortesia(ev);
        return texto ? `<div class="cortesia-linea">${ICONO_REGALO}<span>${esc(texto)}</span></div>` : '';
      }

      function pintarCortesia(el, ev) {
        const texto = textoCortesia(ev);
        el.innerHTML = texto ? `${ICONO_REGALO}<span>${esc(texto)}</span>` : '';
        el.hidden = !texto;
      }
```

4. En la plantilla de tarjeta (`renderEventos`), después del `</div>` de `.card-meta`:

```js
              ${lineaCortesia(ev)}
```

Después de `ponerImagen($('#heroBanner'), …)`:

```js
        pintarCortesia($('#heroCortesia'), destacado);
```

En `abrirModal`, después de `ponerImagen($('#modalBanner'), evento.bannerUrl, evento.nombre);`:

```js
        pintarCortesia($('#modalCortesia'), evento);
```

5. En el éxito de la compra (después de `$('#exitoCopy').textContent = …`):

```js
          // Sale de lo que quedó guardado en la entrada, no de lo que mostraba
          // el modal: el comprobante pudo llegar después del límite.
          const cortesiaGanada = data.ticket && data.ticket.cortesia;
          $('#okCortesia').textContent = cortesiaGanada
            ? `Tu entrada incluye: ${cortesiaGanada}. La reclamás en la barra con este mismo QR, después de entrar.`
            : '';
          $('#okCortesia').hidden = !cortesiaGanada;
```

- [ ] **Paso 3: Verificar la portada**

Recargar y repetir el script del Paso 1: coincide con lo esperado. Probar el paso 3 de la compra (recargar antes):

```js
await (async () => {
  const q = (s) => document.querySelector(s);
  const EV = { id: 'fa3d636f-ffae-4a82-88f4-56c84714665b', nombre: 'HALLOWEEN PARTY', fecha: '2026-10-05T01:00:00+00:00', lugar: 'WhineUp CR', precio: 3500, categoria: 'General', descripcion: 'Fiesta', cupoMaximo: 200, activo: true, bannerUrl: null, cortesia: '1 shot gratis', cortesiaHasta: '2026-09-22T05:59:00Z' };
  let cortesiaDevuelta = '1 shot gratis';
  window.fetch = async (url) => {
    if (url === '/api/crear-ticket') {
      return new Response(JSON.stringify({ ok: true, mensaje: 'Solicitud recibida.', ticket: { id: 't1', cortesia: cortesiaDevuelta } }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
    const cuerpos = { '/api/config': { ok: true, supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon', paymentPhone: '+506 8888 8888' }, '/api/eventos': { ok: true, eventos: [EV] }, '/api/estadisticas-publicas': { ok: true, entradas: 0 } };
    return new Response(JSON.stringify(cuerpos[url] || { ok: false }), { status: cuerpos[url] ? 200 : 404, headers: { 'Content-Type': 'application/json' } });
  };
  const sesion = { access_token: 'abc', user: { email: 'ana@ejemplo.com', user_metadata: { full_name: 'Ana Pérez' } } };
  window.supabase = { createClient: () => ({ auth: { getSession: async () => ({ data: { session: sesion }, error: null }), onAuthStateChange: () => ({}), signInWithOAuth: async () => ({}) } }) };
  await arrancar();
  const comprar = async () => {
    document.querySelector('#eventCards .card-btn').click();
    q('#phone').value = '+506 8888-0000';
    q('#paymentReference').value = '123456789';
    q('#paso2').requestSubmit();
    await new Promise((res) => setTimeout(res, 80));
    const texto = q('#okCortesia').hidden ? null : q('#okCortesia').textContent;
    cerrarModal();
    return texto;
  };
  const conCortesia = await comprar();
  cortesiaDevuelta = null;
  const sinCortesia = await comprar();
  return JSON.stringify({ conCortesia, sinCortesia });
})()
```

Esperado: `conCortesia` = `Tu entrada incluye: 1 shot gratis. La reclamás en la barra con este mismo QR, después de entrar.`, `sinCortesia` = `null`.

Captura en tamaño de teléfono del destacado y el modal.

- [ ] **Paso 4: Prueba que falla y cambio en `ticket.html`**

Navegar a `http://localhost:3000/ticket?ticketId=t1&c=2`. `javascript_tool`:

```js
await (async () => {
  const q = (s) => document.querySelector(s);
  const r = {};
  for (const [nombre, extra] of [['pendiente', { cortesia: '1 shot gratis', cortesiaEntregada: false }], ['entregada', { cortesia: '1 shot gratis', cortesiaEntregada: true }], ['sin', { cortesia: null, cortesiaEntregada: false }]]) {
    window.fetch = async () => new Response(JSON.stringify({ ok: true, ticket: { id: 't1', evento: 'HALLOWEEN PARTY', eventoFecha: '2026-10-05T01:00:00Z', eventoLugar: 'WhineUp CR', nombre: 'Ana', tipoEntrada: 'General', creadoEn: '2026-09-20T15:00:00Z', precio: 3500, pagado: true, ...extra } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    await cargar();
    const fila = q('#cortesiaFila');
    r[nombre] = fila && !fila.hidden ? q('#cortesiaTexto').textContent : null;
  }
  return JSON.stringify(r);
})()
```

Esperado ahora: todo `null`. Implementar en `public/ticket.html`:

HTML, en `.details`, después de la fila `Tipo de entrada`:

```html
          <div class="detail-row" id="cortesiaFila" hidden><span>Cortesía</span><b id="cortesiaTexto">—</b></div>
```

JS, en `cargar()`, después de `$('#ticketType').textContent = …`:

```js
          $('#cortesiaFila').hidden = !t.cortesia;
          $('#cortesiaTexto').textContent = t.cortesia
            ? `${t.cortesia} · ${t.cortesiaEntregada ? 'Entregada' : 'Por reclamar en la barra'}`
            : '—';
```

Repetir el script. Esperado: `{"pendiente":"1 shot gratis · Por reclamar en la barra","entregada":"1 shot gratis · Entregada","sin":null}`.

- [ ] **Paso 5: Commit**

```bash
git add public/index.html public/ticket.html
git commit -F - <<'EOF'
feat: promise the early-bird courtesy on the home page and ticket

La portada muestra la cortesia vigente en el destacado, las tarjetas y el
modal. El final de la compra la confirma solo si la entrada realmente la
gano, y la pagina del ticket dice si esta por reclamar o ya se entrego.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Tarea 9: Verificación final, despliegue y prueba real

**Archivos:** ninguno nuevo (se suben los commits de las Tareas 1 a 8 y la spec y el plan).

- [ ] **Paso 1: Suite y diff**

Run: `npm test` → todo en verde. `git log --oneline origin/main..HEAD` y `git diff origin/main --stat`: solo los archivos del plan, más `docs/superpowers/specs/2026-09-16-cortesias-preventa-design.md` y este plan (agregarlos con su propio commit `docs: add the early-bird courtesy design and plan`).

- [ ] **Paso 2: Pedir el visto bueno**

Preguntar al usuario: «¿Hago el push?». **No seguir sin un «sí».**

- [ ] **Paso 3: Push y espera del despliegue**

```bash
git push origin main
```

En segundo plano, esperar el estado del commit en GitHub:

```bash
sha=$(git rev-parse HEAD)
for i in $(seq 1 40); do
  estado=$(gh api repos/mathaisbarrantes-beep/whineup-evento/commits/$sha/status --jq '.statuses[] | select(.context | endswith("whineup-evento")) | .state' 2>/dev/null)
  case "$estado" in
    failure|error) echo "DESPLIEGUE FALLIDO: $estado"; exit 1;;
    success) echo "DESPLEGADO (intento $i)"; exit 0;;
  esac
  sleep 15
done
echo "TIMEOUT"; exit 1
```

- [ ] **Paso 4: Comprobar en producción**

```bash
B=https://whineup-evento.vercel.app
curl -s $B/api/eventos | grep -o '"cortesia":[^,]*'
curl -s $B/scanner | grep -c 'modoCortesia'
curl -s -o /dev/null -w "canjear sin sesion -> %{http_code}\n" -X POST -H 'Content-Type: application/json' -d '{"ticketId":"x"}' $B/api/canjear-cortesia
curl -s $B/api/salud
```

Esperado: `"cortesia":null` (hasta que se configure), `modoCortesia` presente, `401`, y salud con `supabase: true`.

- [ ] **Paso 5: Prueba real del usuario**

Pedirle al usuario:
1. En el panel, configurar HALLOWEEN PARTY con «1 shot gratis» válido hasta el 21/09 a las 23:59.
2. Generar una invitación a su propio correo: el aviso debe decir `invitación(es)`, y el correo debe traer la frase de la cortesía.
3. En `/scanner`, modo Entrada: «Adelante» con «Trae cortesía: 1 shot gratis».
4. Cambiar a modo Cortesía y escanear el mismo QR: «Entregar»; otra vez: «Ya se entregó».

Luego verificar en la base con `mcp__supabase-whineup__execute_sql`:

```sql
select left(e.id::text, 8) as id, e.cortesia, e.estado, e.cortesia_entregada_en is not null as entregada
from public.entradas as e
where e.cortesia is not null
order by e.creado_en desc
limit 5;
```

y que la portada muestre la línea de la cortesía.

- [ ] **Paso 6: Memoria**

Actualizar `estado-y-pendientes-whineup.md` en la memoria del proyecto: la cortesía de preventa quedó en producción, cómo se usa (modo Cortesía en `/scanner`, configuración en el evento) y lo que quedó pendiente.
