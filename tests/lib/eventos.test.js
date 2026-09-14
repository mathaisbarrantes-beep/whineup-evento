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
