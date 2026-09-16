// tests/lib/entradas.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEntradasRepo, mapEntradaRow, isUuid } = require('../../lib/entradas');

// Si el repo llega a consultar Supabase, este doble revienta la prueba: así
// comprobamos que el corto circuito ocurre ANTES de cualquier consulta.
const supabaseProhibido = {
  from() { throw new Error('supabase no debe consultarse con un id inválido'); },
  rpc() { throw new Error('supabase no debe consultarse con un id inválido'); }
};

const UUID_VALIDO = '3f7c1b2e-9a4d-4f01-8b7e-2c5d6a8f1e40';

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

test('isUuid accepts a canonical uuid and rejects anything else', () => {
  assert.equal(isUuid(UUID_VALIDO), true);
  assert.equal(isUuid(UUID_VALIDO.toUpperCase()), true);
  assert.equal(isUuid('https://wa.me/50600000000'), false);
  assert.equal(isUuid('t1'), false);
  assert.equal(isUuid(''), false);
  assert.equal(isUuid(null), false);
  assert.equal(isUuid(undefined), false);
  assert.equal(isUuid(`${UUID_VALIDO} `), false);
  assert.equal(isUuid('3f7c1b2e9a4d4f018b7e2c5d6a8f1e40'), false);
});

test('obtenerPorId resolves null for a non-uuid id without querying Supabase', async () => {
  const repo = createEntradasRepo({ supabase: supabaseProhibido, supabaseConfigured: true });
  assert.equal(await repo.obtenerPorId('https://instagram.com/whineupcr'), null);
});

test('confirmarPago resolves null for a non-uuid id without querying Supabase', async () => {
  const repo = createEntradasRepo({ supabase: supabaseProhibido, supabaseConfigured: true });
  assert.equal(await repo.confirmarPago('no-es-un-uuid', 'staff1'), null);
});

test('validar resolves the not-found shape for a non-uuid id without querying Supabase', async () => {
  const repo = createEntradasRepo({ supabase: supabaseProhibido, supabaseConfigured: true });
  assert.deepEqual(await repo.validar('WIFI:S=WhineUp;T=WPA;P=fiesta;;'), {
    permitido: false,
    mensaje: 'Ticket no encontrado.',
    nombre: null,
    evento: null,
    tipoEntrada: null
  });
});

test('validar still reaches Supabase for a well-formed uuid', async () => {
  let recibido = null;
  const supabase = {
    rpc(fn, args) {
      recibido = { fn, args };
      return Promise.resolve({ data: [{ permitido: true, mensaje: 'Acceso permitido.', nombre: 'Ana', evento: 'HALLOWEEN PARTY', tipo_entrada: 'VIP' }], error: null });
    }
  };
  const repo = createEntradasRepo({ supabase, supabaseConfigured: true });
  const resultado = await repo.validar(UUID_VALIDO);
  assert.deepEqual(recibido, { fn: 'validar_entrada', args: { p_entrada_id: UUID_VALIDO } });
  assert.equal(resultado.permitido, true);
  assert.equal(resultado.tipoEntrada, 'VIP');
});

test('mapEntradaRow maps snake_case columns and the joined event name to the existing frontend shape', () => {
  const row = {
    id: 't1', evento_id: 'e1', usuario_id: 'u1', nombre: 'Ana', correo: 'ana@x.com',
    telefono: '8888-0000', tipo_entrada: 'General', precio: 45000, metodo_pago: 'sinpe',
    referencia_pago: 'REF123', pagado: true, estado: 'PENDIENTE', pago_confirmado_por: 'staff1',
    pago_confirmado_en: '2026-01-01T00:00:00Z', ingresado_en: null, generado_por: null,
    creado_en: '2026-01-01T00:00:00Z', eventos: { nombre: 'HALLOWEEN PARTY' }
  };
  assert.deepEqual(mapEntradaRow(row), {
    id: 't1', eventoId: 'e1', evento: 'HALLOWEEN PARTY', usuarioId: 'u1', nombre: 'Ana',
    correo: 'ana@x.com', telefono: '8888-0000', tipoEntrada: 'General', precio: 45000,
    metodoPago: 'sinpe', referenciaPago: 'REF123', pagado: true, estado: 'PENDIENTE',
    pagoConfirmadoPor: 'staff1', pagoConfirmadoEn: '2026-01-01T00:00:00Z', ingresadoEn: null,
    generadoPor: null, creadoEn: '2026-01-01T00:00:00Z'
  });
});
