// tests/server.test.js

// server.js calls require("dotenv").config() when it loads. dotenv does not
// override variables that are already set, but these tests delete them first,
// so a real .env in the repo root would silently refill them and this suite
// would end up testing a half-configured app against a live project instead of
// the unconfigured boot path. Neutralising config() on the cached dotenv module
// is enough: server.js gets the same module object we patch here.
// (Pointing dotenv at a nonexistent path does NOT work — .config() re-reads the
// default .env on every call.)
require('dotenv').config = () => ({ parsed: {} });

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

// No SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY set in this process's env,
// so the app under test boots in the unconfigured state.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
const app = require('../server');

test('the app under test really booted unconfigured', () => {
  assert.equal(process.env.SUPABASE_URL, undefined);
  assert.equal(process.env.SUPABASE_SERVICE_ROLE_KEY, undefined);
});

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

// La imagen del QR la carga un cliente de correo, que no manda cabeceras de
// sesion ni sabe de Supabase: tiene que responder aunque la base no este
// configurada, y tiene que negarse a dibujar cualquier texto que no sea un id.
test('GET /api/ticket/:id/qr.png returns a PNG for a uuid, even unconfigured', async () => {
  const res = await request(app).get('/api/ticket/3f2504e0-4f89-41d3-9a0c-0305e82c3301/qr.png');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.ok(res.body.length > 100, 'el PNG llega vacio');
  assert.equal(res.body.subarray(1, 4).toString('latin1'), 'PNG');
});

test('GET /api/ticket/:id/qr.png rejects a non-uuid instead of drawing it', async () => {
  const res = await request(app).get('/api/ticket/no-soy-un-uuid/qr.png');
  assert.equal(res.status, 404);
});

// El numero del SINPE se lee por peticion, no al arrancar, para poder cambiarlo
// en el panel de Vercel sin volver a desplegar.
test('GET /api/config exposes paymentPhone as null when it is not set', async () => {
  delete process.env.PAYMENT_PHONE;
  const res = await request(app).get('/api/config');
  assert.equal(res.status, 200);
  assert.equal(res.body.paymentPhone, null);
});

test('GET /api/config returns the SINPE number when it is set', async () => {
  process.env.PAYMENT_PHONE = '+506 8888-1234';
  try {
    const res = await request(app).get('/api/config');
    assert.equal(res.body.paymentPhone, '+506 8888-1234');
  } finally {
    delete process.env.PAYMENT_PHONE;
  }
});

// El personal y los eventos son lo único que un staff no puede tocar. Estas
// rutas tienen que negarse antes de llegar a Supabase.
test('GET /api/admin/usuarios returns 401 without a token', async () => {
  const res = await request(app).get('/api/admin/usuarios');
  assert.equal(res.status, 401);
});

test('PUT /api/admin/usuarios/:id/rol returns 401 without a token', async () => {
  const res = await request(app).put('/api/admin/usuarios/abc/rol').send({ rol: 'staff' });
  assert.equal(res.status, 401);
});

test('GET /api/admin/usuarios returns 503 with a token when unconfigured', async () => {
  const res = await request(app).get('/api/admin/usuarios').set('Authorization', 'Bearer fake');
  assert.equal(res.status, 503);
});

test('GET /api/admin/pagos-pendientes returns 401 without a token', async () => {
  const res = await request(app).get('/api/admin/pagos-pendientes');
  assert.equal(res.status, 401);
});

test('GET /api/admin/eventos returns 401 without a token', async () => {
  const res = await request(app).get('/api/admin/eventos');
  assert.equal(res.status, 401);
});
