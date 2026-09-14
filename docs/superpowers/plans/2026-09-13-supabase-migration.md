# Migración de WhineUp a Supabase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Firestore + the hand-rolled staff login with Supabase (Postgres + Auth), so all ticket/event data lives in Supabase, staff/admin login goes through Supabase Auth with roles, buyers log in with Google, and a scanned QR can never be reused — all with code that runs today (routes answer `503` where DB-backed) and lights up the moment `SUPABASE_URL`/keys are set.

**Architecture:** `server.js` stays the only writer to the database, using the Supabase **service role key**. Three new `lib/*.js` modules isolate Supabase concerns (client init, auth/role verification, eventos queries, entradas queries) so `server.js` stays a thin router. The browser only talks to Supabase directly for login (Google OAuth for buyers, email/password for staff via `supabase-js` with the **anon key**, fetched from a new `GET /api/config` endpoint); every other request goes to `server.js` with `Authorization: Bearer <token>`.

**Tech Stack:** Node.js, Express (existing), `@supabase/supabase-js` (new), `node:test` + `node:assert` (Node's built-in test runner, no new dependency), `supertest` (new, dev-only) for the HTTP-level tests in Task 7.

**Spec:** `docs/superpowers/specs/2026-09-13-supabase-migration-design.md`

## Global Constraints

- Server is the only component that writes to Postgres, always via the service role key — RLS from the spec does not filter server queries, so every query in `lib/*.js` must filter explicitly (e.g. `eq('activo', true)` for public event listings).
- No in-memory fallback: if Supabase isn't configured, DB-backed routes return `503` with `{ ok: false, mensaje: "El servicio no está disponible en este momento." }` — never silently degrade like the current `MEMORY_TICKETS` map.
- Field names returned to the frontend/emails stay **camelCase**, matching what `public/*.html` already reads (`ticket.evento`, `ticket.tipoEntrada`, `ticket.referenciaPago`, `ticket.generadoPor`, `ticket.metodoPago`, `evento.categoria`, etc.) — `lib/entradas.js` and `lib/eventos.js` map Postgres's `snake_case` columns to this shape so the existing frontend rendering code does not need to change.
- Spanish user-facing error messages, `try/catch` per route, `console.error` for technical detail — matches the existing pattern in `server.js`.

---

### Task 1: SQL schema file

**Files:**
- Create: `supabase/schema.sql`

**Interfaces:**
- Produces: the `perfiles`, `eventos`, `entradas` tables, RLS policies, and the `validar_entrada(uuid)` function that every later task's `lib/*.js` code calls by name (`.from('perfiles')`, `.from('eventos')`, `.from('entradas')`, `.rpc('validar_entrada', ...)`).

This file can't be executed until the Supabase project exists (no automated test here — it's verified manually per the spec's "Plan de pruebas" once the project is live). Copy it verbatim from the spec so there is exactly one source of truth going forward (this file, not the spec, is what gets pasted into Supabase).

- [ ] **Step 1: Create the file**

Copy the full SQL block from `docs/superpowers/specs/2026-09-13-supabase-migration-design.md` (the section titled "## SQL completo", the ```sql ... ``` block) verbatim into `supabase/schema.sql`.

- [ ] **Step 2: Commit**

```bash
git add supabase/schema.sql
git commit -m "feat: add Supabase schema (perfiles, eventos, entradas, RLS, validar_entrada)"
```

---

### Task 2: Swap dependencies

**Files:**
- Modify: `package.json`

**Interfaces:**
- Produces: `@supabase/supabase-js` available to `require()` in `lib/*.js` and `server.js`; `npm test` runs Node's built-in test runner.

- [ ] **Step 1: Edit `package.json`**

Remove the `"firebase-admin": "^12.7.0"` line from `dependencies`. Add:

```json
"@supabase/supabase-js": "^2.45.0"
```

Add a `"scripts"` entry and a `devDependencies` block:

```json
"scripts": {
  "start": "node server.js",
  "dev": "node --watch server.js",
  "test": "node --test"
},
"devDependencies": {
  "supertest": "^7.0.0"
}
```

- [ ] **Step 2: Install**

Run: `npm install`
Expected: `firebase-admin` removed from `node_modules`, `@supabase/supabase-js` and `supertest` installed, `package-lock.json` updated.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: replace firebase-admin with @supabase/supabase-js, add test tooling"
```

---

### Task 3: `lib/supabaseClient.js`

**Files:**
- Create: `lib/supabaseClient.js`
- Test: `tests/lib/supabaseClient.test.js`

**Interfaces:**
- Consumes: `@supabase/supabase-js`'s `createClient(url, key, options)`.
- Produces: `buildSupabaseClient(env = process.env)` → `{ supabase: SupabaseClient | null, supabaseConfigured: boolean }`. Every other `lib/*.js` module and `server.js` call this once at startup and pass the result into their own factory functions.

- [ ] **Step 1: Write the failing tests**

```javascript
// tests/lib/supabaseClient.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSupabaseClient } = require('../../lib/supabaseClient');

test('returns supabaseConfigured=false when env vars are missing', () => {
  const result = buildSupabaseClient({});
  assert.equal(result.supabaseConfigured, false);
  assert.equal(result.supabase, null);
});

test('returns supabaseConfigured=false when only one var is set', () => {
  const result = buildSupabaseClient({ SUPABASE_URL: 'https://x.supabase.co' });
  assert.equal(result.supabaseConfigured, false);
  assert.equal(result.supabase, null);
});

test('returns a configured client when both vars are set', () => {
  const result = buildSupabaseClient({
    SUPABASE_URL: 'https://x.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role-key'
  });
  assert.equal(result.supabaseConfigured, true);
  assert.ok(result.supabase);
  assert.equal(typeof result.supabase.from, 'function');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/lib/supabaseClient.test.js`
Expected: FAIL — `Cannot find module '../../lib/supabaseClient'`

- [ ] **Step 3: Write the implementation**

```javascript
// lib/supabaseClient.js
const { createClient } = require('@supabase/supabase-js');

function buildSupabaseClient(env = process.env) {
  const url = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    return { supabase: null, supabaseConfigured: false };
  }

  const supabase = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  return { supabase, supabaseConfigured: true };
}

module.exports = { buildSupabaseClient };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/lib/supabaseClient.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/supabaseClient.js tests/lib/supabaseClient.test.js
git commit -m "feat: add Supabase client builder with config detection"
```

---

### Task 4: `lib/auth.js`

**Files:**
- Create: `lib/auth.js`
- Test: `tests/lib/auth.test.js`

**Interfaces:**
- Consumes: `{ supabase, supabaseConfigured }` from `lib/supabaseClient.js` (Task 3). Expects `supabase.auth.getUser(token)` → `{ data: { user: { id, email } }, error }` and `supabase.from('perfiles').select('rol, nombre').eq('id', id).single()` → `{ data: { rol, nombre }, error }`.
- Produces: `createAuthMiddleware({ supabase, supabaseConfigured })` → `{ requireRole(...roles), getUserAndRole(token) }`. `requireRole()` (no args) means "any authenticated user, any role." On success it sets `req.usuario = { id, email, rol, nombre }` and calls `next()`. `server.js` (Task 7) imports this.

- [ ] **Step 1: Write the failing tests**

```javascript
// tests/lib/auth.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAuthMiddleware } = require('../../lib/auth');

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
}

function fakeSupabase({ getUserResult, perfilResult }) {
  return {
    auth: {
      getUser: async () => getUserResult
    },
    from(table) {
      assert.equal(table, 'perfiles');
      return {
        select() {
          return {
            eq() {
              return {
                single: async () => perfilResult
              };
            }
          };
        }
      };
    }
  };
}

test('rejects with 401 when there is no Authorization header', async () => {
  const { requireRole } = createAuthMiddleware({ supabase: null, supabaseConfigured: false });
  const req = { headers: {} };
  const res = fakeRes();
  let nextCalled = false;
  await requireRole()(req, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test('rejects with 503 when Supabase is not configured', async () => {
  const { requireRole } = createAuthMiddleware({ supabase: null, supabaseConfigured: false });
  const req = { headers: { authorization: 'Bearer abc' } };
  const res = fakeRes();
  await requireRole()(req, res, () => {});
  assert.equal(res.statusCode, 503);
});

test('rejects with 401 when the token is invalid', async () => {
  const supabase = fakeSupabase({ getUserResult: { data: null, error: new Error('bad token') }, perfilResult: { data: null } });
  const { requireRole } = createAuthMiddleware({ supabase, supabaseConfigured: true });
  const req = { headers: { authorization: 'Bearer abc' } };
  const res = fakeRes();
  await requireRole()(req, res, () => {});
  assert.equal(res.statusCode, 401);
});

test('rejects with 403 when the role is not allowed', async () => {
  const supabase = fakeSupabase({
    getUserResult: { data: { user: { id: 'u1', email: 'a@b.com' } }, error: null },
    perfilResult: { data: { rol: 'cliente', nombre: 'Ana' } }
  });
  const { requireRole } = createAuthMiddleware({ supabase, supabaseConfigured: true });
  const req = { headers: { authorization: 'Bearer abc' } };
  const res = fakeRes();
  await requireRole('admin', 'staff')(req, res, () => {});
  assert.equal(res.statusCode, 403);
});

test('calls next() and sets req.usuario when the role is allowed', async () => {
  const supabase = fakeSupabase({
    getUserResult: { data: { user: { id: 'u1', email: 'a@b.com' } }, error: null },
    perfilResult: { data: { rol: 'admin', nombre: 'Ana' } }
  });
  const { requireRole } = createAuthMiddleware({ supabase, supabaseConfigured: true });
  const req = { headers: { authorization: 'Bearer abc' } };
  const res = fakeRes();
  let nextCalled = false;
  await requireRole('admin')(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.deepEqual(req.usuario, { id: 'u1', email: 'a@b.com', rol: 'admin', nombre: 'Ana' });
});

test('requireRole() with no arguments allows any known role', async () => {
  const supabase = fakeSupabase({
    getUserResult: { data: { user: { id: 'u2', email: 'c@d.com' } }, error: null },
    perfilResult: { data: { rol: 'cliente', nombre: 'Beto' } }
  });
  const { requireRole } = createAuthMiddleware({ supabase, supabaseConfigured: true });
  const req = { headers: { authorization: 'Bearer abc' } };
  const res = fakeRes();
  let nextCalled = false;
  await requireRole()(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/lib/auth.test.js`
Expected: FAIL — `Cannot find module '../../lib/auth'`

- [ ] **Step 3: Write the implementation**

```javascript
// lib/auth.js
function createAuthMiddleware({ supabase, supabaseConfigured }) {
  function extractToken(req) {
    const header = req.headers.authorization || '';
    return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  }

  async function getUserAndRole(token) {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return null;

    const { data: perfil } = await supabase
      .from('perfiles')
      .select('rol, nombre')
      .eq('id', data.user.id)
      .single();

    return {
      id: data.user.id,
      email: data.user.email,
      rol: perfil?.rol || 'cliente',
      nombre: perfil?.nombre || null
    };
  }

  function requireRole(...roles) {
    return async (req, res, next) => {
      const token = extractToken(req);
      if (!token) {
        return res.status(401).json({ ok: false, mensaje: 'No autorizado.' });
      }

      if (!supabaseConfigured) {
        return res.status(503).json({ ok: false, mensaje: 'El servicio no está disponible en este momento.' });
      }

      const usuario = await getUserAndRole(token);
      if (!usuario) {
        return res.status(401).json({ ok: false, mensaje: 'Sesión expirada, inicia sesión de nuevo.' });
      }

      if (roles.length && !roles.includes(usuario.rol)) {
        return res.status(403).json({ ok: false, mensaje: 'No tienes permiso para esta acción.' });
      }

      req.usuario = usuario;
      return next();
    };
  }

  return { requireRole, getUserAndRole };
}

module.exports = { createAuthMiddleware };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/lib/auth.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/auth.js tests/lib/auth.test.js
git commit -m "feat: add Supabase-backed role middleware"
```

---

### Task 5: `lib/eventos.js`

**Files:**
- Create: `lib/eventos.js`
- Test: `tests/lib/eventos.test.js`

**Interfaces:**
- Consumes: `{ supabase, supabaseConfigured }` from Task 3.
- Produces: `createEventosRepo({ supabase, supabaseConfigured })` → `{ NO_CONFIGURADO, listarPublicos(), listarTodos(), obtenerPorId(id), crear(datos), actualizar(id, cambios), desactivar(id) }`. Each returns/resolves an event shaped `{ id, nombre, fecha, lugar, precio, categoria, descripcion, cupoMaximo, activo }` (or an array of those). `server.js` (Task 7) and `lib/entradas.js` (Task 6, for the event-name join) both import this.

Only the "not configured" path is unit-tested here (network-independent). The actual query behavior against a live project is covered by the spec's manual test plan, step 1 and 6.

- [ ] **Step 1: Write the failing tests**

```javascript
// tests/lib/eventos.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEventosRepo } = require('../../lib/eventos');

test('listarPublicos rejects with NO_CONFIGURADO when Supabase is not configured', async () => {
  const repo = createEventosRepo({ supabase: null, supabaseConfigured: false });
  await assert.rejects(() => repo.listarPublicos(), (err) => err === repo.NO_CONFIGURADO);
});

test('crear rejects with NO_CONFIGURADO when Supabase is not configured', async () => {
  const repo = createEventosRepo({ supabase: null, supabaseConfigured: false });
  await assert.rejects(() => repo.crear({ nombre: 'Test' }), (err) => err === repo.NO_CONFIGURADO);
});

test('mapEventoRow maps snake_case columns to the camelCase shape the frontend expects', () => {
  const { mapEventoRow } = require('../../lib/eventos');
  const row = {
    id: 'e1', nombre: 'HALLOWEEN PARTY', fecha: '2026-10-31', lugar: 'WhineUp CR',
    precio: 45000, categoria: 'General', descripcion: 'desc', cupo_maximo: null, activo: true
  };
  assert.deepEqual(mapEventoRow(row), {
    id: 'e1', nombre: 'HALLOWEEN PARTY', fecha: '2026-10-31', lugar: 'WhineUp CR',
    precio: 45000, categoria: 'General', descripcion: 'desc', cupoMaximo: null, activo: true
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/lib/eventos.test.js`
Expected: FAIL — `Cannot find module '../../lib/eventos'`

- [ ] **Step 3: Write the implementation**

```javascript
// lib/eventos.js
const NO_CONFIGURADO = { error: 'NO_CONFIGURADO' };

function mapEventoRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    nombre: row.nombre,
    fecha: row.fecha,
    lugar: row.lugar,
    precio: row.precio,
    categoria: row.categoria,
    descripcion: row.descripcion,
    cupoMaximo: row.cupo_maximo,
    activo: row.activo
  };
}

function createEventosRepo({ supabase, supabaseConfigured }) {
  function assertConfigured() {
    if (!supabaseConfigured) throw NO_CONFIGURADO;
  }

  async function listarPublicos() {
    assertConfigured();
    const { data, error } = await supabase
      .from('eventos').select('*').eq('activo', true).order('fecha', { ascending: true });
    if (error) throw error;
    return (data || []).map(mapEventoRow);
  }

  async function listarTodos() {
    assertConfigured();
    const { data, error } = await supabase
      .from('eventos').select('*').order('fecha', { ascending: true });
    if (error) throw error;
    return (data || []).map(mapEventoRow);
  }

  async function obtenerPorId(id) {
    assertConfigured();
    const { data, error } = await supabase.from('eventos').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return mapEventoRow(data);
  }

  async function crear(datos) {
    assertConfigured();
    const { data, error } = await supabase.from('eventos').insert(datos).select().single();
    if (error) throw error;
    return mapEventoRow(data);
  }

  async function actualizar(id, cambios) {
    assertConfigured();
    const { data, error } = await supabase.from('eventos').update(cambios).eq('id', id).select().single();
    if (error) throw error;
    return mapEventoRow(data);
  }

  async function desactivar(id) {
    return actualizar(id, { activo: false });
  }

  return { NO_CONFIGURADO, listarPublicos, listarTodos, obtenerPorId, crear, actualizar, desactivar };
}

module.exports = { createEventosRepo, mapEventoRow, NO_CONFIGURADO };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/lib/eventos.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/eventos.js tests/lib/eventos.test.js
git commit -m "feat: add eventos repository backed by Supabase"
```

---

### Task 6: `lib/entradas.js`

**Files:**
- Create: `lib/entradas.js`
- Test: `tests/lib/entradas.test.js`

**Interfaces:**
- Consumes: `{ supabase, supabaseConfigured }` from Task 3.
- Produces: `createEntradasRepo({ supabase, supabaseConfigured })` → `{ NO_CONFIGURADO, crear(datos), obtenerPorId(id), confirmarPago(id, staffId), pagosPendientes(), generadas(), misEntradas(usuarioId), crearGenerada(datos), validar(id), contarTotal() }`. Rows are mapped to `{ id, eventoId, evento, usuarioId, nombre, correo, telefono, tipoEntrada, precio, metodoPago, referenciaPago, pagado, estado, pagoConfirmadoPor, pagoConfirmadoEn, ingresadoEn, generadoPor, creadoEn }` — exactly the shape `public/scanner-dashboard.html` and `public/ticket.html` already read. `validar(id)` returns `{ permitido, mensaje, nombre, evento, tipoEntrada }`. `contarTotal()` returns a plain `number` (the true row count, not capped at 200 like `generadas()`). `server.js` (Task 7) imports this.

- [ ] **Step 1: Write the failing tests**

```javascript
// tests/lib/entradas.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEntradasRepo, mapEntradaRow } = require('../../lib/entradas');

test('crear rejects with NO_CONFIGURADO when Supabase is not configured', async () => {
  const repo = createEntradasRepo({ supabase: null, supabaseConfigured: false });
  await assert.rejects(() => repo.crear({ nombre: 'Test' }), (err) => err === repo.NO_CONFIGURADO);
});

test('validar rejects with NO_CONFIGURADO when Supabase is not configured', async () => {
  const repo = createEntradasRepo({ supabase: null, supabaseConfigured: false });
  await assert.rejects(() => repo.validar('t1'), (err) => err === repo.NO_CONFIGURADO);
});

test('contarTotal rejects with NO_CONFIGURADO when Supabase is not configured', async () => {
  const repo = createEntradasRepo({ supabase: null, supabaseConfigured: false });
  await assert.rejects(() => repo.contarTotal(), (err) => err === repo.NO_CONFIGURADO);
});

test('contarTotal returns the count from Supabase, not a row array', async () => {
  const supabase = {
    from(table) {
      assert.equal(table, 'entradas');
      return {
        select(columns, options) {
          assert.deepEqual(options, { count: 'exact', head: true });
          return Promise.resolve({ count: 257, error: null });
        }
      };
    }
  };
  const repo = createEntradasRepo({ supabase, supabaseConfigured: true });
  const total = await repo.contarTotal();
  assert.equal(total, 257);
});

test('mapEntradaRow maps snake_case columns and the joined event name to the existing frontend shape', () => {
  const row = {
    id: 't1', evento_id: 'e1', usuario_id: 'u1', nombre: 'Ana', correo: 'ana@x.com',
    telefono: '8888-0000', tipo_entrada: 'General', precio: 45000, metodo_pago: 'paypal',
    referencia_pago: 'REF123', pagado: true, estado: 'PENDIENTE', pago_confirmado_por: 'staff1',
    pago_confirmado_en: '2026-01-01T00:00:00Z', ingresado_en: null, generado_por: null,
    creado_en: '2026-01-01T00:00:00Z', eventos: { nombre: 'HALLOWEEN PARTY' }
  };
  assert.deepEqual(mapEntradaRow(row), {
    id: 't1', eventoId: 'e1', evento: 'HALLOWEEN PARTY', usuarioId: 'u1', nombre: 'Ana',
    correo: 'ana@x.com', telefono: '8888-0000', tipoEntrada: 'General', precio: 45000,
    metodoPago: 'paypal', referenciaPago: 'REF123', pagado: true, estado: 'PENDIENTE',
    pagoConfirmadoPor: 'staff1', pagoConfirmadoEn: '2026-01-01T00:00:00Z', ingresadoEn: null,
    generadoPor: null, creadoEn: '2026-01-01T00:00:00Z'
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/lib/entradas.test.js`
Expected: FAIL — `Cannot find module '../../lib/entradas'`

- [ ] **Step 3: Write the implementation**

```javascript
// lib/entradas.js
const NO_CONFIGURADO = { error: 'NO_CONFIGURADO' };
const SELECT_CON_EVENTO = '*, eventos(nombre)';

function mapEntradaRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    eventoId: row.evento_id,
    evento: row.eventos ? row.eventos.nombre : null,
    usuarioId: row.usuario_id,
    nombre: row.nombre,
    correo: row.correo,
    telefono: row.telefono,
    tipoEntrada: row.tipo_entrada,
    precio: row.precio,
    metodoPago: row.metodo_pago,
    referenciaPago: row.referencia_pago,
    pagado: row.pagado,
    estado: row.estado,
    pagoConfirmadoPor: row.pago_confirmado_por,
    pagoConfirmadoEn: row.pago_confirmado_en,
    ingresadoEn: row.ingresado_en,
    generadoPor: row.generado_por,
    creadoEn: row.creado_en
  };
}

function createEntradasRepo({ supabase, supabaseConfigured }) {
  function assertConfigured() {
    if (!supabaseConfigured) throw NO_CONFIGURADO;
  }

  async function crear(datos) {
    assertConfigured();
    const { data, error } = await supabase.from('entradas').insert(datos).select(SELECT_CON_EVENTO).single();
    if (error) throw error;
    return mapEntradaRow(data);
  }

  async function obtenerPorId(id) {
    assertConfigured();
    const { data, error } = await supabase.from('entradas').select(SELECT_CON_EVENTO).eq('id', id).maybeSingle();
    if (error) throw error;
    return mapEntradaRow(data);
  }

  async function confirmarPago(id, staffId) {
    assertConfigured();
    const { data, error } = await supabase
      .from('entradas')
      .update({
        pagado: true,
        estado: 'PENDIENTE',
        pago_confirmado_por: staffId,
        pago_confirmado_en: new Date().toISOString()
      })
      .eq('id', id)
      .select(SELECT_CON_EVENTO)
      .single();
    if (error) throw error;
    return mapEntradaRow(data);
  }

  async function pagosPendientes() {
    assertConfigured();
    const { data, error } = await supabase
      .from('entradas').select(SELECT_CON_EVENTO).eq('estado', 'PENDIENTE_PAGO')
      .order('creado_en', { ascending: false }).limit(100);
    if (error) throw error;
    return (data || []).map(mapEntradaRow);
  }

  async function generadas() {
    assertConfigured();
    const { data, error } = await supabase
      .from('entradas').select(SELECT_CON_EVENTO)
      .order('creado_en', { ascending: false }).limit(200);
    if (error) throw error;
    return (data || []).map(mapEntradaRow);
  }

  async function misEntradas(usuarioId) {
    assertConfigured();
    const { data, error } = await supabase
      .from('entradas').select(SELECT_CON_EVENTO).eq('usuario_id', usuarioId)
      .order('creado_en', { ascending: false });
    if (error) throw error;
    return (data || []).map(mapEntradaRow);
  }

  async function crearGenerada(datos) {
    return crear(datos);
  }

  async function validar(id) {
    assertConfigured();
    const { data, error } = await supabase.rpc('validar_entrada', { p_entrada_id: id });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      return { permitido: false, mensaje: 'Ticket no encontrado.', nombre: null, evento: null, tipoEntrada: null };
    }
    return {
      permitido: row.permitido,
      mensaje: row.mensaje,
      nombre: row.nombre,
      evento: row.evento,
      tipoEntrada: row.tipo_entrada
    };
  }

  async function contarTotal() {
    assertConfigured();
    const { count, error } = await supabase.from('entradas').select('id', { count: 'exact', head: true });
    if (error) throw error;
    return count || 0;
  }

  return {
    NO_CONFIGURADO, crear, obtenerPorId, confirmarPago, pagosPendientes,
    generadas, misEntradas, crearGenerada, validar, contarTotal
  };
}

module.exports = { createEntradasRepo, mapEntradaRow, NO_CONFIGURADO };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/lib/entradas.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/entradas.js tests/lib/entradas.test.js
git commit -m "feat: add entradas repository backed by Supabase"
```

---

### Task 7: Rewrite `server.js`

**Files:**
- Modify: `server.js` (full rewrite of the sections listed below; the QR/email logic is unchanged)
- Modify: `.env.example`
- Test: `tests/server.test.js`

**Interfaces:**
- Consumes: `buildSupabaseClient` (Task 3), `createAuthMiddleware` (Task 4), `createEventosRepo` (Task 5), `createEntradasRepo` (Task 6).
- Produces: the HTTP API other tasks (10, 11, 12) call: `GET /api/config`, `GET /api/eventos`, `POST/PUT/DELETE /api/admin/eventos[/:id]`, `GET /api/session-status`, `POST /api/crear-ticket`, `GET /api/mis-entradas`, `POST /api/admin/confirmar-pago/:id`, `GET /api/admin/pagos-pendientes`, `GET /api/admin/entradas`, `POST /api/admin/crear-qr`, `GET /api/ticket/:id`, `POST /api/validar-ticket`.

This is the biggest single change. Do it in one pass since the routes share the new middleware and repos; the tests only cover what's testable without a live Supabase project (per Global Constraints: the `503`-when-unconfigured behavior, and auth gating that never needs to reach Supabase because the token is missing).

- [ ] **Step 1: Write the failing tests**

```javascript
// tests/server.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

// No SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY set in this process's env,
// so the app under test boots in the unconfigured state.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
const app = require('../server');

test('GET /api/salud reports supabase: false when unconfigured', async () => {
  const res = await request(app).get('/api/salud');
  assert.equal(res.status, 200);
  assert.equal(res.body.supabase, false);
});

test('GET /api/eventos returns 503 when unconfigured', async () => {
  const res = await request(app).get('/api/eventos');
  assert.equal(res.status, 503);
  assert.equal(res.body.ok, false);
});

test('GET /api/admin/entradas returns 401 without a token', async () => {
  const res = await request(app).get('/api/admin/entradas');
  assert.equal(res.status, 401);
});

test('POST /api/validar-ticket returns 401 without a token', async () => {
  const res = await request(app).post('/api/validar-ticket').send({ ticketId: 'x' });
  assert.equal(res.status, 401);
});

test('GET /api/admin/entradas returns 503 with a token when unconfigured', async () => {
  const res = await request(app).get('/api/admin/entradas').set('Authorization', 'Bearer fake');
  assert.equal(res.status, 503);
});

test('GET / serves the landing page', async () => {
  const res = await request(app).get('/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /html/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/server.test.js`
Expected: FAIL — routes still require `/api/login` cookie flow, `/api/validar-ticket` has no auth gate yet, response shapes don't match.

- [ ] **Step 3: Rewrite `server.js`**

Replace the entire file with:

```javascript
require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const QRCode = require("qrcode");
const nodemailer = require("nodemailer");
const { buildSupabaseClient } = require("./lib/supabaseClient");
const { createAuthMiddleware } = require("./lib/auth");
const { createEventosRepo } = require("./lib/eventos");
const { createEntradasRepo } = require("./lib/entradas");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const IS_PRODUCTION = process.env.NODE_ENV === "production";

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  if (IS_PRODUCTION) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

function correoValido(correo) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo);
}

const { supabase, supabaseConfigured } = buildSupabaseClient();
const { requireRole, getUserAndRole } = createAuthMiddleware({ supabase, supabaseConfigured });
const eventosRepo = createEventosRepo({ supabase, supabaseConfigured });
const entradasRepo = createEntradasRepo({ supabase, supabaseConfigured });

function requireSupabase(req, res, next) {
  if (!supabaseConfigured) {
    return res.status(503).json({ ok: false, mensaje: "El servicio no está disponible en este momento." });
  }
  return next();
}

const mailConfigured = Boolean(
  process.env.SMTP_HOST &&
  process.env.SMTP_USER &&
  process.env.SMTP_PASSWORD
);

const transporter = mailConfigured ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD
  }
}) : null;

async function createTicketQr(ticketId) {
  return QRCode.toBuffer(ticketId, {
    type: "png",
    width: 500,
    margin: 2,
    errorCorrectionLevel: "H"
  });
}

async function enviarCorreoTicket({ to, subject, text, html, qrBuffer, ticketId }) {
  if (!transporter) return;
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      text,
      html,
      attachments: [{
        filename: `ticket-${ticketId}.png`,
        content: qrBuffer,
        contentType: "image/png"
      }]
    });
  } catch (emailError) {
    console.warn("No se pudo enviar el correo del ticket:", emailError.message);
  }
}

app.get("/api/config", (req, res) => {
  res.json({
    ok: true,
    supabaseUrl: process.env.SUPABASE_URL || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null
  });
});

app.get("/api/salud", (req, res) => {
  res.json({
    ok: true,
    mensaje: "Servidor funcionando correctamente.",
    supabase: Boolean(supabaseConfigured),
    smtp: Boolean(transporter)
  });
});

app.get("/api/eventos", requireSupabase, async (req, res) => {
  try {
    const eventos = await eventosRepo.listarPublicos();
    res.json({ ok: true, eventos });
  } catch (error) {
    console.error("Error al consultar eventos:", error);
    res.status(500).json({ ok: false, mensaje: "No se pudieron consultar los eventos." });
  }
});

app.get("/api/estadisticas-publicas", requireSupabase, async (req, res) => {
  try {
    const entradas = await entradasRepo.contarTotal();
    res.json({ ok: true, entradas });
  } catch (error) {
    console.error("Error al consultar estadísticas públicas:", error);
    res.json({ ok: true, entradas: 0 });
  }
});

app.get("/api/session-status", async (req, res) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || !supabaseConfigured) {
    return res.json({ ok: true, authenticated: false });
  }

  const usuario = await getUserAndRole(token);
  if (!usuario) {
    return res.json({ ok: true, authenticated: false });
  }

  return res.json({
    ok: true,
    authenticated: true,
    user: { username: usuario.email, role: usuario.rol, name: usuario.nombre || usuario.email }
  });
});

app.post("/api/admin/eventos", requireRole("admin"), async (req, res) => {
  try {
    const evento = await eventosRepo.crear({
      nombre: String(req.body.nombre || "").trim(),
      fecha: req.body.fecha,
      lugar: String(req.body.lugar || "").trim(),
      precio: Number(req.body.precio || 0),
      categoria: String(req.body.categoria || "General").trim(),
      descripcion: String(req.body.descripcion || "").trim(),
      cupo_maximo: req.body.cupoMaximo ? Number(req.body.cupoMaximo) : null,
      creado_por: req.usuario.id
    });
    res.status(201).json({ ok: true, evento });
  } catch (error) {
    console.error("Error al crear evento:", error);
    res.status(500).json({ ok: false, mensaje: "No se pudo crear el evento." });
  }
});

app.put("/api/admin/eventos/:id", requireRole("admin"), async (req, res) => {
  try {
    const cambios = {};
    if (req.body.nombre !== undefined) cambios.nombre = String(req.body.nombre).trim();
    if (req.body.fecha !== undefined) cambios.fecha = req.body.fecha;
    if (req.body.lugar !== undefined) cambios.lugar = String(req.body.lugar).trim();
    if (req.body.precio !== undefined) cambios.precio = Number(req.body.precio);
    if (req.body.categoria !== undefined) cambios.categoria = String(req.body.categoria).trim();
    if (req.body.descripcion !== undefined) cambios.descripcion = String(req.body.descripcion).trim();
    if (req.body.cupoMaximo !== undefined) cambios.cupo_maximo = req.body.cupoMaximo ? Number(req.body.cupoMaximo) : null;
    if (req.body.activo !== undefined) cambios.activo = Boolean(req.body.activo);

    const evento = await eventosRepo.actualizar(req.params.id, cambios);
    res.json({ ok: true, evento });
  } catch (error) {
    console.error("Error al actualizar evento:", error);
    res.status(500).json({ ok: false, mensaje: "No se pudo actualizar el evento." });
  }
});

app.delete("/api/admin/eventos/:id", requireRole("admin"), async (req, res) => {
  try {
    const evento = await eventosRepo.desactivar(req.params.id);
    res.json({ ok: true, evento });
  } catch (error) {
    console.error("Error al desactivar evento:", error);
    res.status(500).json({ ok: false, mensaje: "No se pudo desactivar el evento." });
  }
});

app.post("/api/crear-ticket", requireRole(), async (req, res) => {
  try {
    const nombre = String(req.body.nombre || "").trim();
    const correo = String(req.body.correo || "").trim().toLowerCase();
    const telefono = String(req.body.telefono || "").trim();
    const eventoId = String(req.body.eventoId || "").trim();
    const tipoEntrada = String(req.body.tipoEntrada || "General").trim();
    const paymentMethod = String(req.body.paymentMethod || "").trim().toLowerCase();
    const paymentReference = String(req.body.paymentReference || "").trim();

    if (!nombre || !correo || !telefono || !correoValido(correo) || !eventoId) {
      return res.status(400).json({ ok: false, mensaje: "Completa los datos y selecciona un evento válido." });
    }

    const evento = await eventosRepo.obtenerPorId(eventoId);
    if (!evento) {
      return res.status(400).json({ ok: false, mensaje: "Completa los datos y selecciona un evento válido." });
    }

    if (!paymentMethod || !["paypal", "numero"].includes(paymentMethod)) {
      return res.status(400).json({ ok: false, mensaje: "Selecciona un método de pago válido: PayPal o número de pago." });
    }

    if (!paymentReference) {
      return res.status(400).json({ ok: false, mensaje: "Debes incluir la referencia del pago para generar la entrada." });
    }

    const ticket = await entradasRepo.crear({
      usuario_id: req.usuario.id,
      evento_id: evento.id,
      nombre,
      correo,
      telefono,
      tipo_entrada: tipoEntrada,
      precio: evento.precio,
      metodo_pago: paymentMethod,
      referencia_pago: paymentReference,
      pagado: false,
      estado: "PENDIENTE_PAGO"
    });

    const qrBuffer = await createTicketQr(ticket.id);
    await enviarCorreoTicket({
      to: correo,
      subject: `Solicitud de pago para ${evento.nombre}`,
      text: `Hola ${nombre}. Recibimos tu referencia de pago para ${evento.nombre}. El QR se activará al confirmar el pago.`,
      html: `<h2>Solicitud de pago para ${evento.nombre}</h2><p>Hola ${nombre},</p><p>Recibimos tu referencia. El equipo confirmará el pago antes de activar el QR.</p><p><strong>ID del ticket:</strong> ${ticket.id}</p>`,
      qrBuffer,
      ticketId: ticket.id
    });

    res.status(201).json({
      ok: true,
      mensaje: "Solicitud recibida. El QR se activará cuando se confirme el pago.",
      ticket: { ...ticket, qrDataUrl: `data:image/png;base64,${qrBuffer.toString("base64")}` }
    });
  } catch (error) {
    console.error("Error al crear ticket:", error);
    res.status(500).json({ ok: false, mensaje: "No se pudo crear la entrada." });
  }
});

app.get("/api/mis-entradas", requireRole(), async (req, res) => {
  try {
    const entradas = await entradasRepo.misEntradas(req.usuario.id);
    res.json({ ok: true, entradas });
  } catch (error) {
    console.error("Error al consultar mis entradas:", error);
    res.status(500).json({ ok: false, mensaje: "No se pudieron consultar tus entradas." });
  }
});

app.post("/api/admin/confirmar-pago/:ticketId", requireRole("admin"), async (req, res) => {
  try {
    const ticket = await entradasRepo.obtenerPorId(req.params.ticketId);
    if (!ticket) {
      return res.status(404).json({ ok: false, mensaje: "Ticket no encontrado." });
    }
    if (ticket.pagado) {
      return res.json({ ok: true, mensaje: "El pago ya estaba confirmado.", ticket });
    }

    const updated = await entradasRepo.confirmarPago(req.params.ticketId, req.usuario.id);
    const qrBuffer = await createTicketQr(updated.id);
    await enviarCorreoTicket({
      to: updated.correo,
      subject: `Pago confirmado: tu entrada para ${updated.evento}`,
      text: `Hola ${updated.nombre}. Tu pago fue confirmado. Presenta el QR adjunto al ingresar al evento.`,
      html: `<h2>Pago confirmado</h2><p>Hola ${updated.nombre},</p><p>Tu entrada para <strong>${updated.evento}</strong> ya está activa.</p><p><strong>ID del ticket:</strong> ${updated.id}</p>`,
      qrBuffer,
      ticketId: updated.id
    });

    res.json({ ok: true, mensaje: "Pago confirmado y QR activado.", ticket: updated });
  } catch (error) {
    console.error("Error al confirmar pago:", error);
    res.status(500).json({ ok: false, mensaje: "No se pudo confirmar el pago." });
  }
});

app.get("/api/admin/pagos-pendientes", requireRole("admin"), async (req, res) => {
  try {
    const tickets = await entradasRepo.pagosPendientes();
    res.json({ ok: true, tickets });
  } catch (error) {
    console.error("Error al consultar pagos pendientes:", error);
    res.status(500).json({ ok: false, mensaje: "No se pudieron consultar los pagos pendientes." });
  }
});

app.get("/api/admin/entradas", requireRole("admin"), async (req, res) => {
  try {
    const tickets = await entradasRepo.generadas();
    res.json({ ok: true, tickets });
  } catch (error) {
    console.error("Error al consultar entradas:", error);
    res.status(500).json({ ok: false, mensaje: "No se pudieron consultar las entradas." });
  }
});

app.post("/api/admin/crear-qr", requireRole("admin", "staff"), async (req, res) => {
  try {
    const nombre = String(req.body.nombre || "Invitado").trim();
    const correo = String(req.body.correo || "").trim().toLowerCase();
    const eventoId = String(req.body.eventoId || "").trim();
    const tipoEntrada = String(req.body.tipoEntrada || "General").trim();
    const cantidad = Number(req.body.cantidad || 1);

    const evento = await eventosRepo.obtenerPorId(eventoId);
    if (!correoValido(correo) || !evento) {
      return res.status(400).json({ ok: false, mensaje: "Indica un correo y un evento válido." });
    }
    if (!["General", "VIP"].includes(tipoEntrada)) {
      return res.status(400).json({ ok: false, mensaje: "El tipo de entrada debe ser General o VIP." });
    }
    if (!Number.isFinite(cantidad) || cantidad < 1 || cantidad > 200) {
      return res.status(400).json({ ok: false, mensaje: "La cantidad debe estar entre 1 y 200." });
    }

    const generated = [];
    for (let i = 0; i < cantidad; i += 1) {
      const ticket = await entradasRepo.crearGenerada({
        evento_id: evento.id,
        nombre,
        correo,
        telefono: "ADMIN-FREE",
        tipo_entrada: tipoEntrada,
        precio: evento.precio,
        pagado: true,
        estado: "PENDIENTE",
        generado_por: req.usuario.id
      });

      const qrBuffer = await createTicketQr(ticket.id);
      await enviarCorreoTicket({
        to: correo,
        subject: `Tu entrada para ${evento.nombre}`,
        text: `Hola ${nombre}. El administrador generó una entrada ${tipoEntrada} para ${evento.nombre}.`,
        html: `<h2>Tu entrada</h2><p>Hola ${nombre},</p><p>Tu entrada <strong>${tipoEntrada}</strong> para <strong>${evento.nombre}</strong> está lista.</p><p><strong>ID del ticket:</strong> ${ticket.id}</p>`,
        qrBuffer,
        ticketId: ticket.id
      });

      generated.push({ ...ticket, qrDataUrl: `data:image/png;base64,${qrBuffer.toString("base64")}` });
    }

    res.status(201).json({
      ok: true,
      mensaje: `Se generaron ${generated.length} QR correctamente y se enviaron al correo indicado.`,
      tickets: generated
    });
  } catch (error) {
    console.error("Error al generar QR:", error);
    res.status(500).json({ ok: false, mensaje: "No se pudo generar el QR." });
  }
});

app.get("/api/ticket/:ticketId", requireSupabase, async (req, res) => {
  try {
    const ticket = await entradasRepo.obtenerPorId(req.params.ticketId);
    if (!ticket) {
      return res.status(404).json({ ok: false, mensaje: "Ticket no encontrado." });
    }
    res.json({ ok: true, ticket });
  } catch (error) {
    console.error("Error al consultar ticket:", error);
    res.status(500).json({ ok: false, mensaje: "No se pudo consultar el ticket." });
  }
});

app.post("/api/validar-ticket", requireRole("staff", "admin"), async (req, res) => {
  try {
    const ticketId = String(req.body.ticketId || "").trim();
    if (!ticketId) {
      return res.status(400).json({ ok: false, permitido: false, mensaje: "QR no válido." });
    }

    const resultado = await entradasRepo.validar(ticketId);
    res.status(resultado.permitido ? 200 : 403).json({ ok: true, ...resultado });
  } catch (error) {
    console.error("Error al validar ticket:", error);
    res.status(500).json({ ok: false, permitido: false, mensaje: "No se pudo validar el ticket." });
  }
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/scanner-dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "scanner-dashboard.html"));
});

app.get("/ticket", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "ticket.html"));
});

app.get("/escaner", (req, res) => {
  res.redirect("/scanner-dashboard");
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Servidor ejecutandose en http://localhost:${PORT}`);
    console.log(`Panel de staff: http://localhost:${PORT}/login`);
  });
}

module.exports = app;
```

Note: `/scanner-dashboard` is no longer gated server-side with `requireStaffAuth` (that was cookie-based). It now renders the shell for everyone and the page itself (Task 10) checks the Supabase session client-side and redirects to `/login` if absent — this matches the new Bearer-token model, where the server has no cookie to check on a plain page `GET`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/server.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Update `.env.example`**

Replace the Firebase block:

```
PORT=3000
NODE_ENV=production
PUBLIC_URL=https://tickets.tudominio.com

# Supabase (Postgres + Auth) para persistencia real.
SUPABASE_URL=https://tu-proyecto.supabase.co
SUPABASE_SERVICE_ROLE_KEY=tu-service-role-key
SUPABASE_ANON_KEY=tu-anon-key

# SMTP para enviar confirmaciones y tickets.
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=tu-correo@gmail.com
SMTP_PASSWORD=tu-contrasena-de-aplicacion
SMTP_FROM="WhineUp <tu-correo@gmail.com>"

# Número para pagos manuales.
PAYMENT_PHONE=+50600000000
# PAYPAL_CLIENT_ID=...
# PAYPAL_CLIENT_SECRET=...
# PAYPAL_WEBHOOK_ID=...
```

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS (all tests across Tasks 3-7)

- [ ] **Step 7: Commit**

```bash
git add server.js .env.example
git commit -m "feat: migrate server.js from Firestore/cookies to Supabase Auth + Postgres"
```

---

### Task 8: `public/index.html` — Google login + Bearer wiring

**Files:**
- Modify: `public/index.html:7` (add supabase-js script tag), `public/index.html:226-414` (script block)

**Interfaces:**
- Consumes: `GET /api/config` (Task 7) for `{ supabaseUrl, supabaseAnonKey }`; `POST /api/crear-ticket` (Task 7) now requires `Authorization: Bearer <token>`.

No visual redesign here — same Tailwind classes, same layout. This only adds a login gate in front of the existing checkout form and attaches the session token to the purchase request.

- [ ] **Step 1: Add the supabase-js script tag**

In the `<head>`, right after the Tailwind `<script>` tag on line 7:

```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
```

- [ ] **Step 2: Add a login gate above the checkout form**

Inside `<div class="rounded-[28px] border border-white/10 bg-white/5 p-5 backdrop-blur-xl sm:p-7">` (the checkout card, starting at line 143), right before `<form id="ticketForm" ...>` (line 147), add:

```html
<div id="authGate" class="mb-6 rounded-2xl border border-white/10 bg-[#121212]/80 p-4 text-sm text-slate-300">
  <p id="authStatus">Inicia sesión con Google para comprar tu entrada.</p>
  <button id="googleLoginButton" type="button" class="mt-3 w-full rounded-2xl border border-white/15 bg-white/5 px-4 py-3 font-semibold text-white transition hover:border-white/40">
    Iniciar sesión con Google
  </button>
</div>
```

Wrap the existing `<form id="ticketForm" ...>...</form>` block in a container that starts hidden:

```html
<div id="checkoutFormWrap" class="hidden">
  <!-- existing <form id="ticketForm">...</form> goes here, unchanged -->
</div>
```

- [ ] **Step 3: Add the auth wiring to the script block**

At the top of the `<script>` block (line 226), before `const eventCards = ...`, add:

```javascript
const authGate = document.querySelector('#authGate');
const authStatus = document.querySelector('#authStatus');
const googleLoginButton = document.querySelector('#googleLoginButton');
const checkoutFormWrap = document.querySelector('#checkoutFormWrap');

let supabaseClient = null;
let currentSession = null;

async function initAuth() {
  try {
    const response = await fetch('/api/config');
    const config = await response.json();
    if (!config.supabaseUrl || !config.supabaseAnonKey) {
      authStatus.textContent = 'La compra no está disponible todavía.';
      googleLoginButton.classList.add('hidden');
      return;
    }

    supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);

    const { data: { session } } = await supabaseClient.auth.getSession();
    handleSession(session);

    supabaseClient.auth.onAuthStateChange((_event, session) => {
      handleSession(session);
    });

    googleLoginButton.addEventListener('click', async () => {
      await supabaseClient.auth.signInWithOAuth({ provider: 'google' });
    });
  } catch (error) {
    console.error('No se pudo inicializar el login:', error);
  }
}

function handleSession(session) {
  currentSession = session;
  if (session) {
    authStatus.textContent = `Sesión iniciada como ${session.user.email}.`;
    googleLoginButton.classList.add('hidden');
    checkoutFormWrap.classList.remove('hidden');
  } else {
    authStatus.textContent = 'Inicia sesión con Google para comprar tu entrada.';
    googleLoginButton.classList.remove('hidden');
    checkoutFormWrap.classList.add('hidden');
  }
}
```

- [ ] **Step 4: Attach the Bearer token to the purchase request**

In the `form.addEventListener('submit', ...)` handler, in the `fetch('/api/crear-ticket', ...)` call (line 388), change the `headers` to include the token:

```javascript
const response = await fetch('/api/crear-ticket', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${currentSession?.access_token || ''}`
  },
  body: JSON.stringify(payload)
});
```

Also add a guard at the top of the submit handler (right after `event.preventDefault();`):

```javascript
if (!currentSession) {
  showResult('Inicia sesión con Google antes de comprar.', false);
  return;
}
```

- [ ] **Step 5: Call `initAuth()` on load**

At the bottom of the script, next to the existing `cargarEventos(); cargarEstadisticas();` calls (line 412-413), add:

```javascript
initAuth();
```

- [ ] **Step 6: Manual check**

Run: `npm start`, open `http://localhost:3000`
Expected: the checkout form is hidden and replaced by "Inicia sesión con Google para comprar tu entrada." (the button won't complete a real login yet — that needs the live Supabase project and Google provider setup from Task 11's `DEPLOYMENT.md` steps — but the page must load with no console errors and `/api/config` must respond `{ supabaseUrl: null, supabaseAnonKey: null }` today).

- [ ] **Step 7: Commit**

```bash
git add public/index.html
git commit -m "feat: add Google login gate to the purchase flow"
```

---

### Task 9: `public/login.html` — Supabase Auth for staff

**Files:**
- Modify: `public/login.html:7` (script tag), `public/login.html:39-96` (script block)

**Interfaces:**
- Consumes: `GET /api/config` (Task 7); `supabaseClient.auth.signInWithPassword`.

- [ ] **Step 1: Add the supabase-js script tag**

After line 7 (`<link rel="stylesheet" href="/theme.css" />`):

```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
```

- [ ] **Step 2: Replace the login logic**

Replace the whole `<script>` block (lines 39-96) with:

```javascript
const loginForm = document.querySelector('#loginForm');
const statusMessage = document.querySelector('#statusMessage');
const submitButton = loginForm.querySelector('button');

let supabaseClient = null;

function showStatus(message, isError = true) {
  statusMessage.textContent = message;
  statusMessage.className = `mt-5 rounded-2xl p-3 text-sm ${isError ? 'border border-red-500/30 bg-red-500/10 text-red-100' : 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-100'}`;
  statusMessage.classList.remove('hidden');
}

async function initSupabase() {
  const response = await fetch('/api/config');
  const config = await response.json();
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    showStatus('El login no está disponible todavía.', true);
    submitButton.disabled = true;
    return;
  }
  supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);

  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session) {
    window.location.href = '/scanner-dashboard';
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!supabaseClient) return;

  submitButton.disabled = true;
  submitButton.textContent = 'Validando...';

  try {
    const { error } = await supabaseClient.auth.signInWithPassword({
      email: document.querySelector('#username').value.trim(),
      password: document.querySelector('#password').value
    });

    if (error) {
      showStatus('Credenciales incorrectas.', true);
      return;
    }

    showStatus('Acceso correcto. Redirigiendo...', false);
    window.setTimeout(() => {
      window.location.href = '/scanner-dashboard';
    }, 500);
  } catch (error) {
    showStatus('No se pudo iniciar sesión. Inténtalo de nuevo.', true);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = 'Entrar al panel';
  }
});

initSupabase();
```

- [ ] **Step 3: Manual check**

Run: `npm start`, open `http://localhost:3000/login`
Expected: page loads, shows "El login no está disponible todavía." (Supabase not configured yet in local dev) instead of erroring. No console exceptions.

- [ ] **Step 4: Commit**

```bash
git add public/login.html
git commit -m "feat: wire staff login to Supabase Auth email/password sign-in"
```

---

### Task 10: `public/scanner-dashboard.html` — Bearer-token session

**Files:**
- Modify: `public/scanner-dashboard.html:9` (script tag), `public/scanner-dashboard.html:110-443` (script block)

**Interfaces:**
- Consumes: `GET /api/config`, `GET /api/session-status`, and every `/api/admin/...` + `/api/validar-ticket` route (Task 7) — all now require `Authorization: Bearer <token>`.

- [ ] **Step 1: Add the supabase-js script tag**

After line 9 (the `html5-qrcode` script tag):

```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
```

- [ ] **Step 2: Add a shared authenticated-fetch helper and Supabase init**

At the top of the `<script>` block (line 110), before `const resultPanel = ...`, add:

```javascript
let supabaseClient = null;
let currentSession = null;

async function initSupabase() {
  const response = await fetch('/api/config');
  const config = await response.json();
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    window.location.href = '/login';
    return false;
  }
  supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
  const { data: { session } } = await supabaseClient.auth.getSession();
  currentSession = session;
  return true;
}

function authHeaders() {
  return currentSession ? { Authorization: `Bearer ${currentSession.access_token}` } : {};
}

async function authFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), ...authHeaders() }
  });
}
```

- [ ] **Step 3: Replace `checkSession()`**

Replace the existing `checkSession()` function (lines 156-184) with:

```javascript
async function checkSession() {
  if (!currentSession) {
    window.location.href = '/login';
    return;
  }

  try {
    const response = await authFetch('/api/session-status');
    const data = await response.json();

    if (!data.authenticated) {
      window.location.href = '/login';
      return;
    }

    userLabel.textContent = `${data.user.name} · ${data.user.role}`;
    userLabel.classList.remove('hidden');
    roleState.textContent = data.user.role;

    if (data.user.role === 'admin' || data.user.role === 'staff') {
      adminGenerator.classList.remove('hidden');
    }
    if (data.user.role !== 'admin') {
      document.querySelector('#paymentApproval').classList.add('hidden');
    }
    if (data.user.role === 'admin') {
      loadPendingPayments();
      loadGeneratedTickets();
    }
  } catch (error) {
    console.error('Error verificando sesión:', error);
    window.location.href = '/login';
  }
}
```

- [ ] **Step 4: Switch every other `fetch(` call to `authFetch(`**

Replace `fetch(` with `authFetch(` in these five spots (leave everything else in each call identical):
- `loadPendingPayments()` — `fetch('/api/admin/pagos-pendientes')` (line 218)
- `loadGeneratedTickets()` — `fetch('/api/admin/entradas')` (line 262)
- `confirmPayment()` — `fetch(\`/api/admin/confirmar-pago/...\`, ...)` (line 273)
- `validateTicket()` — `fetch('/api/validar-ticket', ...)` (line 288)
- `adminQrForm` submit handler — `fetch('/api/admin/crear-qr', ...)` (line 367)
- `paymentApprovalForm` submit handler — `fetch(\`/api/admin/confirmar-pago/...\`, ...)` (line 409)

(`loadAdminEvents()`'s `fetch('/api/eventos')` at line 139 stays as plain `fetch` — that route is public.)

- [ ] **Step 5: Replace `logout()`**

Replace the `logout()` function (lines 425-433) with:

```javascript
async function logout() {
  try {
    if (supabaseClient) await supabaseClient.auth.signOut();
  } finally {
    window.location.href = '/login';
  }
}
```

- [ ] **Step 6: Update the bottom bootstrap calls**

Replace the final three lines (`checkSession(); loadAdminEvents(); startScanner();`, line 441-443) with:

```javascript
(async () => {
  const ready = await initSupabase();
  if (!ready) return;
  checkSession();
  loadAdminEvents();
  startScanner();
})();
```

- [ ] **Step 7: Manual check**

Run: `npm start`, open `http://localhost:3000/scanner-dashboard`
Expected: redirects to `/login` immediately (Supabase not configured locally yet), no console exceptions.

- [ ] **Step 8: Commit**

```bash
git add public/scanner-dashboard.html
git commit -m "feat: wire scanner dashboard to Supabase-backed sessions"
```

---

### Task 11: `DEPLOYMENT.md` — Supabase deployment steps

**Files:**
- Modify: `DEPLOYMENT.md:13-19` (section "## 2. Firestore y respaldos")

**Interfaces:** none (docs only).

- [ ] **Step 1: Replace section 2**

Replace:

```
## 2. Firestore y respaldos

1. Crea un proyecto Firebase y una cuenta de servicio.
2. Configura `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL` y `FIREBASE_PRIVATE_KEY`.
3. Crea la colección `tickets` y restringe el acceso público. El servidor usa Firebase Admin.
4. Programa exportaciones y verifica la restauración antes del primer evento.
5. En producción la app se detiene si Firestore no está configurado; no se permite el almacenamiento en memoria.
```

With:

```
## 2. Supabase (base de datos, autenticación y respaldos)

1. Crea un proyecto en https://supabase.com/dashboard/projects, nombre `whineup-evento`.
2. Copia el contenido de `supabase/schema.sql` y pégalo en el SQL Editor del proyecto; ejecútalo una sola vez.
3. Configura `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (Settings → API → Project API keys → `service_role`, secreta) y `SUPABASE_ANON_KEY` (la clave `anon`/`public`, esa sí puede quedar visible en el navegador).
4. En Authentication → Providers, activa **Google** y sigue el asistente de Supabase para configurar el cliente OAuth de Google Cloud. En Authentication → URL Configuration, agrega la URL real del sitio en "Site URL" y "Redirect URLs".
5. Crea las cuentas de staff/admin manualmente en Authentication → Users → "Add user" (correo + contraseña). Después, en el SQL Editor, actualiza su rol: `update public.perfiles set rol = 'admin' where id = '<uuid del usuario>';` (o `'staff'`).
6. Programa respaldos automáticos en Settings → Database → Backups y verifica una restauración antes del primer evento.
7. En producción, si `SUPABASE_URL` o `SUPABASE_SERVICE_ROLE_KEY` faltan, las rutas que dependen de la base responden error en vez de guardar nada en memoria — no hay modo de respaldo silencioso.
```

- [ ] **Step 2: Commit**

```bash
git add DEPLOYMENT.md
git commit -m "docs: update deployment checklist for Supabase"
```

---

## Self-Review Notes

- **Spec coverage:** every section of the spec (arquitectura, modelo de datos, SQL, cambios en server.js, cambios en frontend, manejo de errores) maps to a task above. The spec's "plan de pruebas" (manual, needs a live project) is referenced from Task 7/8/9/10's manual-check steps rather than duplicated.
- **Placeholder scan:** no TBD/TODO; every step has real code or an exact command.
- **Type/name consistency:** `mapEntradaRow`/`mapEventoRow` field names are defined once in Task 5/6 and reused verbatim in Task 7's routes and Tasks 8/10's frontend reads (`ticket.evento`, `ticket.tipoEntrada`, etc., unchanged from the current frontend). `requireRole` is defined in Task 4 and used with matching call signatures throughout Task 7.
