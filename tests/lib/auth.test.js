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
