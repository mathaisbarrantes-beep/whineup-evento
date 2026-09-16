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

test('mapEntradaRow maps snake_case columns and the joined event name to the existing frontend shape', () => {
  const row = {
    id: 't1', evento_id: 'e1', usuario_id: 'u1', nombre: 'Ana', correo: 'ana@x.com',
    telefono: '8888-0000', tipo_entrada: 'General', precio: 45000, metodo_pago: 'sinpe',
    referencia_pago: 'REF123', pagado: true, estado: 'PENDIENTE', pago_confirmado_por: 'staff1',
    pago_confirmado_en: '2026-01-01T00:00:00Z', ingresado_en: null, generado_por: null,
    creado_en: '2026-01-01T00:00:00Z', cortesia: null, cortesia_entregada_en: null,
    eventos: { nombre: 'HALLOWEEN PARTY', fecha: '2026-10-31T21:00:00Z', lugar: 'WhineUp CR', cortesia: '1 shot gratis' }
  };
  assert.deepEqual(mapEntradaRow(row), {
    id: 't1', eventoId: 'e1', evento: 'HALLOWEEN PARTY',
    eventoFecha: '2026-10-31T21:00:00Z', eventoLugar: 'WhineUp CR', usuarioId: 'u1', nombre: 'Ana',
    correo: 'ana@x.com', telefono: '8888-0000', tipoEntrada: 'General', precio: 45000,
    metodoPago: 'sinpe', referenciaPago: 'REF123', pagado: true, estado: 'PENDIENTE',
    pagoConfirmadoPor: 'staff1', pagoConfirmadoEn: '2026-01-01T00:00:00Z', ingresadoEn: null,
    generadoPor: null, creadoEn: '2026-01-01T00:00:00Z',
    cortesia: null, cortesiaEntregadaEn: null, eventoCortesia: '1 shot gratis'
  });
});
