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
