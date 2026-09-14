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
